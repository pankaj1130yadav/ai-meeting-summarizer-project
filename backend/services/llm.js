// ===== P11: LLM integration service (Groq) =====
// Pure-ish helpers + a thin Groq client wrapper for meeting intelligence.
// NEVER log transcript or prompt content here — logLLMUsage only records
// metadata (model, latency, tokens, op, meetingId).
//
// Contract used by server.js:
//   - chatCompletion({ system, user, json, maxTokens }) -> { text, latencyMs,
//     promptTokens, completionTokens, model }
//   - logLLMUsage({ model, latencyMs, promptTokens, completionTokens, meetingId, op })
//   - Prompt builders are versioned (PROMPT_VERSION) and exported for tests.

const Groq = require("groq-sdk");

// Version tag baked into every prompt built by this module, so prompt
// changes are traceable per request.
const PROMPT_VERSION = "v1";

// Default Groq chat model. Keep this value stable — it was verified live
// on 2026-09-30 and several call sites depend on it as the fallback.
const DEFAULT_MODEL = "openai/gpt-oss-120b";

// Maximum transcript characters passed to the LLM. Keep prompts bounded.
const MAX_TRANSCRIPT_CHARS = 12000;

// A groq-sdk client is only constructed lazily inside chatCompletion (so
// requiring this module never touches the network or needs a key).

// Trim a transcript to maxChars characters. When truncated, appends a
// "…[truncated]" marker so the model knows content was cut off.
// Null-safe: null/undefined/non-string input yields "".
const truncateTranscript = (text, maxChars = MAX_TRANSCRIPT_CHARS) => {
  if (typeof text !== "string") return "";
  if (typeof maxChars !== "number" || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  // Reserve room for the marker; never slice negative.
  const marker = "…[truncated]";
  const cut = Math.max(0, maxChars - marker.length);
  return text.slice(0, cut) + marker;
};

// Parse LLM output expected to be JSON. Strips a single ```json / ```
// code fence first (models love fences even when told not to). Throws
// Error("LLM returned invalid JSON") when parsing fails.
const safeParseJson = (text) => {
  if (typeof text !== "string") {
    throw new Error("LLM returned invalid JSON");
  }
  let cleaned = text.trim();
  // ```json\n...\n``` or ```\n...\n``` — strip the outer fence.
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error("LLM returned invalid JSON");
  }
};

// System prompt for meeting chat: grounds the model strictly in the
// provided transcript and forbids invented facts.
const buildChatSystemPrompt = () =>
  `You are a meeting assistant. Answer ONLY from the meeting transcript provided. If the answer is not in the transcript, say so honestly. Do not invent facts. [prompt:${PROMPT_VERSION}]`;

// User prompt asking the model for a STRICT JSON extraction of meeting
// intelligence. The caller must pass an already-truncated transcript.
const buildSummarizeUserPrompt = (transcript) =>
  `Extract structured meeting intelligence from the transcript below and return STRICT JSON only — no prose, no code fences. Use exactly these keys:
{
  "summary": string,
  "keyPoints": string[],
  "decisions": string[],
  "risks": string[],
  "blockers": string[],
  "openQuestions": string[],
  "importantTopics": string[],
  "actionItems": [{ "text": string, "assignee": string|null, "deadline": string|null, "priority": "High"|"Medium"|"Low" }]
}
[prompt:${PROMPT_VERSION}]

Transcript:
${transcript}`;

const AI_PRIORITIES = ["High", "Medium", "Low"];

// Coerce a string array: keep non-empty trimmed strings, dedupe
// case-insensitively, cap at 20.
const coerceStringArray = (value, cap = 20) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
};

// Coerce a single AI action item to { text, assignee, deadline, priority }.
// text must be a non-empty string (item is dropped otherwise); priority is
// validated against High|Medium|Low and defaults to Medium.
const coerceActionItem = (item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text) return null;
  const assignee =
    typeof item.assignee === "string" && item.assignee.trim()
      ? item.assignee.trim()
      : null;
  const deadline =
    typeof item.deadline === "string" && item.deadline.trim()
      ? item.deadline.trim()
      : null;
  const priority = AI_PRIORITIES.includes(item.priority)
    ? item.priority
    : "Medium";
  return { text, assignee, deadline, priority };
};

// Validate/coerce the parsed AI summary into the contract shape.
// Throws when obj is not a plain object.
const validateAiSummary = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("AI summary must be an object");
  }
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "";
  const items = Array.isArray(obj.actionItems) ? obj.actionItems : [];
  const actionItems = [];
  for (const item of items) {
    const coerced = coerceActionItem(item);
    if (coerced) actionItems.push(coerced);
    if (actionItems.length >= 20) break;
  }
  return {
    summary,
    keyPoints: coerceStringArray(obj.keyPoints),
    decisions: coerceStringArray(obj.decisions),
    risks: coerceStringArray(obj.risks),
    blockers: coerceStringArray(obj.blockers),
    openQuestions: coerceStringArray(obj.openQuestions),
    importantTopics: coerceStringArray(obj.importantTopics),
    actionItems,
  };
};

// Call the configured LLM provider for a chat completion.
// provider = process.env.LLM_PROVIDER || "groq" — only "groq" is supported.
// model    = process.env.LLM_MODEL   || DEFAULT_MODEL (openai/gpt-oss-120b).
// Throws a clear error when GROQ_API_KEY is missing, and wraps provider
// errors as Error("LLM call failed: " + message).
// Returns { text, latencyMs, promptTokens, completionTokens, model }.
// Transcript/prompt content is never logged by this function.
const chatCompletion = async ({
  system,
  user,
  json = false,
  maxTokens = 1500,
} = {}) => {
  const provider = process.env.LLM_PROVIDER || "groq";
  if (provider !== "groq") {
    throw new Error(
      `Unsupported LLM provider "${provider}" — only "groq" is supported`
    );
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set — LLM features are unavailable");
  }
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const started = Date.now();
  let completion;
  try {
    completion = await groq.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    });
  } catch (err) {
    throw new Error(`LLM call failed: ${err && err.message ? err.message : err}`);
  }
  const latencyMs = Date.now() - started;
  const choice = completion && completion.choices && completion.choices[0];
  const text =
    (choice && choice.message && choice.message.content) || "";
  const usage = (completion && completion.usage) || {};
  return {
    text,
    latencyMs,
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    completionTokens:
      typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    model,
  };
};

// Log LLM usage metadata ONLY — never the transcript, prompt, or response
// text. Emits a single JSON line under the [LLM] tag.
const logLLMUsage = ({
  model,
  latencyMs,
  promptTokens,
  completionTokens,
  meetingId,
  op,
} = {}) => {
  console.log(
    "[LLM]",
    JSON.stringify({
      op: op || "unknown",
      model: model || "unknown",
      latencyMs: typeof latencyMs === "number" ? latencyMs : null,
      promptTokens: typeof promptTokens === "number" ? promptTokens : null,
      completionTokens:
        typeof completionTokens === "number" ? completionTokens : null,
      meetingId: meetingId ? String(meetingId) : null,
    })
  );
};

module.exports = {
  PROMPT_VERSION,
  DEFAULT_MODEL,
  MAX_TRANSCRIPT_CHARS,
  truncateTranscript,
  safeParseJson,
  buildChatSystemPrompt,
  buildSummarizeUserPrompt,
  validateAiSummary,
  chatCompletion,
  logLLMUsage,
};
