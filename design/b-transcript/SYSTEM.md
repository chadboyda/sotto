# Direction B: Conversation-first

The conversation is the hero, set like well-typeset captions rather than chat bubbles. A compact header says what state the session is in. A docked bar at the bottom holds the **floor indicator**, which is also the 64px mute control. Claude Code's work appears **inline as a timeline**, in the order it happened, with the request, steps, current step and result together. An approval request pins above the dock and is never scrolled away. Settings live in a drawer.

Files:
- `tokens.css`: every color, type, spacing, radius, target and motion value
- `mockup.html`: 16 frames, self-contained. `?solo=<id>` renders a single frame.
- `overview.png`: all frames
- `hero.png`: listening at 420x640, 2x

## Layout (420x640)

| Zone | Height | Contents |
|---|---|---|
| Header | 56 | State glyph, state word and session clock. Second line: project, minutes and $ today, plus "Still billing" when muted. A 44px settings button. |
| Banner (optional) | 44+ | One at a time, in plain words, with at most one action |
| Transcript | flex | Captions and Claude Code blocks, anchored to the bottom. The top 64px fades out. It never scrolls the page. |
| Approval (optional) | auto | Pinned between the transcript and the dock |
| Dock | 96 | Floor pill (flex, 64px), then Pause (64x64), a divider, and End voice (76x64) |

Collapse order as height shrinks (the brief's order): settings are already in the drawer, then the caption history, then the timeline steps (a one-line `cc.one` strip with the current step and elapsed time), then the summary shrinks to one line. The header, the latest caption line and the dock never collapse. At 360x420 (frame 16) the End label becomes "End" and keeps `aria-label="End voice"`.

## The floor indicator

The main control is a single button whose accessible name is always **"Mute"**. `aria-pressed` carries the mute state. Each talking state has its own shape, motion and word, so color is never the only cue:

| State | Orb | Right side | Word | Pill edge |
|---|---|---|---|---|
| Listening | hollow ring, green | nothing moves | Listening | solid, neutral |
| You speaking | filled green, halo scales with mic level | bars rising from the baseline | You | green |
| Sotto speaking | ring, green (you can still cut in) | coral waveform mirrored around the center line | Sotto | coral, with a coral tint |
| Muted | hatched fill, slashed mic | none | Muted | dashed |
| Paused | filled green play icon | none | Resume (Space) | green |
| Waiting (mic / connecting) | dashed ring | none | Waiting for mic / Connecting… | dashed, disabled |

The halo and bars are driven by `--lvl`, which is 0 to 1 and set per animation frame from an `AnalyserNode`. Sotto's level comes from an analyser on a **clone of the remote stream that is not connected to the destination**, so the `<audio>` element stays the echo-cancellation reference. When the level is 0, nothing moves.

## Color: one meaning per hue, the same in both themes

| Token | Meaning | Dark | Light | vs bg (dark / light) |
|---|---|---|---|---|
| `--heard` | live, you are heard, your words, done | #4fd69c | #0b7a4d | 10.4 / 5.0 |
| `--voice` | Sotto speaking, its words | #ff9275 | #b8431f | 8.7 / 5.1 |
| `--work` | Claude Code working | #79a8ff | #1f5ccc | 8.0 / 5.7 |
| `--attn` | needs you: approval, allow mic | #f4bb4a | #8a5300 | 10.9 / 5.9 |
| `--error` | error | #ff7a7a | #c0262b | 7.6 / 5.5 |
| `--muted` | mic muted (with hatch and slash) | #d3d9e2 | #3a4250 | 13.4 / 9.4 |
| `--text` / `-2` / `-3` | copy tiers | | | 16.5 / 9.9 / 6.3, and 17.2 / 8.6 / 5.6 |
| `--edge-strong` | control boundaries | #677385 | #7d8797 | 4.0 / 3.4 (minimum 3:1) |
| `--mute-edge` | pill edge at rest | #7c8899 | #6b7584 | 5.3 / 4.4 |

All ratios were computed with the WCAG formula. Every text token is at least 4.5:1 on `--bg`, `--surface` and `--surface-2`. The light page is #f6f7f9, a cool neutral with no beige. Dark is slate #0d1015, not pure black.

## Type

System stacks only: SF Pro and system-ui for text, and ui-monospace/SF Mono for clocks, costs, commands and diffs (with `tabular-nums`).

Scale: 11 / 12 / 13 / 15 / 17 / **21** / 24.

The latest caption line is 21/29 at weight 510, the largest text in the window apart from the full-window state titles. The previous line is 15px in `--text-2`, and older lines are 15px in `--text-3`. Your words and Sotto's words use the same size and contrast. Only the speaker label's color and glyph differ: a dot for You, three bars for Sotto.

## Spacing, targets, motion

- **Spacing:** a 4/8 grid (`--s-1` to `--s-12`). Side gutter 16. At least 8 between controls and 16 between groups; the dock divider carries 8 + 4 on each side.
- **Targets:** every control is at least 44px (`--hit`) and the floor/mute pill is 64px (`--hit-primary`). The "More" text button and the banner close are also 44px.
- **Motion:**
  - 120/180/240ms with `cubic-bezier(.16,1,.3,1)`.
  - Level-driven transforms use a 90ms linear transition.
  - The only animation that isn't tied to the audio level is the current-step spinner, and it runs only while Claude is working.
  - With `prefers-reduced-motion`, every duration is 0, spinners stop, and the level states fall back to their static shapes (fill, hatch, dashed), which are distinct on their own.

## Claude Code in the conversation

- **Working:** the request, done steps (a small check, `--text-2`), and the current step (15px, `--text`, with a spinning `--work` node and elapsed time). The delegation chips live inside this block and are not a separate row.
- **Needs approval:** a pinned card with a 2px `--attn` edge, the heading "Claude needs your approval", the **full** command in mono (wrapped, never truncated), and "Approve or deny in the terminal". The window title changes to `Approval needed · Sotto`. The card uses `role="alert"`.
- **Finished:** a green check, "Claude finished", the duration, a summary clamped to 3 lines, a "More" button, and the file and diff count.

## Required states and where they are

| State | Frame |
|---|---|
| Allow microphone | 01 (dark), 15 (light) |
| Mic blocked in macOS | 02. Blocked in Chrome, not found and busy use the same page with their own copy. |
| Connecting | 03 (checklist) |
| Listening | 04 (hero) |
| You speaking | 05 |
| Sotto speaking | 06 |
| Working | 07 (dark), 14 (light) |
| Needs approval | 08 |
| Finished | 09 |
| Muted | 10 |
| Paused after idle, with pending result | 11 |
| Reconnecting (mute kept), plus a banner | 12 |
| Settings drawer with device pickers and level meter | 13 |
| 360x420 | 16 |

Not drawn, but they reuse the state-page pattern: daily cap (Paused, no Resume, the config hint), lost daemon, moved to another window ("Use this window"), and voice off / not connected (`/talk on`).

## Screen readers

- A single polite live region announces the floor changes ("Sotto speaking", "Listening", "Muted"), Claude's step changes and "Claude finished".
- Approval requests use an assertive `role="alert"`.
- Caption fragments are **not** live. Only a finalized line is announced, and only while the window is not focused.
- The mute pill keeps the name "Mute" with `aria-pressed`. Pause and End voice keep their names at every size.

## Do

- Let the transcript breathe. It anchors to the bottom and the newest line is the largest.
- Keep one hue per meaning, and always pair it with a shape and a word.
- Show the shortcuts at the default size: `M`/`Space` in the pill and `Space` on Resume.
- Put destructive actions behind a divider and at the far edge: End voice is always the rightmost control.
- Keep full text for anything the user has to act on: approval commands and mic-fix steps.

## Don't

- Don't use bubbles, avatars or a chat-app chrome. These are captions, not messages.
- Don't use a warm beige or a purple/blue gradient, and don't glow.
- Don't animate anything while idle, and don't animate the transcript on every token.
- Don't truncate approval commands, and don't hide the talking indicator or mute at any window size.
- Don't give Sotto's words more contrast than yours.

## SPEC strings

These are kept as is: `Pause`, `End voice` (visible at 420 wide; the aria-label keeps it at 360), `Resume`, `press Space`, the Quiet / Milestones / Walkthrough labels and descriptions, the Bluetooth hint, `Paused after <n> minutes of silence`, `Claude finished while you were away`, and the `<m.m> min · $<x.xx> today` usage format.

These are new or changed and must go in `docs/SPEC-DEVIATIONS.md` when this is implemented:
- the Allow-microphone page copy
- the mic-failure page copy
- the "Starting voice" checklist
- "Still billing"
- "Claude needs your approval" / "Approve or deny in the terminal"
- the floor words ("Listening", "You", "Sotto", "Muted")
- the header state label "Live" with a clock, replacing the "Listening · 0:19" caption
- "Claude finished" as the done-block heading

The header uses `lib.statusLabel`'s words, plus "Allow microphone", "Needs approval" and "Microphone blocked" as page-level overrides.
