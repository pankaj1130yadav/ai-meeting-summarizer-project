// Unit tests for P12 RAG service (backend/services/rag.js).
//
// services/rag.js is loaded via the source-extraction pattern (slice off the
// module.exports tail, run the body through `new Function`) so the tests run
// against the real code with no network, no DB, and no secrets.
// getEmbeddingProvider tests only touch process.env — no HTTP calls are made
// (embedBatch is never invoked in this file).
const fs = require("fs");
const assert = require("assert");

// ---- Load services/rag.js (extraction pattern) ----
const ragSrc = fs.readFileSync(__dirname + "/services/rag.js", "utf8");
const cutAt = ragSrc.lastIndexOf("module.exports");
assert.ok(cutAt !== -1, "rag.js module.exports not found");
const ragFactory = new Function(
  "require",
  ragSrc.slice(0, cutAt) +
    "\nreturn { chunkText, hashFeatures, cosineSim, buildTfIdfIndex, " +
    "retrieve, getEmbeddingProvider, atlasVectorSearchHint };"
);
const {
  chunkText,
  hashFeatures,
  cosineSim,
  buildTfIdfIndex,
  retrieve,
  getEmbeddingProvider,
  atlasVectorSearchHint,
} = ragFactory(require);

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok - " + name);
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const wordCount = (s) => s.split(/\s+/).filter((w) => w.length > 0).length;

// ================= chunkText =================
t("chunkText: null -> []", () => assert.deepStrictEqual(chunkText(null), []));
t("chunkText: undefined -> []", () =>
  assert.deepStrictEqual(chunkText(undefined), [])
);
t("chunkText: non-string -> []", () =>
  assert.deepStrictEqual(chunkText(42), [])
);
t("chunkText: empty/blank -> []", () => {
  assert.deepStrictEqual(chunkText(""), []);
  assert.deepStrictEqual(chunkText("   \n  "), []);
});
t("chunkText: short text -> single chunk", () => {
  const chunks = chunkText("hello world foo bar");
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0], "hello world foo bar");
});
t("chunkText: chunks never exceed chunkSize words", () => {
  const words = Array.from({ length: 1234 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words, 500, 50);
  for (const c of chunks) {
    assert.ok(wordCount(c) <= 500, "chunk too big: " + wordCount(c));
  }
});
t("chunkText: overlap shifts the next chunk by (chunkSize - overlap)", () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${i}`);
  const chunks = chunkText(words.join(" "), 500, 50);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(wordCount(chunks[0]), 500);
  assert.strictEqual(wordCount(chunks[1]), 150);
  // Second chunk starts at word index 450 (overlap of 50 with chunk 1).
  assert.ok(chunks[1].startsWith("w450 w451"));
  // Overlap region: words 450..499 appear at the end of chunk 1 AND the
  // start of chunk 2.
  const tail1 = chunks[0].split(/\s+/).slice(-50).join(" ");
  const head2 = chunks[1].split(/\s+/).slice(0, 50).join(" ");
  assert.strictEqual(tail1, head2);
});
t("chunkText: zero overlap", () => {
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words, 30, 0);
  assert.strictEqual(chunks.length, 4);
  assert.ok(chunks[0].startsWith("w0 "));
  assert.ok(chunks[1].startsWith("w30 "));
});
t("chunkText: overlap >= chunkSize is clamped, no infinite loop", () => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words, 10, 10);
  assert.ok(chunks.length > 0 && chunks.length < 100);
  assert.ok(chunks.every((c) => wordCount(c) <= 10));
});
t("chunkText: invalid chunkSize -> []", () => {
  assert.deepStrictEqual(chunkText("some text", 0), []);
  assert.deepStrictEqual(chunkText("some text", -5), []);
});

// ================= hashFeatures =================
t("hashFeatures: deterministic (same text -> same vector)", () => {
  const a = hashFeatures("the quick brown fox jumps over the lazy dog");
  const b = hashFeatures("the quick brown fox jumps over the lazy dog");
  assert.deepStrictEqual(a, b);
});
t("hashFeatures: default dim is 256", () => {
  assert.strictEqual(hashFeatures("hello").length, 256);
});
t("hashFeatures: different texts -> different vectors", () => {
  const a = hashFeatures("apple banana cherry");
  const b = hashFeatures("quantum physics relativity");
  assert.notDeepStrictEqual(a, b);
});
t("hashFeatures: term counts land in the vector (non-zero for non-empty)", () => {
  const vec = hashFeatures("alpha alpha beta");
  const total = vec.reduce((s, x) => s + x, 0);
  assert.strictEqual(total, 3); // 3 tokens distributed into buckets
});
t("hashFeatures: empty/non-string -> []", () => {
  assert.deepStrictEqual(hashFeatures(null), []);
});

// ================= cosineSim =================
t("cosineSim: identical vectors -> 1", () => {
  assert.ok(approx(cosineSim([1, 2, 3], [1, 2, 3]), 1));
});
t("cosineSim: scaled vectors -> 1 (magnitude invariant)", () => {
  assert.ok(approx(cosineSim([1, 2], [2, 4]), 1));
});
t("cosineSim: orthogonal vectors -> 0", () => {
  assert.ok(approx(cosineSim([1, 0], [0, 1]), 0));
});
t("cosineSim: zero vector -> 0 (no NaN)", () => {
  assert.strictEqual(cosineSim([0, 0, 0], [1, 2, 3]), 0);
});
t("cosineSim: mismatched lengths -> 0", () => {
  assert.strictEqual(cosineSim([1, 2], [1, 2, 3]), 0);
});

// ================= buildTfIdfIndex =================
t("buildTfIdfIndex: vectors align with vocabulary", () => {
  const { vectors, idf, vocabulary } = buildTfIdfIndex([
    "alpha beta gamma",
    "alpha delta",
  ]);
  assert.strictEqual(vectors.length, 2);
  assert.strictEqual(vectors[0].length, vocabulary.length);
  assert.strictEqual(idf.length, vocabulary.length);
  assert.ok(vocabulary.includes("alpha"));
  assert.ok(vocabulary.includes("gamma"));
});
t("buildTfIdfIndex: rare terms weigh more than common terms", () => {
  const { vectors, vocabulary } = buildTfIdfIndex([
    "alpha beta beta beta",
    "alpha gamma",
  ]);
  const alpha = vocabulary.indexOf("alpha");
  const gamma = vocabulary.indexOf("gamma");
  // "gamma" appears once in one doc; "alpha" appears in both -> higher idf.
  assert.ok(vectors[1][gamma] > vectors[1][alpha]);
});
t("buildTfIdfIndex: empty docs list -> empty vectors", () => {
  const { vectors, idf, vocabulary } = buildTfIdfIndex([]);
  assert.deepStrictEqual(vectors, []);
  assert.deepStrictEqual(idf, []);
  assert.deepStrictEqual(vocabulary, []);
});

// ================= retrieve =================
const fixtureDocs = [
  {
    id: "m1:0",
    text: "The engineering team discussed the database migration timeline and rollout plan.",
    meta: { meetingId: "m1", title: "Engineering Sync" },
  },
  {
    id: "m2:0",
    text: "Marketing reviewed the quarterly campaign budget and social media schedule.",
    meta: { meetingId: "m2", title: "Marketing Review" },
  },
  {
    id: "m3:0",
    text: "Finance approved the hiring budget and discussed headcount for next quarter.",
    meta: { meetingId: "m3", title: "Finance Planning" },
  },
];

t("retrieve: empty query -> []", () => {
  assert.deepStrictEqual(retrieve("", fixtureDocs), []);
  assert.deepStrictEqual(retrieve("   ", fixtureDocs), []);
  assert.deepStrictEqual(retrieve(null, fixtureDocs), []);
});
t("retrieve: most relevant doc ranks first", () => {
  const hits = retrieve("database migration rollout", fixtureDocs, 3);
  assert.strictEqual(hits.length, 3);
  assert.strictEqual(hits[0].id, "m1:0");
  assert.strictEqual(hits[0].meta.title, "Engineering Sync");
});
t("retrieve: ranks a marketing query first", () => {
  const hits = retrieve("quarterly campaign social media", fixtureDocs, 3);
  assert.strictEqual(hits[0].id, "m2:0");
});
t("retrieve: results sorted by score descending", () => {
  const hits = retrieve("budget", fixtureDocs, 3);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score);
  }
});
t("retrieve: preserves id/text/meta and exposes score", () => {
  const hits = retrieve("database", fixtureDocs, 1);
  assert.strictEqual(hits.length, 1);
  assert.ok(typeof hits[0].score === "number");
  assert.strictEqual(hits[0].text, fixtureDocs[0].text);
  assert.deepStrictEqual(hits[0].meta, fixtureDocs[0].meta);
});
t("retrieve: topK clamps result count", () => {
  assert.strictEqual(retrieve("budget", fixtureDocs, 2).length, 2);
});
t("retrieve: no docs -> []", () => {
  assert.deepStrictEqual(retrieve("budget", [], 5), []);
});

// ================= getEmbeddingProvider =================
const savedProvider = process.env.EMBEDDING_PROVIDER;
const savedOpenAI = process.env.OPENAI_API_KEY;
const savedVoyage = process.env.VOYAGE_API_KEY;

t("getEmbeddingProvider: default -> local, embed null", () => {
  delete process.env.EMBEDDING_PROVIDER;
  const p = getEmbeddingProvider();
  assert.strictEqual(p.name, "local");
  assert.strictEqual(p.embed, null);
});
t("getEmbeddingProvider: explicit local", () => {
  process.env.EMBEDDING_PROVIDER = "local";
  assert.strictEqual(getEmbeddingProvider().name, "local");
});
t("getEmbeddingProvider: invalid value -> throws", () => {
  process.env.EMBEDDING_PROVIDER = "groq"; // Groq has no embeddings API
  assert.throws(() => getEmbeddingProvider(), /Unknown EMBEDDING_PROVIDER/);
});
t("getEmbeddingProvider: openai without key -> throws", () => {
  process.env.EMBEDDING_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;
  assert.throws(() => getEmbeddingProvider(), /OPENAI_API_KEY/);
});
t("getEmbeddingProvider: openai with key -> returns embed fn (no call)", () => {
  process.env.EMBEDDING_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key-never-sent";
  const p = getEmbeddingProvider();
  assert.strictEqual(p.name, "openai");
  assert.strictEqual(typeof p.embed, "function");
  // NOTE: embed() is never invoked here — no network in tests.
});
t("getEmbeddingProvider: voyage without key -> throws", () => {
  process.env.EMBEDDING_PROVIDER = "voyage";
  delete process.env.VOYAGE_API_KEY;
  assert.throws(() => getEmbeddingProvider(), /VOYAGE_API_KEY/);
});

// Restore env (tests must not leak).
if (savedProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
else process.env.EMBEDDING_PROVIDER = savedProvider;
if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = savedOpenAI;
if (savedVoyage === undefined) delete process.env.VOYAGE_API_KEY;
else process.env.VOYAGE_API_KEY = savedVoyage;

// ================= atlasVectorSearchHint =================
t("atlasVectorSearchHint: returns pipeline + index definition as data", () => {
  const hint = atlasVectorSearchHint();
  assert.strictEqual(hint.indexName, "meeting_chunks_vector");
  assert.ok(Array.isArray(hint.pipeline));
  assert.ok(
    hint.pipeline.some((stage) => stage.$vectorSearch),
    "pipeline must include a $vectorSearch stage"
  );
  assert.ok(
    hint.indexDefinition &&
      hint.indexDefinition.definition &&
      hint.indexDefinition.definition.mappings,
    "indexDefinition must carry Atlas search mappings"
  );
  assert.strictEqual(
    hint.indexDefinition.definition.mappings.fields.embedding.type,
    "knnVector"
  );
});

console.log(`\nphase12-rag.test.js: ${passed} tests passed`);
