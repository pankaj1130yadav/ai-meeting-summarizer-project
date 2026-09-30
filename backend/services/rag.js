// ===== P12: RAG (retrieval-augmented Q&A) service =====
//
// HONEST LABELING — READ FIRST:
//   - This module performs LEXICAL retrieval: word-overlap TF-IDF scoring
//     over chunked meeting transcripts. It is NOT "semantic search" and it
//     does NOT use embeddings unless an external embedding provider is
//     explicitly configured via EMBEDDING_PROVIDER.
//   - Groq offers NO embeddings API as of 2026-09-30, so there is no
//     "Groq embeddings" option here. Optional providers: OpenAI or Voyage,
//     both via their public HTTP APIs (called only when configured).
//   - The default path works with ZERO external calls and ZERO keys.
//
// All pure functions are null-safe and deterministic so they can be unit
// tested without network, DB, or secrets.

// Lowercase alphanumeric tokens. Used by chunking-adjacent helpers and the
// TF-IDF index. Not exported — internal detail.
const tokenize = (text) =>
  String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

// Split text into word-based chunks of `chunkSize` words with `overlap`
// words of overlap between consecutive chunks. Null-safe: null / undefined /
// non-string / blank input yields []. Pure.
const chunkText = (text, chunkSize = 500, overlap = 50) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const size = Number(chunkSize);
  if (!Number.isInteger(size) || size <= 0) return [];
  let ov = Number(overlap);
  if (!Number.isInteger(ov) || ov < 0) ov = 0;
  if (ov >= size) ov = size - 1;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const step = size - ov; // >= 1
  const chunks = [];
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + size).join(" "));
  }
  return chunks;
};

// Deterministic FNV-1a 32-bit string hash. Same input always hashes to the
// same value on any platform — the basis of the feature-hash vector below.
const hashString = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Feature-hash term vector: each token increments the bucket its hash maps
// to. Deterministic (same text -> same vector). This is a sparse lexical
// feature vector — it is NOT an embedding and carries no semantics beyond
// term counts. Pure.
const hashFeatures = (text, dim = 256) => {
  const d = Number(dim);
  if (typeof text !== "string" || !Number.isInteger(d) || d <= 0) return [];
  const vec = new Array(d).fill(0);
  for (const term of tokenize(text)) {
    vec[hashString(term) % d] += 1;
  }
  return vec;
};

// Cosine similarity of two numeric arrays. Returns 0 for empty vectors,
// mismatched lengths, or zero vectors (avoids NaN). Pure.
const cosineSim = (a, b) => {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length === 0 ||
    a.length !== b.length
  ) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

// Build a local TF-IDF index over the given document TEXTS (array of
// strings). Returns { vectors, idf, vocabulary } where vectors[i] is the
// TF-IDF vector of docs[i] over the shared vocabulary. tf is term count /
// doc length; idf is smoothed: log((N+1)/(df+1)) + 1. Pure, local only.
const buildTfIdfIndex = (docs) => {
  const texts = Array.isArray(docs) ? docs : [];
  const tokenized = texts.map((t) => tokenize(t));

  const vocabulary = [];
  const indexOf = new Map();
  for (const terms of tokenized) {
    for (const term of terms) {
      if (!indexOf.has(term)) {
        indexOf.set(term, vocabulary.length);
        vocabulary.push(term);
      }
    }
  }

  const N = tokenized.length;
  const df = new Array(vocabulary.length).fill(0);
  for (const terms of tokenized) {
    const seen = new Set(terms);
    for (const term of seen) {
      df[indexOf.get(term)] += 1;
    }
  }
  const idf = df.map((d) => Math.log((N + 1) / (d + 1)) + 1);

  const vectors = tokenized.map((terms) => {
    const vec = new Array(vocabulary.length).fill(0);
    if (terms.length === 0) return vec;
    const tf = new Map();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }
    for (const [term, count] of tf) {
      const i = indexOf.get(term);
      vec[i] = (count / terms.length) * idf[i];
    }
    return vec;
  });

  return { vectors, idf, vocabulary };
};

// Rank docs by cosine similarity between the TF-IDF query vector and each
// doc's TF-IDF vector (lexical retrieval — keyword overlap, not semantics).
//   query: string — empty/blank -> []
//   docs:  [{ id, text, meta }]
//   topK:  max results (default 5)
// Returns topK [{ id, text, meta, score }] sorted by score descending
// (ties broken by original order for determinism). Pure, local only.
const retrieve = (query, docs, topK = 5) => {
  if (typeof query !== "string" || !query.trim()) return [];
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const texts = docs.map((d) =>
    d && typeof d.text === "string" ? d.text : ""
  );
  const { vectors, idf, vocabulary } = buildTfIdfIndex(texts);
  const indexOf = new Map(vocabulary.map((term, i) => [term, i]));

  const qVec = new Array(vocabulary.length).fill(0);
  const qtf = new Map();
  for (const term of qTerms) {
    qtf.set(term, (qtf.get(term) || 0) + 1);
  }
  for (const [term, count] of qtf) {
    if (indexOf.has(term)) {
      const i = indexOf.get(term);
      qVec[i] = (count / qTerms.length) * idf[i];
    }
  }

  const scored = docs.map((doc, i) => ({
    id: doc.id,
    text: doc.text,
    meta: doc.meta,
    score: cosineSim(qVec, vectors[i]),
    _i: i,
  }));
  scored.sort((a, b) => b.score - a.score || a._i - b._i);

  const k = Number.isInteger(topK) && topK > 0 ? topK : 5;
  return scored.slice(0, k).map(({ _i, ...rest }) => rest);
};

// POST the input batch to an OpenAI-compatible embeddings endpoint and
// return the vectors in input order. Called ONLY when the user configured
// EMBEDDING_PROVIDER — never in the default path, never in tests.
const embedBatch = async ({ url, apiKey, model, texts }) => {
  const input = (Array.isArray(texts) ? texts : [texts]).map((t) =>
    String(t ?? "")
  );
  if (input.length === 0) return [];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch (readErr) {
      // ignore — the status code is enough
    }
    throw new Error(
      `Embedding API error (${res.status}): ${String(detail).slice(0, 200)}`
    );
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error("Embedding API returned an unexpected response shape");
  }
  return body.data
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
};

// Pick the embedding provider from the environment.
//   - EMBEDDING_PROVIDER unset (or "local") -> { name: "local", embed: null }
//     (default: no external calls, pure local TF-IDF retrieval).
//   - "openai"  + OPENAI_API_KEY -> OpenAI text-embedding-3-small via fetch.
//   - "voyage"  + VOYAGE_API_KEY -> Voyage voyage-3-lite via fetch.
//   - anything else -> throws a clear Error.
// Groq offers NO embeddings API as of 2026-09-30, so it is not an option.
const getEmbeddingProvider = () => {
  const name = String(process.env.EMBEDDING_PROVIDER || "local")
    .trim()
    .toLowerCase();
  if (name === "local") {
    return { name: "local", embed: null };
  }
  if (name === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        'EMBEDDING_PROVIDER="openai" requires OPENAI_API_KEY to be set'
      );
    }
    return {
      name: "openai",
      embed: async (texts) =>
        embedBatch({
          url: "https://api.openai.com/v1/embeddings",
          apiKey: process.env.OPENAI_API_KEY,
          model: "text-embedding-3-small",
          texts,
        }),
    };
  }
  if (name === "voyage") {
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error(
        'EMBEDDING_PROVIDER="voyage" requires VOYAGE_API_KEY to be set'
      );
    }
    return {
      name: "voyage",
      embed: async (texts) =>
        embedBatch({
          url: "https://api.voyageai.com/v1/embeddings",
          apiKey: process.env.VOYAGE_API_KEY,
          model: "voyage-3-lite",
          texts,
        }),
    };
  }
  throw new Error(
    `Unknown EMBEDDING_PROVIDER "${name}" — expected "local", "openai", or "voyage"`
  );
};

// Atlas Vector Search wiring as DATA, not executed. Callers can copy
// indexDefinition into an Atlas Search index and run the pipeline against a
// live cluster — but THIS BUILD has no live cluster, so the pipeline is
// documentation only (see backend/RAG.md). The "queryVector" placeholder
// would be replaced by getEmbeddingProvider().embed([question])[0].
const atlasVectorSearchHint = () => ({
  indexName: "meeting_chunks_vector",
  indexDefinition: {
    name: "meeting_chunks_vector",
    // Create this in Atlas UI (Search -> Create Search Index -> JSON editor)
    // or via the Atlas Admin API on the collection that stores chunks.
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          embedding: {
            type: "knnVector",
            dimensions: 1536, // matches text-embedding-3-small output width
            similarity: "cosine",
          },
          meetingId: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
  pipeline: [
    {
      $vectorSearch: {
        index: "meeting_chunks_vector",
        path: "embedding",
        queryVector:
          "<QUERY_EMBEDDING: getEmbeddingProvider().embed([question])[0]>",
        numCandidates: 100,
        limit: 5,
      },
    },
    {
      $project: {
        meetingId: 1,
        title: 1,
        chunkIndex: 1,
        text: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ],
});

module.exports = {
  chunkText,
  hashFeatures,
  cosineSim,
  buildTfIdfIndex,
  retrieve,
  getEmbeddingProvider,
  atlasVectorSearchHint,
};
