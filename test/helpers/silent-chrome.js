// Headless Chrome for the e2e tests, guaranteed silent and mic-free.
//
// Tests must never use the real microphone or the real speakers: a live voice
// session on the same Mac hears whatever the test plays through the speakers
// and sends it to the model as the user's speech (seen in practice). So every
// test Chrome gets a fake capture device fed from a file, the fake permission
// UI, and --mute-audio, and a launch without them throws before Chrome starts.
//
// --mute-audio silences the output device only: WebAudio still runs, so the
// page's voice meter (an AnalyserNode on an unplayed clone of the remote
// track, web/app.js) still sees the model's voice. smoke.mjs checks that.
import { spawn } from "node:child_process";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Each entry: a flag that must be present (exactly, or as a `flag=` prefix).
export const REQUIRED_FLAGS = [
  "--headless=new",
  "--mute-audio",                       // never play through the speakers
  "--use-fake-device-for-media-stream", // never open the real microphone
  "--use-fake-ui-for-media-stream",     // no permission prompt
  "--use-file-for-fake-audio-capture=", // the fake mic plays a fixture file
];

/** Throws unless `args` keep Chrome silent and off the real mic. */
export function assertSilentChromeArgs(args) {
  const missing = REQUIRED_FLAGS.filter((f) => !args.some((a) => (f.endsWith("=") ? a.startsWith(f) && a.length > f.length : a === f)));
  if (missing.length) {
    throw new Error(`test Chrome refused: missing ${missing.join(", ")} (tests must never use the real mic or speakers)`);
  }
  return args;
}

/**
 * Spawn headless Chrome with the silent, fake-mic flags plus `extra` args.
 * `wav` is the fake-mic file (played once, no loop).
 */
export function spawnSilentChrome({ wav, extra = [], spawnImpl = spawn, bin = CHROME }) {
  if (!wav) throw new Error("test Chrome refused: no fake-mic file (tests must never use the real mic)");
  const args = assertSilentChromeArgs([
    "--headless=new", "--mute-audio",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    // Chrome 153's sandboxed audio service cannot read the file and the mic is
    // silent; disabling just that sandbox is narrower than --no-sandbox.
    "--disable-features=AudioServiceSandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run", "--no-default-browser-check",
    ...extra,
  ]);
  return spawnImpl(bin, args, { stdio: "ignore" });
}
