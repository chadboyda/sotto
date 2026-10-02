// `claude plugin test` suite for the mod's phases 4-6 (SPEC §6.21): /talk from
// the mod, the voice tools, agent ancestry, approvals and the terminal UI.
import { expect, mock, test } from 'claude-code/testing'

const SOCK = '/tmp/clv-test.sock'
const STATE = { state: 'live', persona: 'moss', voice: 'cedar', busy: false, activity: '', said: 'All forty-two tests pass, nothing is broken.', approval: null }

type Daemon = { polls: number, events: any[], controls: any[], state: any }

function stubs(on: any, clock: any, d: Daemon) {
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u' })
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.list', () => ({ value: [{ name: 'sotto-skills-dir', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', ($: any, e: any) => {
    if (String(e.path).endsWith('/active')) return { value: `${SOCK}\t47999\tKEY\tabc123\n` }
    if (String(e.path).endsWith('/scripts/voice-context.txt')) return { value: 'ctx @MARKER@\n' }
    return { deny: 'ENOENT' }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }, { role: 'assistant', text: 'hello', toolUses: [] }] }))
  on('store.set', () => ({ value: undefined }))
  on('tool.register', ($: any, e: any) => ({ value: { tool: `mcp__sotto__${e.name}` } }))
  on('http.fetch', async ($: any, e: any) => {
    const url = String(e.url)
    const init = e.init ?? e
    if (url.endsWith('/mod/hello')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, after: 0, nonce: 'abc123', data_dir: '/home/u/.claude/plugins/data/sotto-skills-dir' }) } }
    if (url.includes('/mod/poll')) {
      d.polls++
      if (d.polls === 1) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [], seq: 0, sv: 1, state: d.state }) } }
      await clock.sleep(600000)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [], seq: 0, sv: 1 }) } }
    }
    if (url.endsWith('/mod/events')) {
      const b = JSON.parse(init.body)
      d.events.push(...b.events)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, acked: b.events.at(-1)?.seq ?? 0 }) } }
    }
    if (url.endsWith('/control')) {
      d.controls.push(JSON.parse(init.body))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, state: 'live', message: 'sotto: voice ON (work) | link mod' }) } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: '{}' } }
  })
}

async function settle(clock: any) {
  for (let i = 0; i < 20; i++) await clock.advance(50)
}

const BAND = { plugin: 'sotto', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 28, scroll: { offset: 0, bodyRows: 10 }, view: {} } } as any

test('/talk from the mod: toggle.sh with the remembered data dir and the userConfig values, no model turn', async ($, on) => {
  mock.clock(on)
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u' })
  on('store.get', () => ({ value: '/home/u/.claude/plugins/data/sotto-skills-dir' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  const runs: any[] = []
  on('process.run', ($: any, e: any) => { runs.push(e); return { value: { exitCode: 0, stdout: '{"continue":false,"stopReason":"sotto: voice ON (work)."}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  const r = await $.command.run({ command: 'sotto:talk', args: 'on' } as any)
  expect((r as any).text).toBe('voice ON (work).')
  expect(runs.length).toBe(1)
  expect(runs[0].argv[1]).toMatch(/scripts\/toggle\.sh$/)
  expect(runs[0].init.env.CLAUDE_PLUGIN_DATA).toBe('/home/u/.claude/plugins/data/sotto-skills-dir')
  expect(JSON.parse(runs[0].init.stdin)).toMatchObject({ session_id: 'sess-1', command_args: 'on', transcript_path: '/home/u/.claude/projects/-work/sess-1.jsonl' })
})

test('/talk before the mod ever linked: the classic expansion handles it', async ($, on) => {
  mock.clock(on)
  mock.env(on, { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, HOME: '/home/u' })
  on('store.get', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  let classic = 0
  on('command.run', () => { classic++; return { text: 'classic ran' } })
  const r = await $.command.run({ command: 'sotto:talk', args: 'status' } as any)
  expect(classic).toBe(1)
  expect((r as any).text).toBe('classic ran')
})

test('once linked: voice tools are registered, allowed without a prompt, and answered through /control', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], controls: [], state: STATE }
  stubs(on, clock, d)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  const check = await $.tool.check({ tool: 'mcp__sotto__voice', input: { name: 'cedar' } } as any)
  expect((check as any).decision).toBe('allow')
  const r = await $.tool.call({ tool: 'mcp__sotto__voice', tool_use_id: 'tu1', name: 'Cedar' } as any)
  expect(JSON.stringify(r)).toContain('link mod')
  expect(d.controls[0]).toMatchObject({ action: 'voice', voice: 'cedar', via: 'cli', confirm: true, session: { socket: SOCK } })
  expect(d.events.some((e) => e.kind === 'context' && e.messages.length === 2)).toBe(true)
})

test('the band shows the phase and the last words, fitted to the width, and yields to a survey', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], controls: [], state: STATE }
  stubs(on, clock, d)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'sotto | listening' })).toBeDefined()
  const said = await band.find({ type: 'Text', text: /All forty-two/ })
  expect(said).toBeDefined()
  expect([...String((said as any).children)].length <= 28).toBe(true)
  await band.unmount()
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await survey.unmount()
})

test('approvals: an ask is reported by tool_use_id, noted under the dialog, and closed when the call ends', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], controls: [], state: STATE }
  stubs(on, clock, d)
  on('tool.check', () => ({ decision: 'ask', reason: 'needs approval' }))
  const notices: any[] = []
  on('ui.notice', ($: any, e: any) => { notices.push(e); return { value: undefined } })
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  const v = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu7' } as any)
  expect((v as any).decision).toBe('ask')
  await settle(clock)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu7', command: 'rm -rf build' } as any)
  await settle(clock)
  expect(d.events.find((e) => e.kind === 'approval' && e.phase === 'ask')).toMatchObject({ tool_use_id: 'tu7', tool: 'Bash' })
  expect(d.events.find((e) => e.kind === 'approval' && e.phase === 'resolved')).toMatchObject({ tool_use_id: 'tu7', outcome: 'done' })
  expect(JSON.stringify(notices)).toContain('answer it here')
})

test('agent ancestry: each spawn reports who started it', async ($, on) => {
  const clock = mock.clock(on)
  const d: Daemon = { polls: 0, events: [], controls: [], state: STATE }
  stubs(on, clock, d)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a-2' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  await settle(clock)
  await $.agent.spawn({ tool_use_id: 'tu5', prompt: 'p', description: 'nested work', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', parentAgentId: 'a-1', background: false, fork: false } as any)
  await settle(clock)
  expect(d.events.find((e) => e.kind === 'agent')).toMatchObject({ agent_id: 'a-2', parent_agent_id: 'a-1', description: 'nested work' })
})
