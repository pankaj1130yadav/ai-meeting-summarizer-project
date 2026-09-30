// Unit tests for Phase 2 pure helpers (extractDecisions, extractRisks,
// extractBlockers, extractOpenQuestions, extractTopics, sanitizeTags).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P2 HELPERS START =====";
const endMarker = "// ===== P2 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers +
    "\nreturn { extractDecisions, extractRisks, extractBlockers, extractOpenQuestions, extractTopics, sanitizeTags };"
);
const {
  extractDecisions,
  extractRisks,
  extractBlockers,
  extractOpenQuestions,
  extractTopics,
  sanitizeTags,
} = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// --- extractDecisions ---
t("decisions: 'we decided to' matches", () => {
  const r = extractDecisions("We decided to use MongoDB for storage.");
  assert.deepStrictEqual(r, ["We decided to use MongoDB for storage."]);
});
t("decisions: 'team agreed' / 'agreed that' match", () => {
  const r = extractDecisions(
    "The team agreed on the new API contract. We agreed that the deadline works."
  );
  assert.strictEqual(r.length, 2);
});
t("decisions: plain 'decided' matches", () => {
  const r = extractDecisions("After debate, Pankaj decided the schema.");
  assert.strictEqual(r.length, 1);
});
t("decisions: no decision sentence -> []", () => {
  assert.deepStrictEqual(extractDecisions("We will meet tomorrow."), []);
});
t("decisions: empty / non-string -> []", () => {
  assert.deepStrictEqual(extractDecisions(""), []);
  assert.deepStrictEqual(extractDecisions(null), []);
  assert.deepStrictEqual(extractDecisions(42), []);
});
t("decisions: dedupes exact repeats (case-insensitive)", () => {
  const r = extractDecisions(
    "We decided to ship. we decided to ship. We decided to ship."
  );
  assert.deepStrictEqual(r, ["We decided to ship."]);
});
t("decisions: capped at 10", () => {
  const text = Array.from(
    { length: 12 },
    (_, i) => `We decided option ${i} today`
  ).join(". ");
  assert.strictEqual(extractDecisions(text).length, 10);
});

// --- extractRisks ---
t("risks: risk/concerned/worried match", () => {
  const r = extractRisks(
    "There is a risk of data loss. We are concerned about the budget. I am worried about latency."
  );
  assert.strictEqual(r.length, 3);
});
t("risks: 'threat' matches", () => {
  const r = extractRisks("The main threat is vendor lock-in.");
  assert.strictEqual(r.length, 1);
});
t("risks: no risk sentence -> []", () => {
  assert.deepStrictEqual(extractRisks("Everything is on track."), []);
});
t("risks: empty / non-string -> []", () => {
  assert.deepStrictEqual(extractRisks(""), []);
  assert.deepStrictEqual(extractRisks(undefined), []);
});
t("risks: dedupes repeats", () => {
  const r = extractRisks("This is risky. This is risky.");
  assert.strictEqual(r.length, 1);
});
t("risks: capped at 10", () => {
  const text = Array.from(
    { length: 15 },
    (_, i) => `Concern number ${i} about scope`
  ).join(". ");
  assert.strictEqual(extractRisks(text).length, 10);
});

// --- extractBlockers ---
t("blockers: blocked / waiting on match", () => {
  const r = extractBlockers(
    "We are blocked on the design review. The frontend team is waiting on the API spec."
  );
  assert.strictEqual(r.length, 2);
});
t("blockers: 'stuck' and 'dependency' match", () => {
  const r = extractBlockers(
    "Pankaj is stuck with auth. That task has a dependency on the migration."
  );
  assert.strictEqual(r.length, 2);
});
t("blockers: no blocker sentence -> []", () => {
  assert.deepStrictEqual(extractBlockers("All tasks are done."), []);
});
t("blockers: empty / non-string -> []", () => {
  assert.deepStrictEqual(extractBlockers("   "), []);
  assert.deepStrictEqual(extractBlockers(123), []);
});
t("blockers: dedupes repeats", () => {
  const r = extractBlockers("We are blocked. We are blocked.");
  assert.strictEqual(r.length, 1);
});
t("blockers: capped at 10", () => {
  const text = Array.from(
    { length: 14 },
    (_, i) => `Blocker ${i} is blocking progress`
  ).join(". ");
  assert.strictEqual(extractBlockers(text).length, 10);
});

// --- extractOpenQuestions ---
t("questions: sentences ending with ? are returned", () => {
  const r = extractOpenQuestions(
    "Should we use Redis? Let's discuss caching. Is this viable?"
  );
  assert.deepStrictEqual(r, ["Should we use Redis?", "Is this viable?"]);
});
t("questions: no question marks -> []", () => {
  assert.deepStrictEqual(
    extractOpenQuestions("We decided to ship. Great work."),
    []
  );
});
t("questions: empty / non-string -> []", () => {
  assert.deepStrictEqual(extractOpenQuestions(""), []);
  assert.deepStrictEqual(extractOpenQuestions(null), []);
});
t("questions: dedupes repeats", () => {
  const r = extractOpenQuestions("Who owns this? Who owns this?");
  assert.strictEqual(r.length, 1);
});
t("questions: capped at 10", () => {
  const text = Array.from({ length: 13 }, (_, i) => `Question ${i}?`).join(
    " "
  );
  assert.strictEqual(extractOpenQuestions(text).length, 10);
});
t("questions: ?! terminator does not count as a plain question", () => {
  const r = extractOpenQuestions("Really?! That is fine.");
  assert.deepStrictEqual(r, []);
});

// --- extractTopics ---
t("topics: returns top frequent non-stopword terms", () => {
  const r = extractTopics(
    "MongoDB migration. MongoDB schema. The MongoDB database and Redis cache. Database indexes for the database."
  );
  assert.ok(r.includes("mongodb"), "mongodb should be a topic");
  assert.ok(r.includes("database"), "database should be a topic");
});
t("topics: stopwords, short words and numbers dropped", () => {
  const r = extractTopics(
    "the the the and and we 123 4567 meeting meeting agenda"
  );
  assert.deepStrictEqual(r, ["meeting", "agenda"]);
});
t("topics: deterministic ordering (count desc, then alphabetical)", () => {
  const r = extractTopics("zeta zeta alpha alpha beta");
  assert.deepStrictEqual(r, ["alpha", "zeta", "beta"]);
  assert.deepStrictEqual(extractTopics("zeta zeta alpha alpha beta"), r);
});
t("topics: max 8 returned", () => {
  const r = extractTopics(
    "alpha beta gamma delta epsilon theta iota kappa lambda mu nu xi"
  );
  assert.strictEqual(r.length, 8);
});
t("topics: empty / non-string -> []", () => {
  assert.deepStrictEqual(extractTopics(""), []);
  assert.deepStrictEqual(extractTopics(null), []);
});
t("topics: pure numbers dropped even when long", () => {
  assert.deepStrictEqual(extractTopics("meeting 12345"), ["meeting"]);
});

// --- sanitizeTags ---
t("tags: trims, drops empties, caps at 20", () => {
  const input = ["  api ", "", "   ", "backend"];
  assert.deepStrictEqual(sanitizeTags(input), ["api", "backend"]);
});
t("tags: cap at 20", () => {
  const input = Array.from({ length: 25 }, (_, i) => `tag${i}`);
  const r = sanitizeTags(input);
  assert.strictEqual(r.length, 20);
  assert.strictEqual(r[0], "tag0");
  assert.strictEqual(r[19], "tag19");
});
t("tags: non-array -> []", () => {
  assert.deepStrictEqual(sanitizeTags(undefined), []);
  assert.deepStrictEqual(sanitizeTags("backend"), []);
  assert.deepStrictEqual(sanitizeTags(null), []);
});
t("tags: empty array -> []", () => {
  assert.deepStrictEqual(sanitizeTags([]), []);
});

console.log(`\n${passed} tests passed`);
