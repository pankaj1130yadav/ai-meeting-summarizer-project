// Unit tests for Phase 1 pure helpers (parseActionIndex, validateActionItemInput).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== PHASE 1 HELPERS START =====";
const endMarker = "// ===== PHASE 1 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers +
    "\nreturn { ACTION_STATUSES, ACTION_PRIORITIES, parseActionIndex, validateActionItemInput };"
);
const {
  ACTION_STATUSES,
  ACTION_PRIORITIES,
  parseActionIndex,
  validateActionItemInput,
} = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// --- parseActionIndex ---
t("valid index", () => {
  assert.deepStrictEqual(parseActionIndex("1", 3), { ok: true, index: 1 });
});
t("index 0 valid", () => {
  assert.deepStrictEqual(parseActionIndex("0", 1), { ok: true, index: 0 });
});
t("non-integer string -> 400", () => {
  const r = parseActionIndex("abc", 3);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});
t("float -> 400", () => {
  assert.strictEqual(parseActionIndex("1.5", 3).status, 400);
});
t("out of range -> 404", () => {
  assert.strictEqual(parseActionIndex("5", 3).status, 404);
});
t("negative -> 404", () => {
  assert.strictEqual(parseActionIndex("-1", 3).status, 404);
});
t("empty list -> 404", () => {
  assert.strictEqual(parseActionIndex("0", 0).status, 404);
});

// --- validateActionItemInput (create: partial=false) ---
t("create without task -> error", () => {
  const { errors } = validateActionItemInput({}, { partial: false });
  assert.ok(errors.some((e) => e.includes("task is required")));
});
t("create with blank task -> error", () => {
  const { errors } = validateActionItemInput({ task: "   " }, { partial: false });
  assert.ok(errors.length > 0);
});
t("create valid minimal -> defaults not set here, value has task", () => {
  const { errors, value } = validateActionItemInput({ task: "  Do X " }, { partial: false });
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(value.task, "Do X");
});
t("invalid priority rejected", () => {
  const { errors } = validateActionItemInput({ task: "Do X", priority: "Urgent" });
  assert.ok(errors.some((e) => e.includes("priority")));
});
t("invalid status rejected", () => {
  const { errors } = validateActionItemInput({ task: "Do X", status: "Done" });
  assert.ok(errors.some((e) => e.includes("status")));
});
t("all valid statuses accepted", () => {
  for (const s of ACTION_STATUSES) {
    const { errors } = validateActionItemInput({ status: s }, { partial: true });
    assert.strictEqual(errors.length, 0, `status ${s} should be valid`);
  }
});
t("overlong task rejected", () => {
  const { errors } = validateActionItemInput({ task: "x".repeat(501) }, { partial: false });
  assert.ok(errors.some((e) => e.includes("too long")));
});
t("partial update validates only present fields", () => {
  const { errors, value } = validateActionItemInput({ priority: "High" }, { partial: true });
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(value, { priority: "High" });
});
t("partial update with no fields -> empty value", () => {
  const { errors, value } = validateActionItemInput({}, { partial: true });
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(value, {});
});

console.log(`\n${passed} tests passed`);
