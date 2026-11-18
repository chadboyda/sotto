// Port fallback (SPEC §6.2 "Port fallback"). The daemon listens on the `port`
// setting (47821) when it can; when another program holds it, it takes the
// first free port of the next PORT_FALLBACKS (47822..47830) and records it in
// D/daemon.port, which toggle.sh, bin/sotto and the desktop app read (hooks,
// the courier and the mod get it from D/active). Before 0.6.10 a held port
// made `/talk on` fail with "the voice daemon did not start".
import net from "node:net";

/** How many ports after the setting the daemon tries: 47822..47830. */
export const PORT_FALLBACKS = 9;

/** The last port tried for a base port. */
export function lastPort(base, fallbacks = PORT_FALLBACKS) {
  return Math.min(base + fallbacks, 65535);
}

/**
 * Can `port` be bound on the loopback right now? Binds and closes a probe
 * server: the truth is what listen() says, not whether something answers.
 * Resolves false on EADDRINUSE/EACCES; other errors reject.
 */
export function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", (e) => (e && (e.code === "EADDRINUSE" || e.code === "EACCES") ? resolve(false) : reject(e)));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** The first bindable port in base..lastPort(base), or null when all are held. */
export async function pickPort(base, { fallbacks = PORT_FALLBACKS, isFree = portFree } = {}) {
  for (let p = base; p <= lastPort(base, fallbacks); p++) {
    if (await isFree(p)) return p;
  }
  return null;
}
