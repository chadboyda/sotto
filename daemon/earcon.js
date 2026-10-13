// The earcon (SPEC §6.15 "Earcon"): a short, soft two-note chime the app plays
// before an update the user did not ask for wakes the voice, so speech out of
// silence does not startle. Pure: 24 kHz mono PCM16, the speaker format of
// the native link (docs/NATIVE.md §2.4).
export const EARCON_RATE = 24_000;
/** Peak level: about -26 dBFS, well under the voice. */
export const EARCON_PEAK = 1650;

/** Two rising notes with raised-cosine edges, then a short tail of silence. */
export function earconPcm(rate = EARCON_RATE) {
  const notes = [[659.25, 0.09], [987.77, 0.15]]; // E5, B5
  const gap = Math.round(0.03 * rate);
  const tail = Math.round(0.06 * rate);
  const total = notes.reduce((n, [, d]) => n + Math.round(d * rate), 0) + gap + tail;
  const out = Buffer.alloc(total * 2);
  let i = 0;
  for (const [k, [f, d]] of notes.entries()) {
    const n = Math.round(d * rate);
    const edge = Math.round(0.012 * rate);
    for (let j = 0; j < n; j++, i++) {
      const env = j < edge ? 0.5 - 0.5 * Math.cos((Math.PI * j) / edge) : j > n - edge ? 0.5 - 0.5 * Math.cos((Math.PI * (n - j)) / edge) : 1;
      // Each note fades a little: a chime, not a beep.
      const decay = Math.exp(-2.2 * (j / n));
      out.writeInt16LE(Math.round(EARCON_PEAK * env * decay * Math.sin((2 * Math.PI * f * j) / rate)), i * 2);
    }
    if (k === 0) i += gap;
  }
  return out;
}
