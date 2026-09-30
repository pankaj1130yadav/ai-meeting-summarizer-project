// Unit tests for P11 LLM integration (backend/services/llm.js + the
// P11 rule-based fallback helper in server.js).
//
// services/llm.js is loaded via the source-extraction pattern (slice off the
// module.exports tail, run the body through `new Function`) so the tests run
// against the real code without booting the app. The server.js fallback
// helper is extracted between the P11 markers together with the P2 block
// that defines splitSentences. NO live LLM calls are made in these tests.
const fs = require("fs");
const assert = require("assert");

// ---- Load services/llm.js (extraction pattern) ----
const llmSrc = fs.readFileSync(__dirname + "/services/llm.js", "utf8");
const cutAt = llmSrc.lastIndexOf("module.exports");
assert.ok(cutAt !== -1, "llm.js module.exports not found");
const llmFactory = new Function(
  "require",
  llmSrc.slice(0, cutAt) +
    "\nreturn { PROMPT_VERSION, truncateTranscript, safeParseJson, " +
    "buildChatSystemPrompt, buildSummarizeUserPrompt, validateAiSummary, " +
    "chatCompletion, logLLMUsage, DEFAULT_MODEL };"
);
const {
  PROMPT_VERSION,
  truncateTranscript,
  safeParseJson,
  buildChatSystemPrompt,
  buildSummarizeUserPrompt,
  validateAiSummary,
  chatCompletion,
  logLLMUsage,
  DEFAULT_MODEL,
} = llmFactory(require);

// ---- Load answerMeetingQuestion from server.js (extraction pattern) ----
const serverSrc = fs.readFileSync(__dirname + "/server.js", "utf8");
const sliceBlock = (startMarker, endMarker) => {
  const start = serverSrc.indexOf(startMarker);
  const end = serverSrc.indexOf(endMarker);
  assert.ok(
    start !== -1 && end !== -1 && end > start,
    "markers not found: " + startMarker
  );
  return serverSrc.slice(start, end);
};
// P11 block references splitSentences, which lives in the P2 block —
// extract both into one scope.
const helpersFactory = new Function(
  sliceBlock("// ===== P2 HELPERS START =====", "// ===== P2 HELPERS END =====") +
    "\n" +
    sliceBlock("// ===== P11 HELPERS START =====", "// ===== P11 HELPERS END =====") +
    "\nreturn { answerMeetingQuestion };"
);
const { answerMeetingQuestion } = helpersFactory();

let passed = 0;
let plannedAsync = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};
const ta = async (name, fn) => {
  plannedAsync++;
  await fn();
  passed++;
  console.log("ok -", name);
};

(async () => {
  // ---------- truncateTranscript ----------
  t("truncateTranscript: under-limit text returned unchanged", () => {
    assert.strictEqual(truncateTranscript("hello", 12000), "hello");
  });
  t("truncateTranscript: over-limit text truncated with marker", () => {
    const long = "x".repeat(13000);
    const out = truncateTranscript(long, 12000);
    assert.ok(out.endsWith("…[truncated]"), "must end with marker");
    assert.strictEqual(out.length, 12000, "output is exactly maxChars");
    assert.ok(!out.includes("…[truncated]…[truncated]"));
  });
  t("truncateTranscript: exactly-at-limit text unchanged (no marker)", () => {
    const s = "y".repeat(100);
    assert.strictEqual(truncateTranscript(s, 100), s);
  });
  t("truncateTranscript: null/undefined/non-string -> empty string", () => {
    assert.strictEqual(truncateTranscript(null), "");
    assert.strictEqual(truncateTranscript(undefined), "");
    assert.strictEqual(truncateTranscript(12345), "");
    assert.strictEqual(truncateTranscript({}), "");
  });
  t("truncateTranscript: custom maxChars respected", () => {
    const out = truncateTranscript("x".repeat(100), 20);
    assert.ok(out.endsWith("…[truncated]"));
    assert.strictEqual(out.length, 20);
    // Degenerate case: maxChars smaller than the marker itself — the marker
    // is always emitted so truncation stays visible.
    const tiny = truncateTranscript("abcdef", 5);
    assert.ok(tiny.endsWith("…[truncated]"));
  });

  // ---------- safeParseJson ----------
  t("safeParseJson: plain JSON parses", () => {
    assert.deepStrictEqual(safeParseJson('{"a":1}'), { a: 1 });
  });
  t("safeParseJson: ```json fenced JSON parses", () => {
    const fenced = '```json\n{"summary":"hi","keyPoints":[]}\n```';
    assert.deepStrictEqual(safeParseJson(fenced), {
      summary: "hi",
      keyPoints: [],
    });
  });
  t("safeParseJson: bare ``` fenced JSON parses", () => {
    assert.deepStrictEqual(safeParseJson("```\n[1,2]\n```"), [1, 2]);
  });
  t("safeParseJson: invalid JSON throws Error('LLM returned invalid JSON')", () => {
    assert.throws(() => safeParseJson("not json at all"), (err) => {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.message, "LLM returned invalid JSON");
      return true;
    });
  });
  t("safeParseJson: truncated JSON throws", () => {
    assert.throws(
      () => safeParseJson('{"summary":"oops'),
      /LLM returned invalid JSON/
    );
  });
  t("safeParseJson: non-string input throws", () => {
    assert.throws(() => safeParseJson(null), /LLM returned invalid JSON/);
  });

  // ---------- validateAiSummary ----------
  t("validateAiSummary: valid object coerced to full shape", () => {
    const out = validateAiSummary({
      summary: " Team agreed to ship. ",
      keyPoints: ["a", "b"],
      decisions: ["decided to ship"],
      risks: [],
      blockers: [],
      openQuestions: [],
      importantTopics: [],
      actionItems: [
        { text: "Write docs", assignee: "Pankaj", deadline: "Friday", priority: "High" },
      ],
    });
    assert.strictEqual(out.summary, "Team agreed to ship.");
    assert.deepStrictEqual(out.keyPoints, ["a", "b"]);
    assert.deepStrictEqual(out.decisions, ["decided to ship"]);
    assert.deepStrictEqual(out.actionItems, [
      {
        text: "Write docs",
        assignee: "Pankaj",
        deadline: "Friday",
        priority: "High",
      },
    ]);
  });
  t("validateAiSummary: non-string array entries dropped, empties dropped", () => {
    const out = validateAiSummary({ summary: "s", keyPoints: [1, null, "  ", "ok"] });
    assert.deepStrictEqual(out.keyPoints, ["ok"]);
  });
  t("validateAiSummary: invalid priority defaults to Medium", () => {
    const out = validateAiSummary({
      actionItems: [{ text: "t", priority: "Critical" }],
    });
    assert.strictEqual(out.actionItems[0].priority, "Medium");
  });
  t("validateAiSummary: action item without text is dropped", () => {
    const out = validateAiSummary({
      actionItems: [{ assignee: "x" }, { text: "keep" }],
    });
    assert.strictEqual(out.actionItems.length, 1);
    assert.strictEqual(out.actionItems[0].text, "keep");
  });
  t("validateAiSummary: assignee/deadline default to null when blank", () => {
    const out = validateAiSummary({ actionItems: [{ text: "t" }] });
    assert.deepStrictEqual(out.actionItems[0], {
      text: "t",
      assignee: null,
      deadline: null,
      priority: "Medium",
    });
  });
  t("validateAiSummary: string arrays capped at 20", () => {
    const many = Array.from({ length: 50 }, (_, i) => "p" + i);
    const out = validateAiSummary({ keyPoints: many });
    assert.strictEqual(out.keyPoints.length, 20);
  });
  t("validateAiSummary: missing keys default to empty, summary to ''", () => {
    const out = validateAiSummary({});
    assert.strictEqual(out.summary, "");
    for (const k of ["keyPoints", "decisions", "risks", "blockers", "openQuestions", "importantTopics", "actionItems"]) {
      assert.deepStrictEqual(out[k], [], k);
    }
  });
  t("validateAiSummary: throws on non-object", () => {
    assert.throws(() => validateAiSummary(null), /must be an object/);
    assert.throws(() => validateAiSummary("x"), /must be an object/);
    assert.throws(() => validateAiSummary([1]), /must be an object/);
  });

  // ---------- Prompt builders ----------
  t("PROMPT_VERSION is v1", () => {
    assert.strictEqual(PROMPT_VERSION, "v1");
  });
  t("DEFAULT_MODEL is openai/gpt-oss-120b", () => {
    assert.strictEqual(DEFAULT_MODEL, "openai/gpt-oss-120b");
  });
  t("buildChatSystemPrompt contains grounding instruction", () => {
    const p = buildChatSystemPrompt();
    assert.ok(
      p.includes("ONLY from the meeting transcript"),
      "must contain grounding phrase"
    );
    assert.ok(p.includes("Do not invent facts"), "must forbid invented facts");
  });
  t("buildSummarizeUserPrompt demands strict JSON with all keys", () => {
    const p = buildSummarizeUserPrompt("Alice: we decided to ship.");
    assert.ok(p.includes("STRICT JSON"));
    for (const k of [
      "summary",
      "keyPoints",
      "decisions",
      "risks",
      "blockers",
      "openQuestions",
      "importantTopics",
      "actionItems",
    ]) {
      assert.ok(p.includes('"' + k + '"'), "missing key " + k);
    }
    assert.ok(p.includes("Alice: we decided to ship."), "transcript embedded");
  });

  // ---------- chatCompletion error paths (no network) ----------
  await ta("chatCompletion: missing GROQ_API_KEY throws clear error", async () => {
    const savedKey = process.env.GROQ_API_KEY;
    const savedProvider = process.env.LLM_PROVIDER;
    delete process.env.GROQ_API_KEY;
    delete process.env.LLM_PROVIDER;
    try {
      await assert.rejects(
        chatCompletion({ system: "s", user: "u" }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("GROQ_API_KEY"),
            "message names the missing key: " + err.message
          );
          return true;
        }
      );
    } finally {
      if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
      if (savedProvider !== undefined) process.env.LLM_PROVIDER = savedProvider;
    }
  });
  await ta("chatCompletion: unsupported LLM_PROVIDER throws", async () => {
    const savedProvider = process.env.LLM_PROVIDER;
    const savedKey = process.env.GROQ_API_KEY;
    process.env.LLM_PROVIDER = "openai";
    process.env.GROQ_API_KEY = "dummy-key-for-provider-check";
    try {
      await assert.rejects(
        chatCompletion({ system: "s", user: "u" }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('only "groq" is supported'),
            "message explains groq-only: " + err.message
          );
          return true;
        }
      );
    } finally {
      if (savedProvider !== undefined) process.env.LLM_PROVIDER = savedProvider;
      else delete process.env.LLM_PROVIDER;
      if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
      else delete process.env.GROQ_API_KEY;
    }
  });

  // ---------- logLLMUsage: metadata only ----------
  t("logLLMUsage: logs JSON metadata, never transcript text", () => {
    const sentinel = "SENTINEL_TRANSCRIPT_NEVER_LOG_ME_12345";
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      logLLMUsage({
        model: "openai/gpt-oss-120b",
        latencyMs: 123,
        promptTokens: 10,
        completionTokens: 5,
        meetingId: "abc123",
        op: "chat",
      });
    } finally {
      console.log = orig;
    }
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].startsWith("[LLM]"), "tagged [LLM]");
    assert.ok(!lines[0].includes(sentinel), "transcript never appears");
    const payload = JSON.parse(lines[0].slice("[LLM]".length).trim());
    assert.deepStrictEqual(Object.keys(payload).sort(), [
      "completionTokens",
      "latencyMs",
      "meetingId",
      "model",
      "op",
      "promptTokens",
    ]);
    assert.strictEqual(payload.model, "openai/gpt-oss-120b");
    assert.strictEqual(payload.op, "chat");
  });

  // ---------- answerMeetingQuestion (rule-based fallback) ----------
  t("answerMeetingQuestion: returns best-matching transcript sentence", () => {
    const transcript =
      "Alice: we decided to ship the API on Friday. Bob: the launch party is next month.";
    const reply = answerMeetingQuestion("When do we ship the API?", transcript);
    assert.ok(reply.includes("ship the API on Friday"), "got: " + reply);
    assert.ok(reply.startsWith("Based on the transcript:"));
  });
  t("answerMeetingQuestion: honest when no match", () => {
    const reply = answerMeetingQuestion(
      "What is the weather today?",
      "Alice: we decided to ship on Friday."
    );
    assert.strictEqual(
      reply,
      "This information was not discussed in the meeting."
    );
  });
  t("answerMeetingQuestion: empty transcript is handled", () => {
    assert.strictEqual(
      answerMeetingQuestion("anything?", "   "),
      "There is no transcript available for this meeting."
    );
    assert.strictEqual(
      answerMeetingQuestion("anything?", null),
      "There is no transcript available for this meeting."
    );
  });
  t("answerMeetingQuestion: empty question is handled", () => {
    assert.strictEqual(
      answerMeetingQuestion("  ", "Alice: hello."),
      "Please ask a question about this meeting."
    );
  });

  console.log(
    "\nphase11-llm: " + passed + " passed (" + plannedAsync + " async), 0 failed"
  );
})().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exit(1);
});
