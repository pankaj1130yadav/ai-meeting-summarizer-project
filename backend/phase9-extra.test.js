// Phase 9 extra unit tests: covers the pure helpers NOT covered by the
// earlier test files — splitSentences / dedupeCap (P2 block, used by all
// extractors but never tested directly), extra sanitizeTags edge cases,
// extra coerceDurationMinutes boundary quirks, and extra isoWeekKey cases.
// Uses the same source-extraction pattern as the other test files so these
// run against the real code in server.js.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const extract = (startMarker, endMarker) => {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  assert.ok(
    start !== -1 && end !== -1 && end > start,
    `helper markers not found: ${startMarker}`
  );
  return src.slice(start, end);
};

const p2Factory = new Function(
  extract("// ===== P2 HELPERS START =====", "// ===== P2 HELPERS END =====") +
    "\nreturn { splitSentences, dedupeCap, sanitizeTags };"
);
const { splitSentences, dedupeCap, sanitizeTags } = p2Factory();

const p3Factory = new Function(
  extract("// ===== P3 HELPERS START =====", "// ===== P3 HELPERS END =====") +
    "\nreturn { isoWeekKey, coerceDurationMinutes };"
);
const { isoWeekKey, coerceDurationMinutes } = p3Factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// --- splitSentences ---
t("splitSentences: multiple terminators kept", () => {
  assert.deepStrictEqual(splitSentences("Hi. Bye! What? Really!"), [
    "Hi.",
    "Bye!",
    "What?",
    "Really!",
  ]);
});
t("splitSentences: no terminator -> whole text as one sentence", () => {
  assert.deepStrictEqual(splitSentences("Hello world"), ["Hello world"]);
});
t("splitSentences: whitespace trimmed", () => {
  assert.deepStrictEqual(splitSentences("  First.   Second.  "), [
    "First.",
    "Second.",
  ]);
});
t("splitSentences: non-string and blank -> []", () => {
  assert.deepStrictEqual(splitSentences(""), []);
  assert.deepStrictEqual(splitSentences("   "), []);
  assert.deepStrictEqual(splitSentences(null), []);
  assert.deepStrictEqual(splitSentences(undefined), []);
  assert.deepStrictEqual(splitSentences(123), []);
});

// --- dedupeCap ---
t("dedupeCap: case-insensitive dedupe keeps first occurrence", () => {
  assert.deepStrictEqual(dedupeCap(["A", "a", "B", "b", "C"], 10), [
    "A",
    "B",
    "C",
  ]);
});
t("dedupeCap: caps at max", () => {
  assert.deepStrictEqual(dedupeCap(["x", "y", "z", "w"], 2), ["x", "y"]);
});
t("dedupeCap: dedupe happens before cap", () => {
  assert.deepStrictEqual(dedupeCap(["a", "A", "b", "B", "c"], 3), [
    "a",
    "b",
    "c",
  ]);
});
t("dedupeCap: empty input -> []", () => {
  assert.deepStrictEqual(dedupeCap([], 10), []);
});

// --- sanitizeTags (extra edge cases; basic trim/cap covered in phase2) ---
t("sanitizeTags: non-string entries coerced via String()", () => {
  assert.deepStrictEqual(sanitizeTags([1, null, " hi ", 2.5]), [
    "1",
    "null",
    "hi",
    "2.5",
  ]);
});
t("sanitizeTags: duplicates are preserved (no dedupe)", () => {
  assert.deepStrictEqual(sanitizeTags(["a", "a"]), ["a", "a"]);
});
t("sanitizeTags: exactly 20 kept", () => {
  const input = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.strictEqual(sanitizeTags(input).length, 20);
});

// --- coerceDurationMinutes (extra boundaries; basics covered in phase3) ---
t("coerceDurationMinutes: fractions within range pass through", () => {
  assert.strictEqual(coerceDurationMinutes(45.5), 45.5);
});
t("coerceDurationMinutes: fractional above 1440 rejected", () => {
  assert.strictEqual(coerceDurationMinutes("1440.5"), null);
});
t("coerceDurationMinutes: boolean true coerces to 1 (Number(true))", () => {
  assert.strictEqual(coerceDurationMinutes(true), 1);
});
t("coerceDurationMinutes: boolean false -> 0 -> null", () => {
  assert.strictEqual(coerceDurationMinutes(false), null);
});
t("coerceDurationMinutes: padded numeric string coerces", () => {
  assert.strictEqual(coerceDurationMinutes(" 30 "), 30);
});
t("coerceDurationMinutes: negative fraction rejected", () => {
  assert.strictEqual(coerceDurationMinutes("-0.5"), null);
});

// --- isoWeekKey (extra cases; invalid inputs covered in phase3) ---
t("isoWeekKey: leap day resolves (verified against date +%G-W%V)", () => {
  assert.strictEqual(isoWeekKey("2024-02-29"), "2024-W09");
});
t("isoWeekKey: year-start Sunday belongs to previous ISO year", () => {
  assert.strictEqual(isoWeekKey("2023-01-01"), "2022-W52");
});

console.log(`\n${passed} tests passed`);
