// `claude plugin test` suite for hooks/sotto-mod.mjs (SPEC §6.21): the mod
// against stubs of everything Claude Code and the daemon would answer, no
// session, no network. npm run test:mod
import { expect, mock, test } from 'claude-code/testing'

const SOCK = '/tmp/clv-test.sock'
const CONTEXT = 'The message that starts with @MARKER@ is the user.'

type Daemon = { polls: number, events: any[], hello: any[], items: any[] }

// Stubs for a session that owns voice (D/active names its socket) and a
// daemon that answers hello, hands out `items` on the first poll and then
// holds every later poll, and acks every event batch.
function stubs(on: any, clock: any, d: Daemon, opts: { owner?: string } = {}) {
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u' })
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [{ name: 'sotto-skills-dir', kind: 'directory', size: 0, mtimeMs: 0, isLink: false }, { name: 'other', kind: 'directory', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', ($: any, e: any) => {
    if (String(e.path).endsWith('/sotto-skills-dir/active')) return { value: `${opts.owner ?? SOCK}\t47999\tKEY\tabc123\n` }
    if (String(e.path).endsWith('/scripts/voice-context.txt')) return { value: CONTEXT + '\n' }
    return { deny: 'ENOENT' }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }))
  on('http.fetch', async ($: any, e: any) => {
    const url = String(e.url)
    const init = e.init ?? e
    if (url.endsWith('/mod/hello')) { d.hello.push(JSON.parse(init.body)); return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, after: 0, nonce: 'abc123' }) } } }
    if (url.includes('/mod/poll')) {
      d.polls++
      if (d.polls === 1) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: d.items, seq: d.items.length }) } }
      await clock.sleep(600000)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [], seq: d.items.length }) } }
    }
    if (url.endsWith('/mod/events')) {
      const b = JSON.parse(init.body)
      d.events.push(...b.events)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, acked: b.events.at(-1)?.seq ?? 0 }) } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: '{}' } }
  })
}

async function settle(clock: any) {
  for (let i = 0; i < 20; i++) await clock.advance(50)
}

test('inert while voice is off: no hello, no network', async ($, on) => {
  const clock = mock.clock(on)
  let fetches = 0
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u' })
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('http.fetch', () => { fetches++; return { value: { status: 500, ok: false, headers: {}, text: '' } } })
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await $.classic.UserPromptSubmit({ prompt: 'hi', prompt_id: 'p1', session_id: 's', hook_event_name: 'UserPromptSubmit' } as any)
  await settle(clock)
  expect(fetches).toBe(0)
})

test('another session owns voice: the mod stays classic', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], hello: [], items: [] }
  stubs(on, clock, d, { owner: '/tmp/someone-else.sock' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  expect(d.hello.length).toBe(0)
})

test('owner session: hello, then an idle voice message is submitted as the user and receipted', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], hello: [], items: [{ seq: 1, kind: 'inject', msg_id: 'clv-1-1', text: '[sotto voice abc123] list the files', priority: 'next' }] }
  stubs(on, clock, d)
  const submitted: any[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  expect(d.hello.length).toBe(1)
  expect(d.hello[0].socket).toBe(SOCK)
  expect(d.hello[0].cli).toBe('2.1.287')
  expect(submitted.length).toBe(1)
  expect(submitted[0].text).toBe('[sotto voice abc123] list the files')
  expect(d.events.some((e) => e.kind === 'receipt' && e.msg_id === 'clv-1-1' && e.how === 'submitted')).toBe(true)
})

test('a voice prompt gets the voice framing as hidden context; a typed one does not', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], hello: [], items: [] }
  stubs(on, clock, d)
  on('classic.UserPromptSubmit', () => ({}))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  const voice = await $.classic.UserPromptSubmit({ prompt: '[sotto voice abc123] hi', prompt_id: 'p1', session_id: 's', hook_event_name: 'UserPromptSubmit' } as any)
  expect((voice as any).additionalContext).toEqual(['The message that starts with [sotto voice abc123] is the user.'])
  const typed = await $.classic.UserPromptSubmit({ prompt: 'hi', prompt_id: 'p2', session_id: 's', hook_event_name: 'UserPromptSubmit' } as any)
  expect((typed as any).additionalContext).toBeUndefined()
  await settle(clock)
  expect(d.events.filter((e) => e.kind === 'classic' && e.event === 'UserPromptSubmit').length).toBe(2)
})

// (The mid-turn $.session.append path is covered by the real-session e2e,
// test/e2e/mod.mjs: the 2.1.287 kit has no stub route for session.append.)
test('while Claude works, a mirror waits for the end of the turn, then is submitted', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], hello: [], items: [] }
  stubs(on, clock, d)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const submitted: any[] = []
  on('prompt.submit', ($: any, e: any) => { submitted.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  await $.turn.start({ text: 'typed', turnId: 't1' } as any)
  // The next poll (the stub's first answer again) carries a mirror while the turn runs.
  d.items = [{ seq: 1, kind: 'inject', msg_id: 'clv-m-1', text: '[sotto voice abc123] (said to the voice assistant, not delegated) fine', priority: 'later' }]
  d.polls = 0
  await clock.advance(600001)
  await settle(clock)
  expect(submitted.length).toBe(0)
  expect(d.events.some((e) => e.kind === 'receipt' && e.msg_id === 'clv-m-1' && e.how === 'queued')).toBe(true)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5, isAborted: false, reason: 'answer', usage: null } as any)
  await settle(clock)
  expect(submitted.length).toBe(1)
  expect(d.events.some((e) => e.kind === 'turn' && e.phase === 'complete' && e.reason === 'answer')).toBe(true)
  expect(d.events.some((e) => e.kind === 'receipt' && e.msg_id === 'clv-m-1' && e.how === 'submitted')).toBe(true)
})

test('PreToolUse reaches the daemon in the stdin shape (tool_name, tool_input)', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], hello: [], items: [] }
  stubs(on, clock, d)
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  await $.classic.UserPromptSubmit({ prompt: 'go', prompt_id: 'p1', session_id: 's1', cwd: '/work', permission_mode: 'default', hook_event_name: 'UserPromptSubmit' } as any)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu1', command: 'ls' } as any)
  await settle(clock)
  const ev = d.events.find((e) => e.kind === 'classic' && e.event === 'PreToolUse')
  expect(ev.body).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1', session_id: 's1', prompt_id: 'p1', permission_mode: 'default' })
})

test('SOTTO_INTEGRATION=classic keeps the mod inert', async ($, on) => {
  const clock = mock.clock(on)
  let fetches = 0
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u', SOTTO_INTEGRATION: 'classic' })
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [{ name: 'sotto-skills-dir', kind: 'directory', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: `${SOCK}\t47999\tKEY\tabc123\n` }))
  on('http.fetch', () => { fetches++; return { value: { status: 200, ok: true, headers: {}, text: '{}' } } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  expect(fetches).toBe(0)
})
