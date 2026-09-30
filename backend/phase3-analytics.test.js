// Unit tests for Phase 3 pure helpers (isoWeekKey, coerceDurationMinutes).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P3 HELPERS START =====";
const endMarker = "// ===== P3 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers + "\nreturn { isoWeekKey, coerceDurationMinutes };"
);
const { isoWeekKey, coerceDurationMinutes } = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// --- isoWeekKey (expected values verified against `date +%G-W%V`) ---
t("2026-09-30 (Wednesday) -> 2026-W40", () => {
  assert.strictEqual(isoWeekKey("2026-09-30"), "2026-W40");
});
t("2026-01-01 (Thursday) -> 2026-W01", () => {
  assert.strictEqual(isoWeekKey("2026-01-01"), "2026-W01");
});
t("2025-12-29 (Monday) belongs to 2026-W01", () => {
  assert.strictEqual(isoWeekKey("2025-12-29"), "2026-W01");
});
t("2025-12-31 (Wednesday) belongs to 2026-W01", () => {
  assert.strictEqual(isoWeekKey("2025-12-31"), "2026-W01");
});
t("2026-12-31 (Thursday) -> 2026-W53 (53-week year)", () => {
  assert.strictEqual(isoWeekKey("2026-12-31"), "2026-W53");
});
t("2027-01-03 (Sunday) still 2026-W53", () => {
  assert.strictEqual(isoWeekKey("2027-01-03"), "2026-W53");
});
t("week boundary: Sunday 2026-10-04 -> W40, Monday 2026-10-05 -> W41", () => {
  assert.strictEqual(isoWeekKey("2026-10-04"), "2026-W40");
  assert.strictEqual(isoWeekKey("2026-10-05"), "2026-W41");
});
t("accepts a Date object and a timestamp", () => {
  assert.strictEqual(
    isoWeekKey(new Date(Date.UTC(2026, 8, 30, 12, 0, 0))),
    "2026-W40"
  );
  assert.strictEqual(isoWeekKey(Date.UTC(2026, 8, 30)), "2026-W40");
});
t("invalid input -> null", () => {
  assert.strictEqual(isoWeekKey(null), null);
  assert.strictEqual(isoWeekKey(undefined), null);
  assert.strictEqual(isoWeekKey(""), null);
  assert.strictEqual(isoWeekKey("not-a-date"), null);
  assert.strictEqual(isoWeekKey("2026-13-99"), null);
  assert.strictEqual(isoWeekKey({}), null);
  assert.strictEqual(isoWeekKey(new Date("garbage")), null);
});
t("full datetime string still resolves to the right week", () => {
  assert.strictEqual(isoWeekKey("2026-09-30T23:59:59Z"), "2026-W40");
});

// --- coerceDurationMinutes ---
t("numeric string coerces", () => {
  assert.strictEqual(coerceDurationMinutes("45"), 45);
});
t("number passes through", () => {
  assert.strictEqual(coerceDurationMinutes(60), 60);
});
t("missing/empty -> null", () => {
  assert.strictEqual(coerceDurationMinutes(undefined), null);
  assert.strictEqual(coerceDurationMinutes(null), null);
  assert.strictEqual(coerceDurationMinutes(""), null);
});
t("zero, negative, >1440 -> null", () => {
  assert.strictEqual(coerceDurationMinutes(0), null);
  assert.strictEqual(coerceDurationMinutes(-30), null);
  assert.strictEqual(coerceDurationMinutes(1441), null);
});
t("boundary 1440 accepted, 1 accepted", () => {
  assert.strictEqual(coerceDurationMinutes(1440), 1440);
  assert.strictEqual(coerceDurationMinutes(1), 1);
});
t("garbage -> null", () => {
  assert.strictEqual(coerceDurationMinutes("abc"), null);
  assert.strictEqual(coerceDurationMinutes(NaN), null);
  assert.strictEqual(coerceDurationMinutes(Infinity), null);
});

console.log(`\n${passed} tests passed`);
