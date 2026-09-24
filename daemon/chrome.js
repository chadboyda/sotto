// Voice window control (SPEC §6.12): open a Chrome --app window with a
// dedicated profile, close it, and best-effort macOS notifications.
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnCb, execFile as execFileCb } from "node:child_process";

export const CHROME_APP = "/Applications/Google Chrome.app";

/**
 * createChrome({dataDir, port, env, spawn, execFile, exists, kill, log, launchCode})
 * → {open(): {mode}, kill(): Promise<number>, notify(text), launched}
 */
export function createChrome({
  dataDir, port, env = process.env, spawn = spawnCb, execFile = execFileCb,
  exists = fs.existsSync, kill = process.kill.bind(process), log, launchCode,
} = {}) {
  const profile = path.join(dataDir, "chrome");
  const url = `http://127.0.0.1:${port}/`;
  // Each window URL carries a fresh one-time launch code in its fragment (never
  // sent over HTTP). Process arguments are visible to other local users on
  // macOS, so the code is single-use and short-lived: the page trades it at
  // /api/bootstrap for the persistent page secret.
  const openUrl = () => { const c = launchCode?.(); return c ? `${url}#k=${c}` : url; };
  const flag = `--user-data-dir=${profile}`;

  const detached = (cmd, args) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on?.("error", (e) => log?.warn("chrome.spawn_error", { message: e.message }));
      child.unref?.();
      return true;
    } catch (e) {
      log?.warn("chrome.spawn_error", { message: e.message });
      return false;
    }
  };

  const api = {
    launched: false,
    url,
    profile,

    /**
     * Open the voice window. Returns the mode actually used. `force` ("chrome"
     * or "default") comes from the window chooser (window.js); without it the
     * env decides, as in SPEC §6.12 (app/auto count as chrome here).
     */
    open(force) {
      // SOTTO_NO_BROWSER=1 is a convenience alias for SOTTO_BROWSER=none
      // (probes and tests that must never open a window).
      const want = force || (env.SOTTO_NO_BROWSER === "1" ? "none" : (env.SOTTO_BROWSER || "chrome").toLowerCase());
      if (want === "none") return { mode: "none" };
      if (want !== "default" && exists(CHROME_APP)) {
        try { fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
        detached("open", ["-na", "Google Chrome", "--args", `--app=${openUrl()}`, flag,
          "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check", "--window-size=420,640"]);
        api.launched = true;
        log?.info("chrome.open", { mode: "chrome" });
        return { mode: "chrome" };
      }
      detached("open", [openUrl()]);
      log?.info("chrome.open", { mode: "default" });
      return { mode: "default", warn: true };
    },

    /** SIGTERM every process whose args contain exactly our --user-data-dir flag. */
    kill() {
      return new Promise((resolve) => {
        if (!api.launched) return resolve(0);
        execFile("ps", ["-axo", "pid=,args="], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(0);
          let n = 0;
          for (const line of String(stdout).split("\n")) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (!m) continue;
            const args = m[2];
            const i = args.indexOf(flag);
            // Exact match: the flag must end at a space or end of line (not …/chrome-e2e).
            if (i < 0 || !(i + flag.length === args.length || args[i + flag.length] === " ")) continue;
            const pid = Number(m[1]);
            if (pid === process.pid) continue;
            try { kill(pid, "SIGTERM"); n++; } catch { /* already gone */ }
          }
          api.launched = false;
          log?.info("chrome.kill", { count: n });
          resolve(n);
        });
      });
    },

    /** Best-effort macOS notification. Text must not contain secrets. */
    notify(text) {
      const safe = String(text).replace(/["\\]/g, "'");
      try {
        execFile("osascript", ["-e", `display notification "${safe}" with title "sotto"`], { timeout: 3000 }, () => {});
      } catch { /* ignore */ }
    },
  };
  return api;
}
