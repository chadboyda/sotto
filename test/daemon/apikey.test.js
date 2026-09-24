// API key sources, Keychain store and validation (SPEC §4.3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveApiKeyInfo } from "../../daemon/config.js";
import { normalizeKeyInput, keyHint, keyWhere, createKeychain, KeyStore, validateKey, KEY_RE } from "../../daemon/apikey.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sotto-key-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// Test keys: never sk-proj- + 20 chars (the pre-commit scan blocks those).
const K1 = "sk-test-" + "a1B2c3D4e5F6g7H8i9J0_-wxyz";
const K2 = "sk-svcacct-" + "Z9y8X7w6V5u4T3s2R1q0-abcd";

test("normalizeKeyInput accepts pasted keys and .env lines, rejects the rest", () => {
  assert.equal(normalizeKeyInput(`  ${K1}\n`), K1);
  assert.equal(normalizeKeyInput(`"${K1}"`), K1);
  assert.equal(normalizeKeyInput(`OPENAI_API_KEY=${K1}`), K1);
  assert.equal(normalizeKeyInput(`export OPENAI_API_KEY='${K1}'`), K1);
  for (const bad of ["", "sk-short", "pk-" + "x".repeat(30), `${K1} extra`, `${K1}"; rm -rf ~`, null, 42, "sk-" + "x".repeat(500)]) {
    assert.equal(normalizeKeyInput(bad), null, String(bad));
  }
  assert.ok(KEY_RE.test(K2));
});

test("keyHint is the last four characters only", () => {
  assert.equal(keyHint(K1), "wxyz");
  assert.equal(keyHint("short"), null);
  assert.equal(keyHint(null), null);
});

test("resolveApiKeyInfo reports the source and the .env file", () => {
  const root = tmp(); const data = tmp(); const home = tmp();
  assert.equal(resolveApiKeyInfo({ env: {}, pluginRoot: root, dataDir: data, home }), null);
  fs.writeFileSync(path.join(data, ".env"), `OPENAI_API_KEY=${K2}\n`);
  assert.deepEqual(resolveApiKeyInfo({ env: {}, pluginRoot: root, dataDir: data, home }), { key: K2, source: "dotenv", file: path.join(data, ".env") });
  assert.deepEqual(resolveApiKeyInfo({ env: { OPENAI_API_KEY: ` ${K1} ` }, pluginRoot: root, dataDir: data, home }), { key: K1, source: "env", file: null });
});

test("KeyStore order: env > .env > Keychain > userConfig", () => {
  const root = tmp(); const data = tmp(); const home = tmp();
  const kc = createFakeKeychain();
  const store = new KeyStore({ env: {}, pluginRoot: root, dataDir: data, home, keychain: kc, userConfigKey: ` ${K2} ` });
  assert.deepEqual(store.current(), { key: K2, source: "user_config", file: null });
  let info = store.info();
  assert.deepEqual([info.present, info.source, info.hint, info.can_change, info.can_remove], [true, "user_config", "abcd", true, false]);

  assert.deepEqual(store.save(K1), { ok: true });
  assert.equal(store.current().source, "keychain");
  info = store.info();
  assert.deepEqual([info.hint, info.can_change, info.can_remove, info.label], ["wxyz", true, true, "the macOS Keychain"]);
  assert.ok(!JSON.stringify(info).includes(K1), "info never holds the key");

  fs.writeFileSync(path.join(root, ".env"), `OPENAI_API_KEY=${K2}\n`);
  info = store.info();
  assert.deepEqual([info.source, info.file, info.can_change, info.can_remove], ["dotenv", path.join(root, ".env"), false, false]);
  assert.equal(keyWhere(info), path.join(root, ".env"));

  const envStore = new KeyStore({ env: { OPENAI_API_KEY: K1 }, pluginRoot: root, keychain: kc });
  assert.equal(envStore.current().source, "env");
  assert.equal(keyWhere(envStore.info()), "the OPENAI_API_KEY environment variable");

  fs.rmSync(path.join(root, ".env"));
  assert.equal(store.remove().ok, true);
  assert.equal(store.current().source, "user_config");
});

test("KeyStore reads the Keychain once, then on refresh()", () => {
  const kc = createFakeKeychain({ key: K1 });
  let reads = 0;
  const counting = { ...kc, get() { reads++; return kc.get(); } };
  const store = new KeyStore({ env: {}, home: tmp(), keychain: counting });
  assert.equal(store.key(), K1);
  assert.equal(store.key(), K1);
  assert.equal(reads, 1);
  kc.key = null;
  assert.equal(store.key(), K1, "cached until refresh");
  store.refresh();
  assert.equal(store.key(), null);
  assert.equal(store.info().present, false);
  assert.equal(store.info().can_change, true);
});

test("KeyStore without a Keychain cannot store keys", () => {
  const store = new KeyStore({ env: {}, home: tmp(), keychain: createFakeKeychain({ available: false }) });
  const info = store.info();
  assert.deepEqual([info.present, info.keychain, info.can_change, info.can_remove], [false, false, false, false]);
});

/** A fake /usr/bin/security: stores items in a file, logs its argv (and nothing from stdin). */
function fakeSecurity() {
  const dir = tmp();
  const bin = path.join(dir, "security");
  fs.writeFileSync(bin, `#!/bin/bash
DIR="${dir}"
printf '%s\\n' "$*" >> "$DIR/argv.log"
item() { printf '%s' "$DIR/item-$1-$2"; }
# "find-generic-password ... -w" ends with a bare -w: shift 1 there, not 2.
sh2() { N=2; [[ $# -lt 2 ]] && N=1; }
parse() { S=""; A=""; W=""; while [[ $# -gt 0 ]]; do sh2 "$@"; case "$1" in -s) S=$2;; -a) A=$2;; -w) W=\${2-};; -l) ;; *) N=1;; esac; shift $N; done; }
case "$1" in
  -i)
    while IFS= read -r line; do
      eval "set -- $line"
      [[ "$1" == add-generic-password ]] || exit 1
      shift; parse "$@"
      printf '%s' "$W" > "$(item "$S" "$A")"
    done ;;
  find-generic-password) shift; parse "$@"; f="$(item "$S" "$A")"; [[ -f "$f" ]] || exit 44; cat "$f"; echo ;;
  delete-generic-password) shift; parse "$@"; f="$(item "$S" "$A")"; [[ -f "$f" ]] || exit 44; rm -f "$f" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return { bin, dir, argv: () => { try { return fs.readFileSync(path.join(dir, "argv.log"), "utf8"); } catch { return ""; } } };
}

test("createKeychain drives security; the key never appears in argv", () => {
  const f = fakeSecurity();
  const kc = createKeychain({ env: { SOTTO_SECURITY_BIN: f.bin }, platform: "linux" });
  assert.equal(kc.available, true);
  assert.equal(kc.get(), null);
  assert.deepEqual(kc.set(K1), { ok: true });
  assert.equal(kc.get(), K1);
  assert.deepEqual(kc.set(K2), { ok: true }, "replaces");
  assert.equal(kc.get(), K2);
  assert.equal(kc.set("not a key").ok, false);
  assert.deepEqual(kc.remove(), { ok: true, removed: true });
  assert.equal(kc.get(), null);
  assert.equal(kc.remove().removed, false);
  const argv = f.argv();
  assert.match(argv, /^-i$/m);
  assert.match(argv, /find-generic-password -s sotto -a openai-api-key -w/);
  assert.ok(!argv.includes(K1) && !argv.includes(K2), "argv never carries the key");
});

test("createKeychain is unavailable off macOS and when disabled", () => {
  assert.equal(createKeychain({ env: {}, platform: "linux" }).available, false);
  assert.equal(createKeychain({ env: { SOTTO_KEYCHAIN: "0" }, platform: "darwin" }).available, false);
  const off = createKeychain({ env: {}, platform: "linux" });
  assert.equal(off.get(), null);
  assert.equal(off.set(K1).ok, false);
});

test("createKeychain reports a failed write (security -i exits 0 anyway)", () => {
  const dir = tmp();
  const bin = path.join(dir, "security");
  fs.writeFileSync(bin, "#!/bin/bash\ncat >/dev/null; [[ \"$1\" == -i ]] && exit 0; exit 44\n", { mode: 0o755 });
  const kc = createKeychain({ bin, env: {}, platform: "darwin" });
  const r = kc.set(K1);
  assert.equal(r.ok, false);
  assert.ok(!r.message.includes(K1));
});

test("real macOS Keychain round trip with a temporary service", { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/security") ? "macOS only" : false }, (t) => {
  const service = `sotto-test-${process.pid}-${randomBytes(4).toString("hex")}`;
  t.after(() => spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", "openai-api-key"], { stdio: "ignore" }));
  const kc = createKeychain({ env: { SOTTO_KEYCHAIN_SERVICE: service } });
  assert.equal(kc.service, service);
  assert.equal(kc.get(), null);
  const set = kc.set(K1);
  if (!set.ok) return t.skip(`Keychain not writable here: ${set.message}`);
  assert.equal(kc.get(), K1);
  assert.deepEqual(kc.set(K2), { ok: true });
  assert.equal(kc.get(), K2);
  assert.deepEqual(kc.remove(), { ok: true, removed: true });
  assert.equal(kc.get(), null);
});

/** fetch fake: routes by path to [status, body]. */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, method: init.method });
    const p = new URL(url).pathname.replace(/^\/v1/, "");
    const r = routes[p];
    if (r instanceof Error) throw r;
    if (!r) return { status: 404, text: async () => "{}" };
    return { status: r[0], text: async () => JSON.stringify(r[1]) };
  };
}
const BASE = "https://api.example.test/v1";
const LIST = (...ids) => [200, { object: "list", data: ids.map((id) => ({ id, object: "model" })) }];

test("validateKey: accepted key with gpt-live-1", async () => {
  const calls = [];
  const r = await validateKey({ base: BASE, key: K1, fetchImpl: fakeFetch({ "/models": LIST("gpt-4o", "gpt-live-1") }, calls) });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [{ url: `${BASE}/models`, auth: `Bearer ${K1}`, method: "GET" }]);
});

test("validateKey: error codes and our own messages", async () => {
  const cases = [
    [{ "/models": LIST("gpt-4o") }, "no_model_access"],
    [{ "/models": [401, { error: { message: `Incorrect API key provided: ${K1.slice(0, 8)}***wxyz` } }] }, "invalid_key"],
    [{ "/models": [403, {}], "/models/gpt-live-1": [403, {}] }, "key_forbidden"],
    [{ "/models": [403, {}], "/models/gpt-live-1": [404, {}] }, "no_model_access"],
    [{ "/models": [429, {}] }, "rate_limited"],
    [{ "/models": [500, {}] }, "openai_error"],
    [{ "/models": new TypeError("fetch failed") }, "network"],
  ];
  for (const [routes, code] of cases) {
    const r = await validateKey({ base: BASE, key: K1, fetchImpl: fakeFetch(routes) });
    assert.equal(r.ok, false, code);
    assert.equal(r.code, code);
    assert.ok(r.message && !r.message.includes("wxyz") && !r.message.includes(K1), `${code}: message never echoes the key`);
  }
  // A restricted key that cannot list models but can read gpt-live-1 is fine.
  assert.deepEqual(await validateKey({ base: BASE, key: K1, fetchImpl: fakeFetch({ "/models": [403, {}], "/models/gpt-live-1": [200, { id: "gpt-live-1" }] }) }), { ok: true });
});

test("validateKey: times out", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await validateKey({ base: BASE, key: K1, fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.code, "network");
  assert.match(r.message, /did not answer in time/);
});
