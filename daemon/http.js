// HTTP server, router and auth (SPEC §6.3, §6.4).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { VERSION } from "./config.js";

const MAX_BODY = 16 * 1024 * 1024;
const STATIC_RE = /^[A-Za-z0-9._-]+\.(html|js|css|svg|png|ico|json)$/;
const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", json: "application/json; charset=utf-8",
};

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const h = { "Cache-Control": "no-store", ...headers };
  if (body === undefined || body === null) {
    res.writeHead(status, h);
    res.end();
    return;
  }
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (!h["Content-Type"]) h["Content-Type"] = "application/json; charset=utf-8";
  res.writeHead(status, h);
  res.end(data);
}

const err = (res, status, code, message) => send(res, status, { error: message ? { code, message } : { code } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; return; }
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => (tooBig ? reject(Object.assign(new Error("too large"), { status: 413 })) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  const s = buf.toString("utf8").trim();
  if (!s) return {};
  return JSON.parse(s);
}

/**
 * createHttpServer({voice, port, daemonKey, pageToken, webDir, sse, log})
 * `voice` provides: healthz(), control(req), status(), pageStatus(), handleHook(),
 * handlePage(), createSession(); `sse` is the SseHub.
 */
export function createHttpServer({ voice, port, daemonKey, pageToken, pageSecret, redeemLaunchCode, webDir, sse, log, onControlAnswered, build = null }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const keyOk = (req) => safeEqual(req.headers["x-sotto-key"], daemonKey);
  const pageOk = (req, url) => safeEqual(req.headers["x-sotto-page"] || url.searchParams.get("token") || "", pageToken);

  async function handle(req, res) {
    // DNS-rebinding guard: only loopback Host headers with our port.
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) return err(res, 421, "bad_host");
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin !== undefined && !origins.has(origin)) return err(res, 403, "bad_origin");

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const method = req.method;

    let body;
    let bytes = 0;
    if (method === "POST") {
      let buf;
      try { buf = await readBody(req); } catch (e) { return err(res, e.status || 400, e.status === 413 ? "too_large" : "bad_request"); }
      bytes = buf.length;
      try { body = parseJson(buf); } catch { return err(res, 400, "bad_json"); }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return err(res, 400, "bad_json");
    }

    // ---- key routes ----
    if (p === "/healthz" && method === "GET") return send(res, 200, voice.healthz());
    if (p === "/control" && method === "POST") {
      if (!keyOk(req)) return err(res, 403, "bad_key");
      const r = voice.control(body);
      if (url.searchParams.get("format") === "hook") send(res, 200, { continue: false, stopReason: r.message });
      else send(res, 200, { ok: r.ok, state: r.state, message: r.message });
      onControlAnswered?.(body.action);
      return;
    }
    if (p === "/status" && method === "GET") {
      if (!keyOk(req)) return err(res, 403, "bad_key");
      return send(res, 200, voice.status());
    }
    const hook = /^\/hook\/([A-Za-z]+)$/.exec(p);
    if (hook && method === "POST") {
      if (!keyOk(req)) return err(res, 403, "bad_key");
      send(res, 204);
      const sock = req.headers["x-sotto-socket"];
      setImmediate(() => {
        try { voice.handleHook(hook[1], body, typeof sock === "string" ? sock : "", bytes); } catch (e) { log.error("hook.error", { event: hook[1], message: String(e && e.message) }); }
      });
      return;
    }

    // ---- page routes ----
    if (p === "/api/bootstrap" && method === "GET") {
      // The page token is handed out only to a page that proves the daemon
      // opened it: the window URL's fragment carries a one-time launch code
      // (#k=..., sent back as X-Sotto-Launch) which is traded here for
      // the persistent page secret (kept in sessionStorage, sent back as
      // X-Sotto-Boot on every later bootstrap). The Host check alone
      // only stops browsers; any local process can forge Host.
      if (pageSecret) {
        const boot = req.headers["x-sotto-boot"];
        const launch = req.headers["x-sotto-launch"];
        const ok = safeEqual(boot, pageSecret) || safeEqual(launch, pageSecret) || (typeof launch === "string" && !!redeemLaunchCode?.(launch));
        if (!ok) return err(res, 403, "bad_secret", "Open the voice window from Claude Code with /talk.");
      }
      // `build`: hash of web/ as this daemon loaded it. A page that sees it
      // change across a restart reloads itself to run the new page (§6.17).
      return send(res, 200, { page_token: pageToken, page_secret: pageSecret || null, version: VERSION, build, port, status: voice.pageStatus() });
    }
    if (p === "/api/events" && method === "GET") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      sse.add(req, res, { type: "status", status: voice.pageStatus() });
      return;
    }
    if (p === "/api/session" && method === "POST") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      try {
        const r = await voice.createSession(body);
        return send(res, r.status, r.body);
      } catch (e) {
        log.error("session.error", { message: String(e && e.message) });
        return err(res, 500, "internal", "Internal error creating the voice session");
      }
    }
    // Voice picker (§6.4, §6.14). Same page-token auth as the other /api routes.
    if (p === "/api/voices" && method === "GET") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      return send(res, 200, voice.voices());
    }
    if (p === "/api/voice" && method === "POST") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      const r = voice.setVoice(body.voice, "page");
      if (!r.ok) return err(res, 400, "bad_voice", r.message);
      return send(res, 200, { ok: true, voice: r.voice, switching: r.switching, message: r.message });
    }
    // API key setup (SPEC §4.3). Responses carry at most the key's last four characters.
    if (p === "/api/key" && method === "GET") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      return send(res, 200, voice.keyInfo());
    }
    if (p === "/api/key" && method === "POST") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      const r = await voice.saveKey(body.key);
      return send(res, r.status, r.body);
    }
    if (p === "/api/key/remove" && method === "POST") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      const r = voice.removeKey();
      return send(res, r.status, r.body);
    }
    if (p === "/api/page" && method === "POST") {
      if (!pageOk(req, url)) return err(res, 403, "bad_token");
      send(res, 204);
      setImmediate(() => { try { voice.handlePage(body); } catch (e) { log.error("page.error", { message: String(e && e.message) }); } });
      return;
    }

    // ---- static ----
    if (method === "GET" || method === "HEAD") {
      const name = p === "/" ? "index.html" : p.slice(1);
      if (!STATIC_RE.test(name)) return err(res, 404, "not_found");
      const file = path.join(webDir, name);
      let data;
      try { data = fs.readFileSync(file); } catch { return err(res, 404, "not_found"); }
      const ext = name.split(".").pop();
      return send(res, 200, method === "HEAD" ? "" : data, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    }
    return err(res, 404, "not_found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error("http.error", { message: String(e && e.message) });
      try { err(res, 500, "internal"); } catch { /* ignore */ }
    });
  });
  server.keepAliveTimeout = 5000;
  return server;
}
