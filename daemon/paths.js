// Data-directory file paths (SPEC §3). The daemon receives D via --data-dir.
import path from "node:path";

export function dataPaths(D) {
  const logs = path.join(D, "logs");
  return {
    dir: D,
    pid: path.join(D, "daemon.pid"),
    key: path.join(D, "daemon.key"),
    port: path.join(D, "daemon.port"),
    pageSecret: path.join(D, "page.secret"),
    startError: path.join(D, "start-error"),
    active: path.join(D, "active"),
    pendingContext: path.join(D, "pending-context"),
    status: path.join(D, "status.json"),
    usage: path.join(D, "usage.json"),
    prefs: path.join(D, "prefs.json"),
    previews: path.join(D, "voice-previews"), // cached voice samples (<voice>.wav)
    logs,
    daemonLog: path.join(logs, "daemon.log"),
    crashLog: path.join(logs, "crash.log"),
    chrome: path.join(D, "chrome"),
  };
}
