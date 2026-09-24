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
import fs from "node:fs";
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

/**
 * Stop a test Chrome and remove its profile directory, deterministically.
 *
 * Chrome keeps writing into --user-data-dir (Default/, the crash database)
 * until its browser process has exited. Removing the directory on a timer
 * after SIGTERM raced those writes: on a slow CI runner rmSync hit
 * "ENOTEMPTY: directory not empty, rmdir …/Default" inside the timer, which
 * node:test reports as an uncaught exception after the test ended and fails
 * the file. So: wait for the process to exit (SIGKILL after `graceMs`), then
 * remove the directory with retries for helper processes that are still
 * shutting down. Never throws: cleanup must not fail a test that passed.
 */
export async function stopChrome(child, userDir, { graceMs = 5000, rm = fs.rmSync } = {}) {
  if (child) {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const waitExit = (ms) => new Promise((resolve) => {
      if (exited()) return resolve(true);
      const timer = setTimeout(() => { child.off?.("exit", onExit); resolve(exited()); }, ms);
      function onExit() { clearTimeout(timer); resolve(true); }
      child.once("exit", onExit);
    });
    if (!exited()) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      if (!(await waitExit(graceMs))) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        await waitExit(graceMs);
      }
    }
  }
  if (!userDir) return;
  try { rm(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a temp dir; the OS reaps it */ }
}
