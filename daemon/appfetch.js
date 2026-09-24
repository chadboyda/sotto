// Release download of the Sotto desktop app (SPEC §6.16 "Release download").
//
// Users should not need Xcode: when the app bundle is missing or stale, the
// daemon first runs this file detached (`node daemon/appfetch.js ...`), which
// downloads the signed, notarized build of this plugin version from the
// GitHub release, verifies it, and installs it into D/app exactly where
// scripts/build-app.sh would. Any failure falls back to that local build
// (then Chrome, as before). Nothing here runs inside /control or a hook.
//
// A release is adopted only when all of these hold:
//   1. sha256 of Sotto.zip equals the published Sotto.zip.sha256;
//   2. the zip holds exactly Sotto.app, and before unpacking every entry is a
//      plain file or directory under Sotto.app/ (no `..`, absolute paths or
//      symlinks), so a crafted archive cannot write outside the staging dir;
//   3. Contents/Resources/sotto-source.json has this plugin's app sources hash
//      (a release built from other sources, e.g. a locally edited app/, is
//      never used: the local build runs instead);
//   4. codesign --verify --deep --strict against a Developer ID requirement
//      pinned to team 6M6D2W72ZB and the bundle id;
//   5. spctl (Gatekeeper) accepts it as "Notarized Developer ID".
// The sha256 file comes from the same place as the zip, so (1) only catches
// corruption; (4) and (5) are what make a tampered download fail.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RELEASE_BASE = "https://github.com/chadboyda/sotto/releases/download";
export const ZIP_NAME = "Sotto.zip";
export const SHA_NAME = "Sotto.zip.sha256";
export const TEAM_ID = "6M6D2W72ZB";
export const BUNDLE_ID = "com.chadboyda.sotto";
/**
 * Designated-requirement check for a Developer ID Application signature of
 * our team: Apple anchor, the Developer ID intermediate (…6.2.6), the
 * Developer ID Application leaf (…6.1.13), our team as the leaf's OU.
 */
export const REQUIREMENT = `anchor apple generic and identifier "${BUNDLE_ID}"`
  + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
  + " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
  + ` and certificate leaf[subject.OU] = "${TEAM_ID}"`;
/** A universal build zips to about 2 MB; anything near this is not ours. */
export const MAX_ZIP_BYTES = 64 * 1024 * 1024;
/** A failed download of the same version and sources is retried after this. */
export const RETRY_MS = 24 * 60 * 60 * 1000;
export const DOWNLOAD_STAMP = "download.json";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function releaseUrls(version, base = RELEASE_BASE) {
  const b = String(base || RELEASE_BASE).replace(/\/+$/, "");
  return { zip: `${b}/v${version}/${ZIP_NAME}`, sha: `${b}/v${version}/${SHA_NAME}` };
}

/** The plugin version from .claude-plugin/plugin.json, or null. */
export function pluginVersion(pluginRoot, fsImpl = fs) {
  try {
    const v = JSON.parse(fsImpl.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** `shasum -a 256` output ("<hex>  Sotto.zip") or a bare hex digest → lowercase hex, else null. */
export function parseShaFile(text) {
  const m = /^\s*([0-9a-fA-F]{64})(?:\s+\*?(\S+))?\s*$/.exec(String(text).split("\n").find((l) => l.trim()) || "");
  if (!m) return null;
  if (m[2] && path.basename(m[2]) !== ZIP_NAME) return null;
  return m[1].toLowerCase();
}

export function readDownloadStamp(dir, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(path.join(dir, DOWNLOAD_STAMP), "utf8")); } catch { return null; }
}

/**
 * Try the release for this version and sources? Once per version + sources
 * hash: a mismatch is final, another failure is retried after RETRY_MS. A
 * past success means the bundle went missing since, so fetch it again.
 */
export function shouldDownload({ stamp, version, hash, now = Date.now() }) {
  if (!version || !hash) return false;
  if (!stamp || stamp.version !== version || stamp.hash !== hash) return true;
  if (stamp.ok === true) return true;
  if (stamp.permanent === true) return false;
  const at = Date.parse(stamp.at);
  return !Number.isFinite(at) || now - at >= RETRY_MS;
}

class FetchError extends Error {
  constructor(reason, message, permanent = false) { super(message || reason); this.reason = reason; this.permanent = permanent; }
}

async function fetchBytes(url, { fetchImpl, maxBytes, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new FetchError("network", `${url}: ${e.message}`);
  }
  if (!res.ok) throw new FetchError(res.status === 404 ? "not_found" : "http", `${url}: HTTP ${res.status}`);
  const len = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(len) && len > maxBytes) throw new FetchError("too_large", `${url}: ${len} bytes`);
  const chunks = [];
  let total = 0;
  try {
    for await (const c of res.body) {
      total += c.length;
      if (total > maxBytes) throw new FetchError("too_large", `${url}: over ${maxBytes} bytes`);
      chunks.push(Buffer.from(c));
    }
  } catch (e) {
    if (e instanceof FetchError) throw e;
    throw new FetchError("network", `${url}: ${e.message}`);
  }
  return Buffer.concat(chunks);
}

/** More entries than any Sotto.app zip has (13 today). */
export const MAX_ZIP_ENTRIES = 2000;

/**
 * The entries of a zip from its central directory: [{name, mode}] with the
 * unix mode from the external attributes (0 when made on another OS).
 * Throws on anything we do not produce (zip64, multi-disk, truncation).
 */
export function zipEntries(buf) {
  const min = 22;
  let eocd = -1;
  for (let i = buf.length - min; i >= Math.max(0, buf.length - min - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12), off = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || count === 0xffff || off === 0xffffffff) throw new Error("multi-disk or zip64 archive");
  if (count > MAX_ZIP_ENTRIES) throw new Error(`${count} entries`);
  if (off + size > eocd) throw new Error("central directory out of bounds");
  const out = [];
  let p = off;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    if (p + 46 + nameLen > eocd) throw new Error("bad central directory entry");
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, mode: madeBy === 3 ? (ext >>> 16) : 0 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;

/**
 * Refuse a zip before ditto unpacks it unless every entry is a plain file or
 * directory under Sotto.app/ (or ditto's __MACOSX/ sidecar): no absolute or
 * `..` paths, no backslashes or control characters, no symlinks or devices.
 * The signature checks run only after unpacking, so this is what keeps a
 * crafted archive from writing outside the staging directory.
 * Returns null when fine, else the reason.
 */
export function zipEntryProblem(entries) {
  for (const { name, mode } of entries) {
    if (!name || name.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(name)) return `bad name ${JSON.stringify(name).slice(0, 120)}`;
    const parts = name.replace(/\/$/, "").split("/");
    if (parts.some((s) => s === ".." || s === "." || s === "")) return `bad path ${JSON.stringify(name).slice(0, 120)}`;
    if (parts[0] !== "Sotto.app" && parts[0] !== "__MACOSX") return `unexpected entry ${JSON.stringify(name).slice(0, 120)}`;
    const type = mode & S_IFMT;
    if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return `not a plain file ${JSON.stringify(name).slice(0, 120)}`;
  }
  return null;
}

/** Any symlink or special file under `dir` (after unpacking), else null. */
function specialFileUnder(dir, fsImpl) {
  for (const e of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = specialFileUnder(p, fsImpl); if (r) return r; } else if (!e.isFile()) return p;
  }
  return null;
}

const run = (execFile, cmd, args, timeout = 60_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: `${stdout || ""}${stderr || ""}` });
  });
});

/**
 * Signature checks on an unpacked bundle: {ok, reason?, detail?}.
 * `spctl` consults the stapled ticket (or Apple, online) for notarization.
 */
export async function verifyApp(bundle, { execFile = execFileCb } = {}) {
  const cs = await run(execFile, "/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${REQUIREMENT}`, bundle]);
  if (cs.code !== 0) return { ok: false, reason: "codesign", detail: cs.out.trim().slice(0, 400) };
  const gk = await run(execFile, "/usr/sbin/spctl", ["--assess", "-vv", "--type", "execute", bundle]);
  if (gk.code !== 0) return { ok: false, reason: "gatekeeper", detail: gk.out.trim().slice(0, 400) };
  if (!/source=Notarized Developer ID/.test(gk.out)) return { ok: false, reason: "not_notarized", detail: gk.out.trim().slice(0, 400) };
  if (!gk.out.includes(`(${TEAM_ID})`)) return { ok: false, reason: "team", detail: gk.out.trim().slice(0, 400) };
  return { ok: true, detail: gk.out.trim().slice(0, 400) };
}

/**
 * Download, verify and install the release into outDir (…/Sotto.app plus a
 * build.json stamp that daemon/window.js reads as `ready`). Never throws:
 * returns {ok, reason?, permanent?, message?}. Records the outcome in
 * outDir/download.json.
 */
export async function installRelease({
  outDir, version, hash, base = RELEASE_BASE, fetchImpl = globalThis.fetch, execFile = execFileCb,
  verify = (b) => verifyApp(b, { execFile }), log = () => {}, now = () => Date.now(), fsImpl = fs,
  timeoutMs = 180_000,
}) {
  const at = () => new Date(now()).toISOString();
  const record = (r) => {
    try {
      fsImpl.writeFileSync(path.join(outDir, DOWNLOAD_STAMP), `${JSON.stringify({ version, hash, ok: r.ok, reason: r.reason ?? null, permanent: !!r.permanent, at: at() })}\n`);
    } catch { /* best effort */ }
    return r;
  };
  if (!version || !VERSION_RE.test(version)) return { ok: false, reason: "no_version", permanent: true };
  if (!/^[0-9a-f]{64}$/.test(String(hash))) return { ok: false, reason: "no_hash", permanent: true };
  try { fsImpl.mkdirSync(outDir, { recursive: true, mode: 0o700 }); } catch (e) { return { ok: false, reason: "mkdir", message: e.message }; }
  const stage = path.join(outDir, `.dl.${process.pid}`);
  const urls = releaseUrls(version, base);
  const t0 = now();
  try {
    fsImpl.rmSync(stage, { recursive: true, force: true });
    fsImpl.mkdirSync(stage, { mode: 0o700 });
    log("download_start", { version, url: urls.zip });
    const want = parseShaFile((await fetchBytes(urls.sha, { fetchImpl, maxBytes: 4096, timeoutMs: 30_000 })).toString("utf8"));
    if (!want) throw new FetchError("bad_sha_file");
    const zip = await fetchBytes(urls.zip, { fetchImpl, maxBytes: MAX_ZIP_BYTES, timeoutMs });
    const got = createHash("sha256").update(zip).digest("hex");
    if (got !== want) throw new FetchError("sha256_mismatch", `expected ${want}, got ${got}`);
    let listed;
    try { listed = zipEntries(zip); } catch (e) { throw new FetchError("bad_zip", e.message); }
    const problem = zipEntryProblem(listed);
    if (problem) throw new FetchError("bad_zip", problem);
    const zipPath = path.join(stage, ZIP_NAME);
    fsImpl.writeFileSync(zipPath, zip, { mode: 0o600 });
    const unpack = path.join(stage, "x");
    const dx = await run(execFile, "/usr/bin/ditto", ["-x", "-k", zipPath, unpack]);
    if (dx.code !== 0) throw new FetchError("unzip", dx.out.trim().slice(0, 300));
    const special = specialFileUnder(unpack, fsImpl);
    if (special) throw new FetchError("bad_zip", `not a plain file: ${path.relative(unpack, special)}`);
    const entries = fsImpl.readdirSync(unpack).filter((n) => n !== "__MACOSX");
    if (entries.length !== 1 || entries[0] !== "Sotto.app") throw new FetchError("bad_zip", `entries: ${entries.join(", ")}`);
    const bundle = path.join(unpack, "Sotto.app");
    if (!fsImpl.lstatSync(bundle).isDirectory()) throw new FetchError("bad_zip", "Sotto.app is not a directory");
    let meta = null;
    try { meta = JSON.parse(fsImpl.readFileSync(path.join(bundle, "Contents", "Resources", "sotto-source.json"), "utf8")); } catch { /* checked below */ }
    if (!meta || meta.hash !== hash) {
      throw new FetchError("sources_mismatch", `release built from ${meta?.hash ?? "unknown"} sources, plugin has ${hash}`, true);
    }
    const v = await verify(bundle);
    if (!v?.ok) throw new FetchError(v?.reason || "verify", v?.detail);
    // Swap in, as build-app.sh does. A running app keeps its mapped binary.
    const dest = path.join(outDir, "Sotto.app");
    fsImpl.rmSync(`${dest}.old`, { recursive: true, force: true });
    if (fsImpl.existsSync(dest)) fsImpl.renameSync(dest, `${dest}.old`);
    fsImpl.renameSync(bundle, dest);
    fsImpl.rmSync(`${dest}.old`, { recursive: true, force: true });
    fsImpl.writeFileSync(path.join(outDir, "build.json"), `${JSON.stringify({
      hash, ok: true, at: at(), seconds: Math.round((now() - t0) / 1000), source: "release", version,
      identity: `Developer ID Application (${TEAM_ID})`, sha256: got,
    })}\n`);
    log("download_ok", { version, bytes: zip.length, ms: now() - t0 });
    return record({ ok: true });
  } catch (e) {
    const r = { ok: false, reason: e.reason || "error", permanent: !!e.permanent, message: String(e.message || e).slice(0, 400) };
    log("download_failed", r);
    return record(r);
  } finally {
    try { fsImpl.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/**
 * CLI (spawned detached by daemon/window.js, stdio to logs/app-build.log):
 *   node daemon/appfetch.js --out DIR --plugin-root ROOT --hash HEX [--base URL] [--no-build]
 * Holds DIR/build.lock while downloading (the chooser then sees `building`),
 * releases it, and on failure runs scripts/build-app.sh unless --no-build.
 */
export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--no-build") a.noBuild = true;
    else if (["--out", "--plugin-root", "--hash", "--base"].includes(k)) a[k.slice(2)] = argv[++i];
    else { console.error(`appfetch: unknown argument ${k}`); return 2; }
  }
  if (!a.out || !a["plugin-root"] || !a.hash) { console.error("appfetch: --out, --plugin-root and --hash are required"); return 2; }
  const outDir = path.resolve(a.out);
  const root = path.resolve(a["plugin-root"]);
  const lock = path.join(outDir, "build.lock");
  const say = (ev, o = {}) => console.log(`appfetch: ${ev} ${JSON.stringify(o)}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let other = NaN;
  try { other = Number(fs.readFileSync(lock, "utf8").trim()); } catch { /* none */ }
  if (other !== process.pid && pidAlive(other)) { say("busy", { pid: other }); return 3; }
  fs.writeFileSync(lock, `${process.pid}\n`);
  let r;
  try {
    r = await installRelease({ outDir, version: pluginVersion(root), hash: a.hash, base: a.base || RELEASE_BASE, fetchImpl, log: say });
  } finally {
    try { if (Number(fs.readFileSync(lock, "utf8").trim()) === process.pid) fs.rmSync(lock); } catch { /* ignore */ }
  }
  if (r.ok) return 0;
  if (a.noBuild) return 1;
  const script = path.join(root, "scripts", "build-app.sh");
  if (!fs.existsSync(script)) return 1;
  say("local_build", {});
  const b = spawnSync("/bin/bash", [script, "--out", outDir, "--quiet"], { stdio: "inherit" });
  return b.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`appfetch: ${e?.stack || e}`); process.exit(1); });
}
