# Direction C: Ambient companion

The window works like a mood light with one word in it. You should be able to read it from across the desk without focusing on it:

- **Field.** The whole background takes on a soft wash of the current state's color: a radial tint, 16% strength in dark mode and 10% in light.
- **Shape.** The orb is the mute button, and its shape changes with each floor state, so color is never the only signal.
- **Word.** One 34px word says the state in plain language.

Everything else stays small, quiet and at 13 to 15px. The one exception is Claude needing approval, the only moment the window asks you to act, and that state is loud.

Files:

- `tokens.css` holds the tokens. It is plain custom properties with a dark default, follows the system theme, and can be forced with `data-theme`.
- `mockup.html` shows all the frames. It is self-contained, with the tokens inlined.
- `overview.png` shows all the frames. `hero.png` shows the listening state at 420x640, 2x.

## Floor states: shape, motion and word

| State | Orb shape | Motion (driven by the real signal) | Word | Color |
|---|---|---|---|---|
| Connecting / reconnecting | Dotted neutral ring | none | Connecting / Reconnecting | neutral |
| Listening | Thin solid ring (3px) | none; still while idle | Listening | `--live` |
| You speaking | Filled disk plus a level halo | halo scale follows the mic RMS (about 90ms smoothing, transform only) | Hearing you | `--live` |
| Sotto speaking | Ring with a sunburst of radial bars | bar lengths come from an `AnalyserNode` on an **un-played clone** of the remote stream; the `<audio>` element stays the AEC reference | Sotto, with "is speaking" underneath | `--voice` |
| Muted | Dashed ring and slashed mic | none | Muted, plus "still billing" in the header | `--muted` |
| Paused | The orb becomes a play button | none | "Paused…" headline (SPEC string) | neutral |

With reduced motion on, the halo and bars do not animate. Each state shows a fixed shape instead: a halo at level 0.5, or bars at their median length. The shapes stay different, so no information is lost.

## Color: one meaning per hue, the same in both themes

| Token | Meaning | Dark | Light | Contrast (bg) dark / light |
|---|---|---|---|---|
| `--live` | heard / listening / you | #2fd3c4 | #0a7169 | 10.2 / 5.2 |
| `--voice` | Sotto speaking | #a99bff | #5b45d6 | 8.0 / 6.1 |
| `--work` | Claude Code working or finished | #6cb2ff | #1b61c9 | 8.6 / 5.5 |
| `--attn` | approval, permission, notices | #f5b83d | #8f5a00 | 10.7 / 5.5 |
| `--err` | errors, End voice | #ff7a7a | #c42b33 | 7.6 / 5.3 |
| `--muted` | mic muted | #f28bc0 | #b0246e | 8.4 / 6.0 |

The neutrals are cool slate with no warm cast. The light background is #f7f9fb and replaces the audited beige #f5f4f1.

| Token | Contrast dark / light |
|---|---|
| Text | 16.8 / 17.5 |
| `--text-2` | 9.9 / 7.5 |
| `--text-3` (the faintest text allowed) | 6.5 / 5.5 |
| `--edge` (every control boundary, including the orb) | 4.1 / 3.7, and at least 3.3 on raised surfaces |

`--hairline` is only for decorative dividers and must never be a control's only edge.

## Type, space and size

- **Type:** system-ui and ui-monospace only.
  - Scale: 34 (state word), 20 (titles), 17 (latest caption), 15 (body), 13 (meta), 12 (speaker labels).
  - Only the state word uses a display size.
- **Spacing:** a 4/8 grid (4, 8, 12, 16, 20, 24, 32, 40, 48). 8px between controls, 16px or more between groups, and a 16px gutter.
- **Targets:**
  - Every control is at least 44px. Bottom-bar buttons are 48px.
  - The orb is 136px, or 88px in the collapsed size (the minimum is 64px).
  - The segmented policy control uses 44px segments.
- **Radii:** 8, 12, 16 and 24 (drawer).
- **Motion:** 150ms for hover and press, 200ms for state crossfades, 250ms for the drawer, and a 90ms follow on the audio level. Easing is `cubic-bezier(.2,.8,.2,1)`. Nothing loops while idle. The working spinner is the only loop, and it runs only while Claude is actually working.

## Layout (top to bottom)

1. Header, 44px: status shape and word, project, then session clock and "$ today" on the right. When muted, it says "Muted · still billing".
2. Stage, flexible: orb, state word, and a shortcut hint ("M or Space to mute"), which is visible at the default size.
3. Claude card:
   - idle: one quiet line
   - working: current step, request, time and progress
   - approval: amber, full command, "in the terminal"
   - finished: 3-line clamp with "More"
4. Captions: the previous line at 13px in `--text-2`, and the latest line at 17px in `--text`. Your lines and Sotto's lines use the same style, told apart by a shape label (dot for you, bars for Sotto).
5. Bottom bar, 64px: Pause on the left, the settings gear, and End voice pushed to the far right as an outlined button in `--err`.

Settings (speaking policy, mic, speaker, Bluetooth hint) live in a bottom drawer. Esc closes it, and focus returns to the gear.

**Collapse order** as the window shrinks, never scrolling:

1. Settings (already in the drawer)
2. Caption history (keep the last line)
3. The request line on the Claude card
4. The summary drops to one line, and End voice becomes an icon

At 480px tall or less, the orb switches to 88px and the word to 28px. The orb, the word, mute and Pause always stay.

## Do

- Change the shape and the word for every floor change. Color supports them and is never the only signal.
- Keep the `aria-label` fixed as "Mute" and let `aria-pressed` carry the state.
- Announce floor changes, Claude's steps and approvals. Do not announce caption deltas.
- Put the approval state in the header word and in `document.title` ("Approval needed · Sotto").
- Show one banner at a time, in plain words, with at most one action.
- Hide Pause and mute in pre-live states (Allow microphone and the errors) so the wrong action is not on offer.
- Point at Chrome's permission bubble from the top-left, where it actually appears in an `--app` window.

## Don't

- Don't use warm greys or beige, or tint the neutrals.
- Don't put colored text on a tint above 16% in dark or 10% in light (the limits that keep AA).
- Don't use motion that runs without a signal: no idle pulsing and no breathing orb.
- Don't put End voice next to Pause, or give them the same styling.
- Don't cut the summary or the approval command mid-line with an ellipsis.
- Don't use web fonts, a CDN or icon fonts. Icons are inline SVG with `currentColor`.

## SPEC strings

These strings are kept verbatim:

- "Waiting for your approval in the terminal"
- "Paused after N minutes of silence"
- "Resume to keep talking with Claude Code."
- "Claude finished while you were away"
- "Claude is idle"
- "Claude is working"
- "Click anywhere in this window to turn on the voice audio."
- "Voice moved to another window" / "Use this window"
- the paused and daily-cap titles

These strings are new or changed and must go into `docs/SPEC-DEVIATIONS.md` when implemented:

- "Allow microphone access"
- "Chrome is asking here"
- "I don't see a prompt"
- "Hearing you"
- "Sotto / is speaking"
- "still billing"
- "Your mute setting is kept."
- "Claude needs your approval"
- "Claude finished"
- the per-cause mic copy ("macOS is blocking the microphone" and its steps)
- the header labels "Approval needed", "Mic blocked" and "Reconnecting"
