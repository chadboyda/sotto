// Manifest / packaging checks for the plugin shell (SPEC §5.1-§5.4, §11.1),
// plus lib.sh unit checks.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, baseEnv, tempDir, rmDir } from "./helpers/run.js";

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const hasClaude = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

describe("manifests", () => {
  test("plugin.json: name, schema, userConfig defaults", () => {
    const m = JSON.parse(read(".claude-plugin/plugin.json"));
    assert.equal(m.name, "sotto");
    assert.ok(m.$schema);
    assert.deepEqual(Object.keys(m.userConfig), ["voice", "port", "idle_seconds", "idle_minutes", "wake_sensitivity", "speaking_policy", "daily_cap_minutes", "window"]);
    assert.equal(m.userConfig.idle_seconds.default, 60);
    assert.deepEqual(m.userConfig.wake_sensitivity.options, ["off", "low", "medium", "high"]);
    assert.equal(m.userConfig.window.default, "auto");
    assert.deepEqual(m.userConfig.window.options, ["auto", "app", "chrome", "default"]);
    assert.equal(m.userConfig.voice.default, "marin");
    assert.equal(m.userConfig.voice.options.length, 22);
    assert.equal(m.userConfig.port.default, 47821);
  });

  test("marketplace.json: source ./", () => {
    const m = JSON.parse(read(".claude-plugin/marketplace.json"));
    assert.equal(m.plugins[0].source, "./");
    assert.equal(m.plugins[0].name, "sotto");
  });

  test("hooks.json: exec form everywhere, no ${user_config", () => {
    const raw = read("hooks/hooks.json");
    assert.ok(!raw.includes("${user_config"));
    const { hooks } = JSON.parse(raw);
    assert.deepEqual(Object.keys(hooks).sort(), ["Elicitation", "MessageDisplay", "Notification", "PermissionRequest", "PostToolUseFailure", "PreToolUse", "SessionEnd", "Stop", "StopFailure", "SubagentStop", "TaskCompleted", "TeammateIdle", "UserPromptExpansion", "UserPromptSubmit"]);
    for (const [ev, groups] of Object.entries(hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          assert.equal(h.type, "command", ev);
          assert.ok(Array.isArray(h.args), `${ev} has args`);
          if (ev !== "UserPromptExpansion") assert.deepEqual(h.args, [ev]);
        }
      }
    }
    assert.equal(hooks.UserPromptExpansion[0].matcher, "^sotto:talk$");
    // Forward-only notification events have no matcher: every type reaches the daemon.
    for (const ev of ["Notification", "Elicitation", "SubagentStop", "TaskCompleted", "TeammateIdle", "PostToolUseFailure"]) {
      assert.equal(hooks[ev].length, 1, ev);
      assert.equal(hooks[ev][0].matcher, undefined, ev);
      assert.ok(hooks[ev][0].hooks[0].timeout <= 5, ev);
    }
  });

  test("SKILL.md frontmatter", () => {
    const s = read("skills/talk/SKILL.md");
    assert.match(s, /^---\nname: talk\n/);
    assert.match(s, /\ndisable-model-invocation: true\n/);
    assert.match(s, /\nargument-hint: "\[on\|off\|status\|restart\|quiet\|milestones\|walkthrough\|voice \[name\]\]"\n/);
    assert.ok(!/allowed-tools/.test(s));
    assert.ok(!/!`/.test(s), "no inline bash");
  });

  test("voice-context.txt: one line, no quote, backslash or inner newline", () => {
    const t = read("scripts/voice-context.txt");
    assert.ok(t.endsWith("\n"));
    const body = t.slice(0, -1);
    assert.ok(!/["\\\n\r]/.test(body));
    assert.ok(body.startsWith("The message that starts with @MARKER@ "), "hook.sh substitutes the per-bind marker");
  });

  test("scripts are executable", () => {
    for (const s of ["scripts/hook.sh", "scripts/toggle.sh", "bin/sotto"]) {
      assert.ok(statSync(join(ROOT, s)).mode & 0o100, s);
    }
  });

  test("claude plugin validate --strict", { skip: !hasClaude && "claude not on PATH" }, () => {
    // The root validates marketplace.json; the manifest path validates the
    // plugin itself (plugin.json, hooks, skills).
    for (const target of [ROOT, join(ROOT, ".claude-plugin/plugin.json")]) {
      const r = spawnSync("claude", ["plugin", "validate", target, "--strict"], { encoding: "utf8", timeout: 60000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
  });

  test("optional: claude -p /sotto:talk status makes no model turn",
    { skip: process.env.SOTTO_TEST_CLAUDE !== "1" && "set SOTTO_TEST_CLAUDE=1" }, () => {
      const D = tempDir();
      try {
        const out = execFileSync("claude", ["-p", "--plugin-dir", ROOT, "--output-format", "json", "/sotto:talk status"], {
          encoding: "utf8", timeout: 120000, cwd: D,
        });
        const j = JSON.parse(out);
        assert.match(JSON.stringify(j), /sotto: voice is off\./);
        assert.equal(j.num_turns, 0);
      } finally {
        rmDir(D);
      }
    });
});

describe("lib.sh", () => {
  // Run a lib.sh function under macOS /bin/bash 3.2 with args passed as argv.
  const lib = (fn, args = [], env = {}) =>
    execFileSync("/bin/bash", ["-c", `. "$0"; ${fn} "$@"`, join(ROOT, "scripts/lib.sh"), ...args], {
      encoding: "utf8", env: baseEnv(env),
    });

  test("json_escape round-trips through JSON.parse", () => {
    const samples = ["plain", 'q"uote', "back\\slash", "nl\nx", "cr\rtab\t", "ctl\u0001\u001f!", "/tmp/a b/é", ""];
    for (const s of samples) {
      const esc = lib("json_escape", [s]);
      assert.equal(JSON.parse(`"${esc}"`), s, JSON.stringify(s));
      const viaV = execFileSync("/bin/bash", ["-c", `. "$0"; json_escape -v OUT "$1"; printf '%s' "$OUT"`, join(ROOT, "scripts/lib.sh"), s], { encoding: "utf8" });
      assert.equal(viaV, esc);
    }
  });

  test("clv_data_dir", () => {
    assert.equal(lib("clv_data_dir", [], { CLAUDE_PLUGIN_DATA: "/x/y" }), "/x/y");
    assert.equal(lib("clv_data_dir", [], { CLAUDE_PLUGIN_DATA: "", HOME: "/h" }), "/h/.sotto");
  });

  test("clv_read_active", () => {
    const D = tempDir();
    try {
      const f = `clv_read_active "$1" && printf '%s|%s|%s' "$CLV_OWNER" "$CLV_PORT" "$CLV_KEY"`;
      const call = () => spawnSync("/bin/bash", ["-c", `. "$0"; ${f}`, join(ROOT, "scripts/lib.sh"), D], { encoding: "utf8" });
      assert.equal(call().status, 1);
      execFileSync("/bin/sh", ["-c", `printf '/tmp/s.sock\\t47821\\tabc\\n' > "$0/active"`, D]);
      const r = call();
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "/tmp/s.sock|47821|abc");
    } finally {
      rmDir(D);
    }
  });
});
