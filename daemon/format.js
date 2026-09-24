// Human-readable usage for the /talk status and off lines (SPEC §9.2 `<m> min today`,
// SPEC-DEVIATIONS "Voice window redesign" 16). Pure. Mirrors web/lib.js
// formatDuration/formatMoney; test/daemon/format.test.js keeps the two in step.

/** 0 -> "0 min", 1..59 s -> "under a minute", 14 min -> "14 min", 65 min -> "1 hr 5 min", 120 min -> "2 hr". */
export function formatDuration(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (s === 0) return "0 min";
  if (s < 60) return "under a minute";
  const total = Math.floor(s / 60 + 1e-9);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** "$0.71"; a non-zero amount under half a cent reads "<$0.01". */
export function formatMoney(dollars) {
  const d = Number.isFinite(dollars) && dollars > 0 ? dollars : 0;
  if (d > 0 && d < 0.005) return "<$0.01";
  return `$${(Math.round((d + Number.EPSILON) * 100 + 1e-7) / 100).toFixed(2)}`;
}

/** "31 min today ($1.56)" for billed seconds at `pricePerMinute`. */
export function usageToday(seconds, pricePerMinute = 0.05) {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return `${formatDuration(s)} today (${formatMoney((s / 60) * pricePerMinute)})`;
}
