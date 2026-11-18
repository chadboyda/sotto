// daemon/port.js: the port fallback (SPEC §6.2 "Port fallback").
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PORT_FALLBACKS, lastPort, portFree, pickPort } from "../../daemon/port.js";
import { freePort } from "../helpers/daemon-harness.js";

test("47821 falls back to 47822..47830", () => {
  assert.equal(PORT_FALLBACKS, 9);
  assert.equal(lastPort(47821), 47830);
  assert.equal(lastPort(65530), 65535, "never past 65535");
});

test("pickPort: the setting when free, else the first free fallback, else null", async () => {
  const held = (set) => async (p) => !set.has(p);
  assert.equal(await pickPort(47821, { isFree: held(new Set()) }), 47821);
  assert.equal(await pickPort(47821, { isFree: held(new Set([47821])) }), 47822);
  assert.equal(await pickPort(47821, { isFree: held(new Set([47821, 47822, 47823])) }), 47824);
  const all = new Set(Array.from({ length: 10 }, (_, i) => 47821 + i));
  assert.equal(await pickPort(47821, { isFree: held(all) }), null);
  const tried = [];
  await pickPort(47821, { isFree: async (p) => { tried.push(p); return false; } });
  assert.deepEqual(tried, [...all]);
});

test("portFree: a real listener makes the port busy; closing frees it", async () => {
  const port = await freePort();
  assert.equal(await portFree(port), true);
  const srv = net.createServer().listen(port, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  try {
    assert.equal(await portFree(port), false);
    assert.equal(await pickPort(port, { fallbacks: 0 }), null);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.equal(await portFree(port), true);
});
