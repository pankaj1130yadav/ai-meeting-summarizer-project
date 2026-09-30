// Unit tests for P1-INC2 pure helpers (parseDueDate, isOverdueActionItem).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P1-INC2 HELPERS START =====";
const endMarker = "// ===== P1-INC2 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers + "\nreturn { parseDueDate, isOverdueActionItem };"
);
const { parseDueDate, isOverdueActionItem } = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// Fixed reference "now": Wednesday 2026-09-30, local time.
// (Verified: date -d 2026-09-30 => Wednesday.)
const NOW = new Date(2026, 8, 30);
const date = (y, mo, d) => new Date(y, mo - 1, d); // local midnight
const sameDay = (a, b) => a instanceof Date && a.getTime() === b.getTime();

// --- parseDueDate: absolute formats ---
t("ISO YYYY-MM-DD", () => {
  assert.ok(sameDay(parseDueDate("2026-10-05", NOW), date(2026, 10, 5)));
});
t("ISO returns start of day (local midnight)", () => {
  const d = parseDueDate("2026-10-05", NOW);
  assert.strictEqual(d.getHours(), 0);
  assert.strictEqual(d.getMinutes(), 0);
  assert.strictEqual(d.getSeconds(), 0);
});
t("DD/MM/YYYY", () => {
  assert.ok(sameDay(parseDueDate("05/10/2026", NOW), date(2026, 10, 5)));
});
t("DD-MM-YYYY", () => {
  assert.ok(sameDay(parseDueDate("05-10-2026", NOW), date(2026, 10, 5)));
});
t("invalid ISO month -> null", () => {
  assert.strictEqual(parseDueDate("2026-13-01", NOW), null);
});
t("nonexistent date 2026-02-30 -> null", () => {
  assert.strictEqual(parseDueDate("2026-02-30", NOW), null);
});
t("day 32 -> null", () => {
  assert.strictEqual(parseDueDate("32/01/2026", NOW), null);
});

// --- parseDueDate: relative keywords ---
t("today", () => {
  assert.ok(sameDay(parseDueDate("today", NOW), date(2026, 9, 30)));
});
t("tomorrow", () => {
  assert.ok(sameDay(parseDueDate("tomorrow", NOW), date(2026, 10, 1)));
});
t("day after tomorrow", () => {
  assert.ok(sameDay(parseDueDate("day after tomorrow", NOW), date(2026, 10, 2)));
});
t("keywords are case-insensitive", () => {
  assert.ok(sameDay(parseDueDate("TOMORROW", NOW), date(2026, 10, 1)));
  assert.ok(sameDay(parseDueDate("ToDay", NOW), date(2026, 9, 30)));
});

// --- parseDueDate: weekdays (NOW = Wednesday 2026-09-30) ---
t("bare weekday -> upcoming strictly after today (Friday -> Oct 2)", () => {
  assert.ok(sameDay(parseDueDate("Friday", NOW), date(2026, 10, 2)));
});
t("bare same weekday -> next week (Wednesday -> Oct 7)", () => {
  assert.ok(sameDay(parseDueDate("Wednesday", NOW), date(2026, 10, 7)));
});
t("by prefix -> upcoming weekday (by Friday -> Oct 2)", () => {
  assert.ok(sameDay(parseDueDate("by Friday", NOW), date(2026, 10, 2)));
});
t("next prefix -> following week (next Monday -> Oct 12)", () => {
  assert.ok(sameDay(parseDueDate("next Monday", NOW), date(2026, 10, 12)));
});
t("next prefix (next Friday -> Oct 9)", () => {
  assert.ok(sameDay(parseDueDate("next Friday", NOW), date(2026, 10, 9)));
});
t("weekday case-insensitive (sUnDaY -> Oct 4)", () => {
  assert.ok(sameDay(parseDueDate("sUnDaY", NOW), date(2026, 10, 4)));
});
t("bare Monday -> Oct 5", () => {
  assert.ok(sameDay(parseDueDate("monday", NOW), date(2026, 10, 5)));
});

// --- parseDueDate: unparseable -> null ---
t("Not specified -> null", () => {
  assert.strictEqual(parseDueDate("Not specified", NOW), null);
});
t("ASAP -> null", () => {
  assert.strictEqual(parseDueDate("ASAP", NOW), null);
});
t("empty string -> null", () => {
  assert.strictEqual(parseDueDate("   ", NOW), null);
});
t("non-string input -> null", () => {
  assert.strictEqual(parseDueDate(null, NOW), null);
  assert.strictEqual(parseDueDate(undefined, NOW), null);
});
t("random text -> null", () => {
  assert.strictEqual(parseDueDate("sometime soon", NOW), null);
});

// --- isOverdueActionItem ---
t("past date + Pending -> true", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-29", status: "Pending" }, NOW),
    true
  );
});
t("past date + In Progress -> true", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-29", status: "In Progress" }, NOW),
    true
  );
});
t("past date + Overdue status -> true", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-29", status: "Overdue" }, NOW),
    true
  );
});
t("future date + Pending -> false", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-10-05", status: "Pending" }, NOW),
    false
  );
});
t("deadline today -> false", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-30", status: "Pending" }, NOW),
    false
  );
});
t("Completed with past date -> false", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-29", status: "Completed" }, NOW),
    false
  );
});
t("Cancelled with past date -> false", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "2026-09-29", status: "Cancelled" }, NOW),
    false
  );
});
t("unparseable deadline -> false", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "Not specified", status: "Pending" }, NOW),
    false
  );
});
t("relative past keyword overdue (day before yesterday has no keyword; 'today' not overdue)", () => {
  assert.strictEqual(
    isOverdueActionItem({ deadline: "today", status: "Pending" }, NOW),
    false
  );
});
t("null item -> false", () => {
  assert.strictEqual(isOverdueActionItem(null, NOW), false);
});
t("pure: does not mutate the item", () => {
  const item = Object.freeze({
    task: "X",
    deadline: "2026-09-29",
    status: "Pending",
  });
  assert.strictEqual(isOverdueActionItem(item, NOW), true); // throws if it tried to write
});

console.log(`\n${passed} tests passed`);
