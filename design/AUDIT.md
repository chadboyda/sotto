# sotto voice window: UX audit

Scope: the current page in `web/` (index.html, styles.css, app.js, lib.js) at the default 420x640 Chrome `--app` window, plus 420x480, 360x420 and 640x900, in dark and light. Method: Nielsen heuristic evaluation, a cognitive walkthrough of four core tasks, an anti-pattern scan, measured target sizes (CDP `getBoundingClientRect`) and computed WCAG contrast of the CSS tokens.

How the screenshots were made: a throwaway static server served `web/` with every `/api/*` request left hanging, so the page stayed in `boot` and never re-rendered. Each state was then written into the DOM over CDP, following app.js's own render rules (`overlayModel`, `renderMic`, `renderClaude`, `activityView`, `pausedMessage`, `micErrorMessage`). No daemon or OpenAI session was used. Screenshots are 2x, in `design/audit/` (`NN-state--dark|light.png`, `3N-size-*`).

Not evaluated: screen-reader output on a live stream, the real Chrome permission bubble (headless Chrome has no permission UI), and real audio timing.

---

## UX health score: 56 / 100

| Area | Score /10 | One line |
|---|---|---|
| Layout and responsiveness | 4 | Seven stacked zones of equal weight. At 480px tall and below, the footer scrolls off-screen and the captions shrink to a sliver |
| Spacing and touch targets | 4 | Every secondary control is 23 to 30px tall. The gaps are 3 to 8px. This matches the user's "buttons are really tight" |
| Hierarchy | 5 | The mute button dominates, but it cannot tell you who is talking. Claude's work state is 14px grey text |
| Color and contrast | 4 | The warm beige light theme ("AI-slop beige"). The mic button is almost invisible against the page (1.11:1 light, 1.29:1 dark). Faint text fails AA in light mode |
| Typography | 6 | The system stack is fine. Nearly everything is 14/13/12px regular, so the scale is flat. The 76px right-aligned speaker column wastes about 20% of the width |
| State clarity | 4 | No "Chrome is asking for the mic" state. No "assistant speaking" state. Approval-needed is only colored text, and it is truncated |
| Accessibility | 6 | The fundamentals are good: a focus ring, a radiogroup, reduced motion and live regions. The problems are small targets, contrast failures, a live-region flood and hidden keyboard hints |
| Motion | 7 | Restrained, and it respects `prefers-reduced-motion`. The level ring overlaps the caption at high levels, and nothing moves for the assistant's voice |

**Anti-pattern verdict: Clean.** Cost is always visible in the header, pausing is one click, and nothing uses urgency or nagging. One low item: the voice is called "Sotto" while the coding agent is "Claude", so it is not clear which one did what. That is a naming problem, not a manipulation.

---

## Priority issues

### P0: blocks the core task

1. **The first launch has no explicit "Allow microphone" state.** Screenshot: `02-first-launch-mic-permission--*`.
   - While `getUserMedia` waits on Chrome's prompt, the page shows a disabled mic at 45% opacity on a 1.29:1 fill, plus "Opening the microphone…" in muted grey.
   - Nothing says that Chrome is asking, where the prompt is, or that the user must click Allow.
   - The Chrome prompt in a 420px `--app` window hangs off the top-left corner and is easy to miss. The user perceives the window as blank.
   - Pause and End voice are enabled during this state and invite the wrong action.
   - Fix: add a first-class `permission` state.
     - Detect it with `navigator.permissions.query({name:"microphone"})`: `"prompt"` means show the state before calling `getUserMedia`, and the query's `onchange` updates it live.
     - Show a large headline, "Allow microphone access", an arrow or illustration pointing to the top-left where Chrome's prompt appears, and one line of why.
     - Handle each outcome: denied gets specific recovery steps, and dismissed gets a retry button (see #6).
   - Routes: `/fortify` (state), `/articulate` (copy).

2. **The window can't show who has the floor.** Screenshots: `04`, `05`, `06`.
   - The ring reacts only to the local mic level.
   - When the assistant speaks, the page is identical to silence: the caption still says "Listening · 0:19".
   - In a voice-first companion this is the main thing to read at a glance: am I being heard, is it talking, is it waiting on me.
   - Fix: a single "floor" indicator with distinct form, color and label for idle-listening, you-speaking, Sotto-speaking and muted.
     - Measure the remote level with an `AnalyserNode` on a clone of the remote stream that is **not** connected to the destination, because the `<audio>` element must stay the AEC reference.
   - Routes: `/fortify`, `/journey`.

3. **At small heights the controls fall off the window.** Screenshots: `30-size-420x480`, `31-size-360x420`.
   - At `max-height: 480px`, `body` becomes scrollable and `.app` becomes auto-height. Pause and End voice then sit below the fold, and the captions collapse to about 30px.
   - The window is meant to be resizable and parked in a corner, so this breaks the promise.
   - Fix: a priority-collapse layout.
     - The floor indicator and mute stay fixed.
     - Captions shrink to the last line.
     - Chips collapse into the activity line.
     - Settings move to a drawer.
     - The page never scrolls.
   - Route: `/transpose`.

### P1: significant friction

4. **Targets are too small and packed too tight.** Measured sizes:

   | Control | Height | Spacing |
   |---|---|---|
   | Policy segments | 29px | 3px gap |
   | Device selects | 30px | |
   | Chips | 23px | 4px gap |
   | Banner close (×) | about 20px | |
   | Pause and End | 36px | 8px gap |

   The destructive End voice sits 8px from Pause, with the same shape and size.
   - Minimum should be a 40px hit area, with 12 to 16px between groups.
   - Move End voice away from Pause, or behind a menu or a confirm.
   - Route: `/include`.

5. **The approval-needed state is under-signalled.** Screenshot: `08`.
   - "Waiting for your approval in the terminal: Bash(rm -rf te…" is a single ellipsized 14px amber line.
   - This is the one moment the user must act, and it looks like the working state in a different color.
   - Fix: an attention card that shows the full command, names the terminal, and pulses the header dot. It should also reach the window title or badge so the user can see it from another app.
   - Routes: `/fortify`, `/articulate`.

6. **The mic error copy is wrong for common cases.**
   - `NotAllowedError` always says "blocked… in Chrome settings".
   - A dismissed prompt, which is also `NotAllowedError`, only needs a retry.
   - A macOS-level block (System Settings → Privacy → Microphone → Chrome) is the real cause as often as the Chrome setting. The README knows this; the page doesn't.
   - Use the Permissions API state to tell the three cases apart and give concrete steps for each. Include the path to site settings from the app window's ⋮ menu.
   - Route: `/articulate`.

7. **Light theme is beige, low contrast and has no presence.** Screenshots: `*--light`.
   - Tokens: `--bg #f5f4f1`, `--surface-2 #efede8`, `--mic #ebe8e2`.
   - Contrast: mic vs background 1.11:1, lines 1.26:1, `--faint` text 2.92:1 (fails AA), "Sotto" green labels 3.22:1 (fails for 12px text), `--warn` 3.62:1.
   - Dark mode has the same structural issue: the mic fill is 1.29:1 and its border 1.34:1. WCAG 1.4.11 needs 3:1 for component boundaries.
   - Fix: a neutral, cool-grey or ink token set. Keep text at 4.5:1 or more and control boundaries at 3:1 or more.
   - Routes: `/include`; visual system work.

8. **The Claude summary is clipped mid-line.** Screenshot: `09`.
   - `max-height: 4.6em` with an inner scroll cuts the last visible line in half, and there is no expand affordance.
   - Together with two chips and the activity line, it squeezes the captions down to about 3 lines at 640px.
   - Fix: a clean 2 or 3 line clamp, a "More" disclosure, and chips folded into the summary or activity card.
   - Routes: `/fortify`, `/organize`.

9. **Settings take up prime space.**
   - The speaking policy and the two device pickers are about 90px of permanent footer, but they are set once per session at most.
   - They push the live content up and make the window look like a form.
   - Fix: a settings drawer or popover, entered from a gear icon, with the current mic and speaker shown as one compact line when useful.
   - Route: `/organize`.

### P2: degraded, recoverable

10. **Keyboard shortcuts are invisible at the default size.**
    - The `.keys` hint only shows at a height of 760px or more, and the default window is 640px.
    - Space means mute, but Space on a focused button activates that button instead. Users will not discover the inconsistency.
    - Fix: put the shortcut in the mute button's tooltip or label ("M"), and show the Space hint on the paused and error cards, as the paused card already does.
    - Routes: `/include`, `/articulate`.

11. **The caption live region floods screen readers.**
    - `#captions` is `aria-live="polite"` and is rewritten on every transcript delta.
    - Fix: announce only finalized lines, or leave the captions un-announced and announce floor changes and Claude milestones instead.
    - Route: `/include`.

12. **The mute button's label inverts.**
    - The button uses `aria-pressed` and also swaps its label between "Mute microphone" and "Unmute microphone". Screen readers then read a double state.
    - Fix: keep a stable name, "Mute", and let `aria-pressed` carry the state.
    - Route: `/include`.

13. **The level ring collides with the caption.** Screenshot: `05`.
    - At high levels, `scale(1.32)` grows the 112px button to about 148px, which overlaps "Listening · 0:14".
    - Route: visual.

14. **Banners stack above the stage and use jargon.** Screenshot: `15`.
    - Up to 3 banners push the mic down about 150px.
    - The copy is written for developers: "429", "crossSessionInbound", "daemon".
    - Error banners persist, which is fine, but they have no action.
    - Fix: one banner slot, a count for the rest, plain-language copy, and one recovery action per banner.
    - Route: `/articulate`.

15. **Header status and mute can disagree.**
    - The header says "Live" with a green dot while muted.
    - Billing does continue, but at a glance the dot should say "Live · muted".
    - Route: `/fortify`.

16. **The select value text is faint.**
    - `select` inherits `color: var(--faint)` from its label, so the chosen device reads as disabled: 4.0:1 on dark, 2.9:1 on light.
    - Route: `/include`.

### P3: cosmetic

17. **Too many boxes and rules.**
    - Two full-width rules, bordered chips, a bordered summary, a bordered segmented control and bordered buttons.
    - Together they make a busy, boxy grid with no single focal surface.

18. **The caption layout has a wasted gutter.**
    - The 76px right-aligned speaker column takes about 20% of a 420px window.
    - User lines are dimmer than assistant lines, which is the opposite of what the user most needs to verify (their own words being heard).

19. **The spinner and status dot are small (9 to 12px).**
    - At a glance from the corner of the eye they carry little.

---

## Heuristic scores (0 = no issue, 4 = catastrophic)

| # | Heuristic | Score | Evidence |
|---|---|---|---|
| H1 | Visibility of system status | **4** | No mic-permission state (#1). No assistant-speaking state (#2). Approval-needed is a truncated line (#5). The header says Live while muted (#15) |
| H2 | Match with real world | 2 | "daemon", "429", "crossSessionInbound" and "Milestones/Walkthrough" are left unexplained. "Sotto" vs "Claude" is ambiguous |
| H3 | User control and freedom | 1 | Pause and Resume are one step, and Space resumes. End voice has no confirm, but `/talk on` recovers it |
| H4 | Consistency and standards | 2 | Space means mute or resume, except on a focused button. The mute label inverts. Several different box styles |
| H5 | Error prevention | 2 | End voice is adjacent to Pause at the same weight. Pause and End are enabled during the permission wait |
| H6 | Recognition over recall | 2 | Hotkeys are hidden at the default size. Policy meanings exist only in `title` tooltips |
| H7 | Flexibility and efficiency | 1 | M and Space hotkeys exist. There is no shortcut for End or for settings, which is acceptable |
| H8 | Aesthetic and minimalist | 3 | Settings are permanently visible. Seven zones of equal weight. Chips duplicate the activity line. Beige surfaces |
| H9 | Error recognition and recovery | 3 | The mic error conflates dismissed, Chrome-blocked and macOS-blocked. Banners have no actions |
| H10 | Help and documentation | 2 | Troubleshooting lives only in the README. There is no inline "why" on errors |

---

## Cognitive walkthrough

**T1. First launch: get talking.** Steps: `/talk on` → window opens → allow mic → greeting → speak.
- Step "allow mic": **Failure.** Q1 motivation: no, because the page never says an action is needed. Q2 visibility: no, because the Chrome bubble is small and off to the side. Q4 feedback: partial, because after Allow the caption changes to "Connecting to the voice service…", which is small.
- Step "greeting": **Hesitation.** The page looks identical while the voice speaks (#2).

**T2. Mute while someone walks in.** Steps: glance → click the mic or press M → confirm muted.
- **Pass or hesitation.** The mic target is big (112px). The muted state is a dark-red fill with a slash, which is clear up close but weak at a glance (`10-muted`). The header still says Live.

**T3. Know whether Claude finished, from the corner of your eye.** Steps: glance → read state → read the summary.
- **Hesitation.** "Claude finished" is 14px grey with a 12px green ring. The summary is clipped mid-line, and the chips' "Done" is 12px.

**T4. Recover from a paused-after-idle state.** Steps: see the card → press Space or click Resume.
- **Pass.** The card has a clear title, the pending result is inline, a large primary Resume button and a Space hint (`11-paused-idle-pending`). This is the best state in the app.

---

## Positive findings (protect these)

- **The paused card with the pending result.** "Claude finished while you were away: …" plus Resume plus Space is the right pattern. Reuse it for the approval and permission states.
- **Honest cost display.** Minutes and dollars are always in the header, and there is a billing-safe teardown when contact is lost. Keep them visible, just quieter.
- **Robust state machine.** Every daemon and page state already maps to a distinct overlay model (`overlayModel()`), so the redesign is a presentation change, not a logic rewrite.
- **Accessibility base.** A `:focus-visible` ring (9.2:1), a radiogroup with arrow keys, `sr-only` labels, `prefers-reduced-motion` handling and `color-scheme`.
- **Calm motion vocabulary.** A 180 to 200ms enter, no bounce, and a ring driven by a real signal.
- **The Bluetooth hint.** "Using the built-in mic so your headphones keep high-quality audio" is proactive and plain-language.

---

## Recommended actions (by owner skill)

- **/fortify**: #1 permission state, #2 floor state (you, Sotto, idle, muted), #5 approval card, #8 summary clamp, #15 muted in the header. These cover the whole state model. See "Required states" below.
- **/transpose**: #3 the priority-collapse layout across 360x420 to 640x900, with no page scroll ever.
- **/include**: #4 targets of 40px or more, #7 and #16 contrast tokens, #10 hotkey discoverability, #11 live-region strategy, #12 the mute label.
- **/organize**: #9 settings drawer, #8 and #17 merging chips into the Claude card.
- **/articulate**: #6 mic error variants, #14 banner copy, a naming decision between "Sotto" (voice) and "Claude" (Code).
- **Visual system** (tokens, type scale, surfaces): #7, #13, #17, #18, #19.

---

## UX brief for the redesign

**What this window is.** A voice-first companion that sits in the corner of the screen while you code. You look at it for under a second at a time, usually from the side of your eye, to answer three questions: *Is it hearing me? Is it talking? Is Claude done or waiting on me?* Reading happens rarely. Configuring happens almost never.

### Information hierarchy (glance order)

1. **The floor: who is talking right now.**
   - States: listening-idle, you speaking, Sotto speaking, muted, paused or off.
   - This is the largest element, readable at 2m. Encode it in shape, motion and color, and include a word, so color is never the only signal.
   - Mute is the primary control and lives here.
2. **Claude Code's state.**
   - States: idle, working (with the current milestone as one line), needs your approval (loud, full text, names the terminal), finished (2 to 3 line summary with More).
   - This is one card. It absorbs the delegation chips.
3. **The latest line of conversation.**
   - The current utterance is large, and the one before it is dimmer. History is scrollable below when there is room and collapses first.
   - The user's own words must be at least as legible as the assistant's.
4. **Session meta, quiet.** Status word, project, session clock, minutes and $ today, all in one header row.
5. **Secondary actions.** Pause (with a Space hint) and End voice (separated, or behind a menu).
6. **Settings, out of sight.** Speaking policy, mic and speaker go in a drawer or popover behind a gear icon.

### Required states (each needs a designed treatment)

| State | What it must communicate | Primary action |
|---|---|---|
| Starting / finding daemon | "Starting sotto…" | none |
| **Allow microphone** | "Chrome is asking for your microphone" and where the prompt is (top-left) | point to Allow; Retry if dismissed |
| Mic blocked (Chrome) / blocked (macOS) / not found / busy | Specific cause plus the exact steps | Try again |
| Connecting voice | Brief progress | none (Pause available) |
| Live · listening | Ready, quiet | Mute |
| Live · you speaking | Heard: level-reactive | Mute |
| Live · Sotto speaking | It has the floor: output-level-reactive, visibly different from you | Mute (interrupting by voice is allowed) |
| Live · muted | Unmistakable at a glance, header included; billing continues | Unmute (M / Space) |
| Claude working + milestone | One-line progress, calm motion | none |
| **Claude needs approval** | Loud: full command, "approve in the terminal" | none in-page; the attention must escape the window (title) |
| Claude finished + summary | Summary, 2 to 3 lines, expandable | More |
| Paused (user / idle n min) + pending result | Why it paused, what finished meanwhile | Resume / Space |
| Paused: daily cap | Limit reached, how to raise it | none |
| Reconnecting | Transient, non-alarming, mute preserved | none |
| Notices / errors (banners) | One at a time, plain language, one action each | Dismiss / action |
| Lost daemon | Session closed to stop billing, waiting | none |
| Moved to another window | This window is inactive | Use this window |
| Voice off / closed / not connected | Safe to close; how to start again (`/talk on`) | none |

### Constraints

- **Window:** 420x640 by default and freely resizable. Design for 360x420 up to 640x900.
  - Collapse by priority: settings, then history, then chips, then the summary becomes one line.
  - The floor indicator and mute never leave the viewport, and the page never scrolls.
- **Glanceable:** state readable from peripheral vision.
  - Large, distinct shapes and motion per floor state.
  - The status word stays visible.
  - No meaning carried by color alone.
- **Themes:** dark and light, following `prefers-color-scheme`.
  - Neutral, cool palette. No warm beige.
  - Text contrast 4.5:1 or more. Control boundaries and the mute button 3:1 or more against the page.
  - One semantic color per meaning, identical across themes: live/heard, Claude working, attention, error, muted.
- **Targets and spacing:**
  - Hit areas at least 40x40px, primary at least 64px.
  - At least 8px between controls and 16px between groups, on a 4/8px spacing scale.
  - Destructive actions separated from frequent ones.
- **Keyboard:**
  - M and Space mute, Space resumes, Esc closes the drawer, a visible focus ring everywhere.
  - Shortcuts shown in the UI at the default size.
  - All controls reachable in a logical tab order.
- **Screen readers:** announce floor changes, Claude milestones and approval requests, not every caption delta.
- **Motion:**
  - Signal-driven (mic and output level) and calm (150 to 250ms).
  - No decorative loops while idle.
  - A full `prefers-reduced-motion` fallback that swaps motion for static shape changes.
- **Tech (SPEC §7.1):**
  - Plain HTML, CSS and ES modules. No framework, no build step, no external fonts or CDNs, so use system fonts and inline SVG only.
  - The `<audio>` element stays the AEC reference, so any output meter must not route audio through WebAudio to the destination.
  - Keep SPEC's exact contract strings, or record a change in SPEC-DEVIATIONS.md.
