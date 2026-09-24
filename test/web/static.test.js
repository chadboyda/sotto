// Static checks on web/ (SPEC §7.1, §11.3): module wiring, no external requests,
// and the page never starts a Live session itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const read = (name) => readFileSync(join(WEB, name), "utf8");

/** Remove comments so URLs in comments are allowed. */
function stripComments(name, src) {
  if (name.endsWith(".html") || name.endsWith(".svg")) return src.replace(/<!--[\s\S]*?-->/g, "");
  if (name.endsWith(".css")) return src.replace(/\/\*[\s\S]*?\*\//g, "");
  // JS: block comments, then line comments that are not inside a string (good enough
  // for our own sources, which never put "//" in strings except as URL schemes).
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("the five web files exist", () => {
  const files = readdirSync(WEB);
  for (const f of ["index.html", "app.js", "lib.js", "styles.css", "icon.svg"]) assert.ok(files.includes(f), f);
});

test("index.html loads app.js as a module and styles.css", () => {
  const html = read("index.html");
  assert.match(html, /<script\s+type="module"\s+src="app\.js"><\/script>/);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="styles\.css">/);
  assert.match(html, /<audio\s+id="remote-audio"\s+autoplay/);
  assert.match(html, /aria-live="polite"/);
});

test("no http(s):// URLs in web/ outside comments", () => {
  for (const name of readdirSync(WEB)) {
    let src = stripComments(name, read(name));
    // The SVG XML namespace is an identifier, not a request.
    if (name.endsWith(".svg")) src = src.replace('xmlns="http://www.w3.org/2000/svg"', "");
    assert.doesNotMatch(src, /https?:\/\//i, name);
  }
});

test("all asset references are relative", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.doesNotMatch(m[1], /^(\/\/|[a-z]+:)/i, m[1]);
  }
});

test("app.js never sends the Live start event", () => {
  const app = read("app.js");
  assert.ok(!app.includes('session.start"'), 'contains session.start"');
  assert.ok(!app.includes("session.start'"), "contains session.start'");
  assert.ok(!app.includes("session.start`"), "contains session.start`");
});

test("app.js uses the oai-events channel, the page header, and a persistent audio element", () => {
  const app = read("app.js");
  assert.ok(app.includes('createDataChannel("oai-events")'));
  assert.ok(app.includes('"X-Sotto-Page"'));
  // echoCancellation is true unless the echo test measured "all" better on this output (§7.7).
  assert.ok(app.includes("echoCancellation: aecSetting()"));
  assert.match(app, /return v === "all" \|\| v === "remote-only" \? v : true;/);
  assert.ok(app.includes("noiseSuppression: true"));
  assert.ok(app.includes("autoGainControl: true"));
  assert.ok(!/\.connect\([^)]*\.destination\b/.test(app), "no WebAudio playback path");
  assert.ok(app.includes('"clv.inputDeviceId"') && app.includes('"clv.outputDeviceId"'));
});

test("lib.js is DOM-free", () => {
  const lib = stripComments("lib.js", read("lib.js"));
  for (const word of ["document.", "window.", "navigator.", "fetch(", "localStorage"]) {
    assert.ok(!lib.includes(word), word);
  }
});

test("the voice meter reads an unplayed clone; nothing in web/ plays through WebAudio", () => {
  const app = read("app.js");
  assert.ok(app.includes("track.clone()"), "voice meter must meter a clone of the remote track");
  assert.ok(app.includes("el.audio.srcObject = new MediaStream([e.track])"), "the <audio> element plays the remote track");
  for (const name of ["app.js", "dial.js"]) {
    const src = stripComments(name, read(name));
    assert.ok(!/\.destination\b/.test(src), `${name}: no WebAudio playback path`);
  }
  // MediaStream destinations exist for exactly two things (§7.7): the echo
  // guard's track for the sender (never played) and the echo test's sound,
  // played by an <audio> element on the session's speaker (the echo
  // canceller's reference), never by the AudioContext.
  const app2 = stripComments("app.js", app);
  assert.equal((app2.match(/createMediaStreamDestination\(\)/g) || []).length, 2);
  assert.match(app2, /this\.processed = this\.dest\.stream\.getAudioTracks\(\)\[0\];/);
  assert.match(app2, /a\.srcObject = dest\.stream;/);
});

test("the page keeps one polite announcer and no live region on the caption stream", () => {
  const html = read("index.html");
  assert.match(html, /id="announcer" aria-live="polite"/);
  assert.doesNotMatch(html, /<ol id="captions"[^>]*aria-live/);
  // The mute button's name is stable; aria-pressed carries the state (AUDIT #12).
  assert.match(html, /id="mute-btn" aria-label="Mute" aria-pressed="false"/);
  assert.ok(!read("app.js").includes("Unmute microphone"));
});

test("a dial failure cannot take the page down (createDial is guarded)", () => {
  const app = stripComments("app.js", read("app.js"));
  assert.match(app, /try\s*\{\s*dial = createDial\(el\.dialCanvas\);\s*\}\s*catch/);
  assert.doesNotMatch(app, /const dial = createDial/);
  const dial = stripComments("dial.js", read("dial.js"));
  assert.match(dial, /if \(!box \|\| !ctx\) return nullDial\(\);/);
  assert.match(dial, /typeof g\.createConicGradient === "function"/);
});

test("the dial keeps a clear channel between the two voices", async () => {
  const { GEOMETRY: G } = await import("../../web/dial.js");
  const innerMax = G.inR + G.inRest + G.inMax;
  assert.ok(G.outR - innerMax >= 0.05, `channel ${(G.outR - innerMax).toFixed(3)} R`);
  assert.ok(G.outR + G.outRest + G.outMax < G.bezelR - G.bezelMajor + 0.01, "outer ring stays inside the bezel");
});

test("captions: no fade mask over live text, and no live region on the stream", () => {
  const css = stripComments("styles.css", read("styles.css"));
  assert.doesNotMatch(css, /\.captions\s*\{[^}]*mask-image/);
  const html = read("index.html");
  assert.match(html, /id="alert-announcer" role="alert"/);
});
