// Unit tests for P5 pure helpers (buildDedupeKey, isReminderDue).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P5 HELPERS START =====";
const endMarker = "// ===== P5 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers + "\nreturn { buildDedupeKey, isReminderDue };"
);
const { buildDedupeKey, isReminderDue } = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// Fixed reference "now": Wednesday 2026-09-30 12:00:00 UTC.
const NOW = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));
const HOUR = 3600 * 1000;

// --- buildDedupeKey ---
t("deterministic format: deadline_reminder:<id>:<idx>:<YYYY-MM-DD>", () => {
  assert.strictEqual(
    buildDedupeKey("deadline_reminder", "abc123", 2, new Date(Date.UTC(2026, 9, 1))),
    "deadline_reminder:abc123:2:2026-10-01"
  );
});
t("deterministic: same inputs -> same key", () => {
  const d = new Date(Date.UTC(2026, 9, 1, 18, 30));
  assert.strictEqual(
    buildDedupeKey("overdue", "m1", 0, d),
    buildDedupeKey("overdue", "m1", 0, d)
  );
});
t("renders the date in UTC (18:30Z still Oct 1)", () => {
  assert.strictEqual(
    buildDedupeKey("overdue", "m1", 0, new Date(Date.UTC(2026, 9, 1, 18, 30))),
    "overdue:m1:0:2026-10-01"
  );
});
t("accepts a string date", () => {
  assert.strictEqual(
    buildDedupeKey("overdue", "m1", 0, "2026-10-01T00:00:00.000Z"),
    "overdue:m1:0:2026-10-01"
  );
});
t("index 0 is kept, not treated as missing", () => {
  assert.strictEqual(
    buildDedupeKey("overdue", "m1", 0, new Date(Date.UTC(2026, 9, 1))),
    "overdue:m1:0:2026-10-01"
  );
});
t("stringifies an ObjectId-like meeting id", () => {
  const fakeId = { toString: () => "68dc1234" };
  assert.strictEqual(
    buildDedupeKey("deadline_reminder", fakeId, 1, new Date(Date.UTC(2026, 9, 1))),
    "deadline_reminder:68dc1234:1:2026-10-01"
  );
});
t("null-safe: null type -> null", () => {
  assert.strictEqual(
    buildDedupeKey(null, "m1", 0, new Date(Date.UTC(2026, 9, 1))),
    null
  );
});
t("null-safe: empty type -> null", () => {
  assert.strictEqual(
    buildDedupeKey("", "m1", 0, new Date(Date.UTC(2026, 9, 1))),
    null
  );
});
t("null-safe: null/undefined meetingId -> null", () => {
  const d = new Date(Date.UTC(2026, 9, 1));
  assert.strictEqual(buildDedupeKey("overdue", null, 0, d), null);
  assert.strictEqual(buildDedupeKey("overdue", undefined, 0, d), null);
});
t("null-safe: null/undefined itemIndex -> null", () => {
  const d = new Date(Date.UTC(2026, 9, 1));
  assert.strictEqual(buildDedupeKey("overdue", "m1", null, d), null);
  assert.strictEqual(buildDedupeKey("overdue", "m1", undefined, d), null);
});
t("null-safe: null/undefined date -> null", () => {
  assert.strictEqual(buildDedupeKey("overdue", "m1", 0, null), null);
  assert.strictEqual(buildDedupeKey("overdue", "m1", 0, undefined), null);
});
t("garbage date -> null", () => {
  assert.strictEqual(
    buildDedupeKey("overdue", "m1", 0, "not a date"),
    null
  );
});

// --- isReminderDue ---
t("exactly at the window edge (24h) -> true", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 24 * HOUR), NOW, 24),
    true
  );
});
t("just past the window (24h + 1s) -> false", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 24 * HOUR + 1000), NOW, 24),
    false
  );
});
t("well inside the window (1h) -> true", () => {
  assert.strictEqual(isReminderDue(new Date(NOW.getTime() + HOUR), NOW, 24), true);
});
t("past deadline -> false", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() - HOUR), NOW, 24),
    false
  );
});
t("deadline exactly now -> false (must be strictly future)", () => {
  assert.strictEqual(isReminderDue(new Date(NOW.getTime()), NOW, 24), false);
});
t("custom window: 30min within 1h -> true; 2h outside -> false", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 30 * 60 * 1000), NOW, 1),
    true
  );
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 2 * HOUR), NOW, 1),
    false
  );
});
t("accepts date strings", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + HOUR).toISOString(), NOW, 24),
    true
  );
});
t("accepts timestamps", () => {
  assert.strictEqual(isReminderDue(NOW.getTime() + HOUR, NOW, 24), true);
});
t("garbage deadline -> false", () => {
  assert.strictEqual(isReminderDue("soon", NOW, 24), false);
  assert.strictEqual(isReminderDue("Not specified", NOW, 24), false);
});
t("null/undefined deadline -> false", () => {
  assert.strictEqual(isReminderDue(null, NOW, 24), false);
  assert.strictEqual(isReminderDue(undefined, NOW, 24), false);
});
t("invalid now -> false", () => {
  assert.strictEqual(isReminderDue(new Date(NOW.getTime() + HOUR), "garbage", 24), false);
});
t("garbage hoursBefore (0, -1, NaN, 'x') -> false", () => {
  const due = new Date(NOW.getTime() + HOUR);
  assert.strictEqual(isReminderDue(due, NOW, 0), false);
  assert.strictEqual(isReminderDue(due, NOW, -5), false);
  assert.strictEqual(isReminderDue(due, NOW, NaN), false);
  assert.strictEqual(isReminderDue(due, NOW, "x"), false);
});
t("default hoursBefore is 24", () => {
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 23 * HOUR), NOW),
    true
  );
  assert.strictEqual(
    isReminderDue(new Date(NOW.getTime() + 25 * HOUR), NOW),
    false
  );
});
t("pure: frozen inputs are not mutated", () => {
  const due = Object.freeze(new Date(NOW.getTime() + HOUR));
  assert.strictEqual(isReminderDue(due, NOW, 24), true);
});

console.log(`\n${passed} tests passed`);
