import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatMoney, usageToday } from "../../daemon/format.js";
import * as web from "../../web/lib.js";

test("usageToday reads like a person would say it", () => {
  assert.equal(usageToday(0), "0 min today ($0.00)");
  assert.equal(usageToday(20), "under a minute today ($0.02)");
  assert.equal(usageToday(1872), "31 min today ($1.56)");
  assert.equal(usageToday(3900), "1 hr 5 min today ($3.25)");
  assert.equal(usageToday(7200), "2 hr today ($6.00)");
  assert.equal(usageToday(NaN), "0 min today ($0.00)");
  assert.equal(formatMoney(0.001), "<$0.01");
});

test("daemon and page format durations and money the same way", () => {
  for (const s of [0, 0.4, 5, 59.9, 60, 61, 90, 852, 3599, 3600, 3660, 3900, 7200, 86_399, -3, NaN]) {
    assert.equal(formatDuration(s), web.formatDuration(s), `duration ${s}`);
    assert.equal(formatMoney((s / 60) * 0.05), web.formatCost(s), `money ${s}`);
  }
});
