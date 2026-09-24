# Direction A: Instrument

A voice window that reads like a calibrated meter on a mixing desk: near-black, cool graphite, hairline edges, and one instrument that tells you who is talking. Nothing moves unless sound or work is happening.

Files: `tokens.css` (the system), `mockup.html` (15 frames, self-contained, tokens inlined), `overview.png`, `hero.png`.

## The idea in one sentence

The dial is two concentric level meters around the mute button: the **inner ring is your mic**, the **outer ring is Sotto's voice**, and the **bezel arc is Claude Code working**. You can read it from the corner of your eye because each talker has its own ring, its own shape and its own word.

| State | Inner ring (you) | Outer ring (Sotto) | Mute button | Word under dial |
|---|---|---|---|---|
| Listening | Green ticks at rest length, static | Grey rest ticks | Green 2px edge | Listening |
| You speaking | Green ticks, jagged and asymmetric, follow the mic analyser | Rest | Green edge | You're speaking |
| Sotto speaking | Grey rest | Ink ticks in smooth, symmetric four-lobed swells | Neutral edge | Sotto is speaking |
| Muted | Ring replaced by a dashed violet circle | Still meters Sotto | Filled violet, slashed mic | Muted |
| Connecting / reconnecting | Grey rest, dashed button edge | Grey sweep arc on the bezel | Disabled look (dashed, not faded) | Connecting / Reconnecting… |
| Claude Code working | Unchanged | Unchanged | Unchanged | Unchanged, plus blue bezel arc |

Shape, word and color change together, so no state depends on color alone.

## Tokens

- **Neutrals:** cool graphite with no warm cast. Dark `--bg #0B0D10`, light `--bg #F5F6F8` (this replaces the beige `#f5f4f1`).
- **One color per meaning, the same in both themes:**
  - `--live` green: live, heard, you
  - `--work` blue: Claude Code working
  - `--attn` amber: approval needed, allow mic
  - `--err` red: errors and End voice
  - `--mute` violet: muted
  - Sotto's voice is `--voice`, which is ink (the foreground color), not a hue. The only saturated color on a calm screen is the green "you are heard" signal.
- **Contrast (measured):**
  - Every text token is at least 4.5:1 on `--bg`, `--surface-1` and `--surface-2` in both themes. The lowest is light `--live` on `--surface-2` at 4.62:1.
  - `--edge` (control boundaries, the mute button edge) is 3.66:1 in dark and 3.54:1 in light.
  - `--line` is for dividers only and never marks a control.
- **Type:** system stacks only. The scale is 12 / 13 / 15 / 17 / 22 / 24:
  - 12 is used only for meta.
  - 17 is the latest caption.
  - 22 is the state word.
  - 24 is the overlay title.
  - Tabular numerals for clocks and cost. Monospace only for real commands and paths.
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48, with a 16px gutter. Controls in a group are 8px apart; groups are 16px apart.
- **Targets:**
  - Every control is at least 44px tall. That includes the banner dismiss, the gear, "More" and the selects.
  - Policy segments are 40px inside a 48px well.
  - The mute button is 88px, or 72px at the compact size.
  - The primary card action is 48px.
- **Radii:** 4 for kbd, 8 for controls, 12 for cards, 16 for the drawer, round for the dial. The feel is machined, not pillowy.
- **Motion:** 80 / 150 / 200 / 250ms with an expo-out ease.
  - Meters use JS attack and release smoothing (about 40ms and 220ms) on the analyser value. CSS never tweens tick length.
  - The bezel arc orbits only while Claude is busy. The connect sweep runs only while connecting.
  - Under `prefers-reduced-motion`, durations go to 0, rings snap to three discrete lengths (rest, mid, full), and arcs stay static. Shape still differs per state.

## Layout at 420x640, top to bottom

1. **Header (52px):** status glyph and word, project, session clock, minutes and $ today, and the gear.
   - The status glyph's shape carries meaning: a filled dot for live, a slashed ring for muted, a triangle for approval, a diamond for error, bars for paused, a hollow ring for connecting.
   - When muted, the header reads "Muted · still billing".
2. **Stage:** the dial (208px), the state word, and the live shortcut hint (`M` or `Space` to mute), which is visible at the default size.
3. **One Claude Code card:**
   - Idle: a dashed one-liner.
   - Working: a blue edge, elapsed time, the current step on one line, and the request it serves (this replaces the chips).
   - Needs approval: a 2px amber card with the full command in mono and "Approve or deny it in the terminal". The window title also changes.
   - Finished: a clean 3-line clamp and a 44px "More".
4. **Captions:** the latest line at 17px in full foreground, the one before it dimmer, and older lines faded out at the top. Your words and Sotto's use the same color and size rules.
5. **Footer:** Pause on the left (it shows its `Space` key when relevant). End voice sits on the far right as a red ghost button with a different shape and color from Pause and at least 150px away from it.
6. **Settings:** a bottom drawer behind the gear holds the speaking policy, mic, speaker and the Bluetooth hint. Esc closes it. The dial stays visible above it.

**Collapse order when the window shrinks:** settings (already in the drawer), then caption history, then the request line, then the card down to one line. After that, the dial goes to 132px and sits beside the state word (see frame 15 at 360x420). The page never scrolls.

## Do

- Let the dial carry the three glance questions. It is the only element allowed to move.
- Use `--edge` for anything clickable and `--line` for anything that only separates.
- Use one banner at a time, with one action and a 44px dismiss.
- Keep the mute button's accessible name fixed as "Mute" and let `aria-pressed` carry the state. Announce changes in who is talking, Claude's steps and approval through a polite region. Do not announce caption deltas.
- Put a specific title and steps on each mic failure:
  - Chrome site settings
  - macOS Privacy → Microphone
  - not found
  - busy
- Show the Allow-microphone state before calling `getUserMedia` whenever `permissions.query` says `prompt`.

## Don't

- Don't use beige, warm greys or tinted cream in the light theme.
- Don't add glow, neon halos or gradient fills to the dial. Its edges are hairlines, and depth comes from one soft inset shadow.
- Don't show the same meaning in two colors, or two meanings in one color. Red never means anything except error or destructive.
- Don't loop animation while idle, and don't pulse "Listening".
- Don't use icon tiles above headings. Overlay cards use an inline icon beside the title.
- Don't fade a control to show it is unavailable. Use a dashed edge and `--fg-3` text so it still passes contrast.
- Don't place End voice next to Pause or Resume.

## Copy notes (to record in docs/SPEC-DEVIATIONS.md if adopted)

- **Kept verbatim:**
  - "Paused after <n> minutes of silence"
  - "Resume to keep talking with Claude Code."
  - "Claude finished while you were away"
  - "Connecting to the voice service…"
  - "The voice connection was lost."
  - "What you and Sotto say will appear here."
  - The policy names
  - The Bluetooth hint
- **New:**
  - "Allow microphone access"
  - "macOS is blocking the microphone" and its steps
  - "Approve or deny it in the terminal."
  - "Muted · still billing"
  - "Just talk to interrupt"
- **Changed:**
  - The activity line "Claude is working: X" becomes a card showing the state "Working" with X as the step.
  - The approval text moves from one truncated line to the card.
