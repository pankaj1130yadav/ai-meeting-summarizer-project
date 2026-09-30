const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const cors = require("cors");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const http = require("http");
require("dotenv").config();

// ===== P7 SECURITY: Startup env validation =====
// JWT_SECRET is mandatory — without it tokens can't be verified securely.
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set");
  process.exit(1);
}
if (!process.env.MONGO_URI) {
  console.warn("WARNING: MONGO_URI is not set — MongoDB will not connect");
}
if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is not set — AI features will fail");
}

// ===== P6 INTEGRATIONS: token-encryption startup check =====
// TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes). A missing/invalid key
// is NOT fatal: OAuth tokens fall back to base64 obfuscation (see the P6
// helpers block below). Warns once at boot, never crashes.
if (
  !/^[0-9a-fA-F]{64}$/.test(String(process.env.TOKEN_ENCRYPTION_KEY || ""))
) {
  console.warn(
    "[P6] TOKEN_ENCRYPTION_KEY not set — tokens stored base64-obfuscated, NOT encrypted. Set it for production."
  );
}

const app = express();

const Groq = require("groq-sdk");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== P11 LLM: Groq-backed meeting intelligence service =====
// chatCompletion / logLLMUsage / prompt builders / validation all live in
// backend/services/llm.js. Groq model default is openai/gpt-oss-120b.
const {
  PROMPT_VERSION,
  truncateTranscript,
  safeParseJson,
  buildChatSystemPrompt,
  buildSummarizeUserPrompt,
  validateAiSummary,
  chatCompletion,
  logLLMUsage,
} = require("./services/llm");

// ===== P12 RAG: retrieval-augmented Q&A across meetings =====
// chunkText / retrieve come from backend/services/rag.js. Retrieval is
// LOCAL lexical TF-IDF by default — Groq has no embeddings API, and no
// embedding provider is required or called here.
const {
  chunkText,
  hashFeatures,
  cosineSim,
  buildTfIdfIndex,
  retrieve,
  getEmbeddingProvider,
  atlasVectorSearchHint,
} = require("./services/rag");

// ===== BACKEND-CORE: meeting-insight helpers (sentiment, talk-time,
// follow-up detection, cost, recurrence) =====
// Pure, dependency-free rule-based helpers from backend/services/insights.js.
// Honest labeling: everything produced here is "rule-based", not AI.
const {
  analyzeSentiment,
  analyzeTalkTime,
  detectFollowUps,
  computeMeetingCost,
  nextRecurrenceDate,
} = require("./services/insights");

const upload = multer({
  dest: "uploads/",
});

// ===== P1-FIX-B1 HELPERS START =====
// Pure, dependency-free helpers for audio-upload validation.
// (Unit-tested by p1-fix-b1.test.js via source extraction.)
const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/aac",
  "audio/x-m4a",
];
const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".webm",
  ".flac",
  ".aac",
  ".mp4",
];

// True only when BOTH the reported MIME type and the file-name extension
// are on the allow lists. Checking both guards against a crafted MIME
// header and against a misleading file name.
const isAllowedAudioFile = (mimetype, originalname) => {
  if (typeof mimetype !== "string" || typeof originalname !== "string") {
    return false;
  }
  if (!AUDIO_MIME_TYPES.includes(mimetype)) return false;
  const name = originalname.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
};
// ===== P1-FIX-B1 HELPERS END =====

// Dedicated multer instance for audio transcription: 25MB cap and a
// strict audio-only fileFilter. Kept separate from the generic `upload`
// so non-audio upload flows stay untouched.
const audioUpload = multer({
  dest: "uploads/",
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isAllowedAudioFile(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported audio file type. Allowed formats: ${AUDIO_EXTENSIONS.join(", ")}`
        )
      );
    }
  },
});

// Wrap audioUpload.single("audio") so multer rejections (size/type)
// surface as HTTP 400 with clear messages instead of bubbling into
// Express's default error handler.
const handleAudioUpload = (req, res, next) => {
  audioUpload.single("audio")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "File too large (max 25MB)" });
      }
      return res
        .status(400)
        .json({ message: err.message || "Invalid audio file" });
    }
    next();
  });
};

// ===== P7 SECURITY: Rate limiters =====
// Auth endpoints: 100 requests per 15 min per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});
// Expensive AI endpoints: 30 requests per 15 min per IP.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

// ===== P7 SECURITY: hand-rolled auth body validators (no new dep) =====
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns an error message string, or null when the register body is valid.
const validateRegisterBody = (body = {}) => {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return "Name is required";
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return "A valid email address is required";
  }
  if (typeof body.password !== "string" || body.password.length < 6) {
    return "Password is required and must be at least 6 characters long";
  }
  return null;
};

// Returns an error message string, or null when the login body is valid.
// Wrong credentials still return the generic 400 below (no enumeration).
const validateLoginBody = (body = {}) => {
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return "A valid email address is required";
  }
  if (typeof body.password !== "string" || !body.password) {
    return "Password is required";
  }
  return null;
};

app.use(helmet());

// ===== P7 SECURITY: CORS allowlist =====
// Comma-separated list via CORS_ORIGIN; defaults to the local Vite dev server.
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim()),
    credentials: false,
  })
);

// ===== P7 SECURITY: 1MB JSON payload limit =====
app.use(express.json({ limit: "1mb" }));

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected successfully");
  })
  .catch((error) => {
    console.log("MongoDB connection error:", error.message);
  });

// User Schema
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    // P1-FIX-B2: password-reset token storage.
    // Stores ONLY the SHA-256 hex hash of the token (never the raw token).
    resetPasswordToken: {
      type: String,
      default: undefined,
    },
    resetPasswordExpires: {
      type: Date,
      default: undefined,
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

// ===== PHASE 1 HELPERS START =====
// Pure, dependency-free helpers for action-item CRUD + validation.
// (Unit-tested by phase1-helpers.test.js via source extraction.)
const ACTION_STATUSES = [
  "Pending",
  "In Progress",
  "Completed",
  "Overdue",
  "Cancelled",
];
const ACTION_PRIORITIES = ["Low", "Medium", "High"];
const MAX_ACTION_FIELD_LEN = 500;

// Validate an action-item index supplied as a URL param.
// Returns { ok: true, index } or { ok: false, status, message }.
const parseActionIndex = (raw, count) => {
  const idx = Number(raw);
  if (!Number.isInteger(idx)) {
    return {
      ok: false,
      status: 400,
      message: "Action item index must be an integer",
    };
  }
  if (idx < 0 || idx >= count) {
    return { ok: false, status: 404, message: "Action item not found" };
  }
  return { ok: true, index: idx };
};

// Validate create/update payloads for action items.
// partial=true  -> only validate fields that are present (PATCH)
// partial=false -> task is required (POST)
const validateActionItemInput = (input = {}, { partial = false } = {}) => {
  const errors = [];
  const value = {};

  const checkString = (key, { required = false, maxLen = MAX_ACTION_FIELD_LEN } = {}) => {
    const present = input[key] !== undefined && input[key] !== null;
    if (!present) {
      if (required && !partial) errors.push(`${key} is required`);
      return;
    }
    const str = String(input[key]).trim();
    if (required && !str) {
      errors.push(`${key} is required`);
      return;
    }
    if (str.length > maxLen) {
      errors.push(`${key} is too long (max ${maxLen} characters)`);
      return;
    }
    value[key] = str;
  };

  checkString("task", { required: true });
  checkString("assignedTo");
  checkString("deadline");

  if (input.priority !== undefined) {
    if (!ACTION_PRIORITIES.includes(input.priority)) {
      errors.push(`priority must be one of: ${ACTION_PRIORITIES.join(", ")}`);
    } else {
      value.priority = input.priority;
    }
  }

  if (input.status !== undefined) {
    if (!ACTION_STATUSES.includes(input.status)) {
      errors.push(`status must be one of: ${ACTION_STATUSES.join(", ")}`);
    } else {
      value.status = input.status;
    }
  }

  return { errors, value };
};
// ===== PHASE 1 HELPERS END =====

// ===== P1-INC2 HELPERS START =====
// Pure, dependency-free helpers for action-item deadline parsing + overdue
// detection. (Unit-tested by phase1-inc2.test.js via source extraction.)
//
// All parsed dates are local-midnight Date objects (start of day), so
// comparisons are day-granular and timezone-safe.
const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Build a local-midnight Date from components, or null if they don't form
// a real calendar date (rejects overflow like 2026-02-30 or month 13).
const makeLocalDate = (year, month, day) => {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  const d = new Date(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
};

// Parse a human-written deadline into a local-midnight Date, or null when
// unparseable. Supported (case-insensitive): ISO "YYYY-MM-DD",
// "DD/MM/YYYY", "DD-MM-YYYY", "today", "tomorrow", "day after tomorrow",
// and weekday names with optional "by"/"next" prefix ("Friday",
// "by Friday", "next Monday"). A bare weekday resolves to the upcoming
// such weekday, strictly after today (delta 1..7); "next X" resolves to
// that weekday in the following week (the upcoming one + 7 days).
// `now` is the reference instant for relative phrases; defaults to now.
const parseDueDate = (str, now = new Date()) => {
  if (typeof str !== "string") return null;
  const s = str.trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  const plusDays = (n) => {
    const d = new Date(todayStart);
    d.setDate(d.getDate() + n);
    return d;
  };

  // Relative keywords
  if (lower === "today") return plusDays(0);
  if (lower === "tomorrow") return plusDays(1);
  if (lower === "day after tomorrow") return plusDays(2);

  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return makeLocalDate(Number(m[1]), Number(m[2]), Number(m[3]));

  // DD/MM/YYYY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return makeLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));

  // DD-MM-YYYY
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return makeLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));

  // Weekday with optional by/next prefix
  m = lower.match(
    /^(?:(by|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/
  );
  if (m) {
    const prefix = m[1];
    const target = WEEKDAY_INDEX[m[2]];
    let delta = (target - todayStart.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // strictly after today
    if (prefix === "next") delta += 7; // that weekday in the following week
    return plusDays(delta);
  }

  return null;
};

// True only when the deadline parses to a real date strictly before today
// (start of day) and the item's status is neither "Completed" nor
// "Cancelled". Pure: never mutates `item`.
const isOverdueActionItem = (item, now = new Date()) => {
  if (!item || typeof item !== "object") return false;
  if (item.status === "Completed" || item.status === "Cancelled") return false;
  const due = parseDueDate(item.deadline, now);
  if (!due) return false;
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  return due < todayStart;
};
// ===== P1-INC2 HELPERS END =====

// ===== P2 HELPERS START =====
// Pure, dependency-free helpers for meeting intelligence extraction.
// All extraction below is RULE-BASED (regex / keyword frequency) —
// never label this output as AI-generated.
// (Unit-tested by phase2-extractors.test.js via source extraction.)

// Split text into sentences, keeping each sentence's trailing terminator.
// Returns [] for empty / non-string input.
const splitSentences = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const matches = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g);
  if (!matches) return [];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
};

// Dedupe (case-insensitive, keep first occurrence), then cap at `max`.
const dedupeCap = (items, max) => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
};

// Return sentences that match a decision pattern (decided / agreed),
// trimmed, deduped, max 10.
const extractDecisions = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const re =
    /\b(we |team )?(decided|agreed)\b|\bdecided to\b|\bagreed (to|on|that)\b/i;
  return dedupeCap(splitSentences(text).filter((s) => re.test(s)), 10);
};

// Return sentences that mention a risk keyword, trimmed, deduped, max 10.
const extractRisks = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const re = /\b(risk|risks|risky|concern|concerned|worried|threat)\b/i;
  return dedupeCap(splitSentences(text).filter((s) => re.test(s)), 10);
};

// Return sentences that mention a blocker keyword, trimmed, deduped, max 10.
const extractBlockers = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const re =
    /\b(blocked|blocker|blocking|stuck|waiting on|dependent on|dependency)\b/i;
  return dedupeCap(splitSentences(text).filter((s) => re.test(s)), 10);
};

// Return sentences (keeping their terminator) that end with "?",
// trimmed, deduped, max 10.
const extractOpenQuestions = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const questions = splitSentences(text).filter((s) => s.endsWith("?"));
  return dedupeCap(questions, 10);
};

// Inline stopword list (~45 common English words).
const TOPIC_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when",
  "while", "with", "without", "for", "from", "of", "on", "in", "to",
  "at", "by", "into", "over", "after", "before", "about", "as", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "can", "could", "should",
  "this", "that", "these", "those", "it", "its", "we", "they", "them",
  "you", "your", "our", "their", "not", "no", "yes", "so", "just",
  "also", "very", "much", "many", "more", "most", "some", "any",
  "there", "here", "what", "which", "who", "whom", "how", "why",
]);

// Word-frequency keywords: lowercase, strip punctuation, drop stopwords,
// words < 4 chars and pure numbers. Returns the top 8 words, ordered
// deterministically (count desc, then alphabetical). [] for empty/non-string.
const extractTopics = (text) => {
  if (typeof text !== "string" || !text.trim()) return [];
  const counts = new Map();
  const words = text
    .toLowerCase()
    .split(/[\s]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 4)
    .filter((w) => !/^\d+$/.test(w))
    .filter((w) => !TOPIC_STOPWORDS.has(w));
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 8)
    .map(([word]) => word);
};

// Sanitize the tags array from a request body: non-array -> [],
// trim each entry, drop empties, cap at 20.
const sanitizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim())
    .filter((t) => t.length > 0)
    .slice(0, 20);
};
// ===== P2 HELPERS END =====

// ===== P3 HELPERS START =====
// Pure, dependency-free helpers for dashboard analytics.
// (Unit-tested by phase3-analytics.test.js via source extraction.)

// ISO-8601 week key for a date: "YYYY-Www" (Monday-based weeks).
// Accepts a Date, timestamp, or date string; returns null for invalid input.
// Computed in UTC so local timezone / DST shifts can't flip the week.
const isoWeekKey = (input) => {
  if (input === null || input === undefined) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;

  // Truncate to the UTC calendar day, then shift to the Thursday of the
  // same ISO week — the ISO year is the year that Thursday falls in.
  const day = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay(); // Mon=1..Sun=7
  day.setUTCDate(day.getUTCDate() + (4 - isoDay));
  const isoYear = day.getUTCFullYear();

  // Monday of ISO week 1: back up from Jan 4th (always in week 1).
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4IsoDay = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4IsoDay - 1));

  const week = Math.round((day - week1Monday) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
};

// Coerce a durationMinutes request value: Number(), keep only when it is a
// finite number with 0 < n <= 1440 (one full day); null otherwise.
// Missing/empty input -> null (never stores garbage or 0-length meetings).
const coerceDurationMinutes = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1440) return null;
  return n;
};
// ===== P3 HELPERS END =====

// ===== BACKEND-CORE COERCE HELPERS =====
// Coerce an optional positive-number request value (hourlyRate,
// participantCount): Number(), keep only when finite and > 0, else null.
// Missing/empty input -> null (never stores garbage).
const coercePositiveNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};
// Coerce an optional recurrence config: valid only when frequency is one of
// weekly/biweekly/monthly (occurrences optional, coerced positive or null).
// Anything else -> null.
const coerceRecurrence = (value) => {
  if (value === undefined || value === null || typeof value !== "object") {
    return null;
  }
  const { frequency, occurrences } = value;
  if (
    frequency !== "weekly" &&
    frequency !== "biweekly" &&
    frequency !== "monthly"
  ) {
    return null;
  }
  return {
    frequency,
    occurrences: coercePositiveNumber(occurrences),
  };
};
// ===== BACKEND-CORE COERCE HELPERS END =====

// Meeting Schema
const meetingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true, // Phase 1: every meeting must belong to a user
    },
    title: {
      type: String,
      default: "Untitled Meeting",
    },
    category: {
      type: String,
      default: "General",
      enum: ["General", "Project", "College", "Client", "Personal", "Urgent"],
    },
    transcript: {
      type: String,
      required: true,
    },
    summary: {
      type: String,
      required: true,
    },
    keyPoints: [String],
    speakerNotes: [
      {
        speaker: String,
        note: String,
      },
    ],
    actionItems: [
      {
        // Phase 1: typed fields + enums so invalid data is rejected at the DB layer
        task: { type: String, required: true },
        assignedTo: { type: String, default: "Not specified" },
        deadline: { type: String, default: "Not specified" },
        priority: {
          type: String,
          enum: ACTION_PRIORITIES,
          default: "Medium",
        },
        status: {
          type: String,
          enum: ACTION_STATUSES,
          default: "Pending",
        },
      },
    ],
    // Phase 2 (P2): meeting intelligence fields. All extraction is
    // rule-based (see extractDecisions / extractRisks / extractBlockers /
    // extractOpenQuestions / extractTopics) — extractionMethod records that.
    manualNotes: { type: String, default: "" },
    tags: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    risks: { type: [String], default: [] },
    blockers: { type: [String], default: [] },
    openQuestions: { type: [String], default: [] },
    importantTopics: { type: [String], default: [] },
    extractionMethod: {
      type: String,
      // P11: "llm" added — honest labeling of AI-extracted intelligence
      // (POST /api/meetings/:id/ai-summary?save=true). Existing rule-based
      // flows keep writing "rule-based"; the default is unchanged.
      enum: ["rule-based", "llm"],
      default: "rule-based",
    },
    // P3: optional meeting length in minutes. Accepted on POST/PUT; only
    // stored when it coerces to a finite number with 0 < n <= 1440, else null.
    durationMinutes: { type: Number, default: null },
    // BACKEND-CORE: optional cost inputs. Accepted on POST/PUT; stored only
    // when each coerces to a finite number > 0, else null. Combined with
    // durationMinutes, computeMeetingCost() derives an attendee-cost estimate.
    hourlyRate: { type: Number, default: null },
    participantCount: { type: Number, default: null },
    // BACKEND-CORE: optional recurrence config { frequency, occurrences }.
    recurrence: {
      frequency: {
        type: String,
        enum: ["weekly", "biweekly", "monthly"],
        default: null,
      },
      occurrences: { type: Number, default: null },
    },
    // BACKEND-CORE: rule-based sentiment of the transcript (refreshed on
    // create and whenever the transcript changes). Label is honest:
    // computed by analyzeSentiment(), never AI.
    sentiment: {
      score: { type: Number, default: 0 },
      label: { type: String, default: "Neutral" },
    },
    // P4: workspace collaboration. A meeting can be shared to a workspace
    // (visibility "workspace") or kept visible to its owner only ("private").
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
    },
    visibility: {
      type: String,
      enum: ["private", "workspace"],
      default: "private",
    },
  },
  { timestamps: true }
);

// Phase 1: index for the user-scoped, newest-first history query
meetingSchema.index({ user: 1, createdAt: -1 });

// P4: index for workspace-scoped, visibility-filtered meeting queries
meetingSchema.index({ workspace: 1, visibility: 1 });

const Meeting = mongoose.model("Meeting", meetingSchema);

// ===== P4: Workspace + AuditLog models =====
// Workspace: owner + members (admin/manager/member roles). Invite links use
// a token whose raw value is never persisted — only its SHA-256 hash plus
// an expiry are stored (same pattern as the P1 password-reset tokens).
const workspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        role: {
          type: String,
          enum: ["admin", "manager", "member"],
          default: "member",
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    inviteTokenHash: {
      type: String,
      default: undefined,
    },
    inviteExpires: {
      type: Date,
      default: undefined,
    },
  },
  { timestamps: true }
);
workspaceSchema.index({ owner: 1 });

const Workspace = mongoose.model("Workspace", workspaceSchema);

// AuditLog: append-only audit trail for workspace + sharing actions.
// Newest-first per workspace is served by the compound index.
const auditLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    action: {
      type: String,
      required: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
    },
    meeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
    },
    details: {
      type: Object,
    },
  },
  { timestamps: true }
);
auditLogSchema.index({ workspace: 1, createdAt: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

// ===== P5: Notification + Preference models =====
// Notification: in-app notifications. dedupeKey makes the reminder job
// idempotent — unique + sparse (only set when the job supplies one), so a
// notification for the same (type, meeting, item, day) can never be created
// twice. NOTE: email is STUBBED in this project (no SMTP). Notifications
// are the delivery channel; email only fires behind EMAIL_ENABLED=true via
// a stub mailer that logs and never sends.
const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "deadline_reminder",
        "overdue",
        "workspace_invite",
        "meeting_shared",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
    },
    meeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Meeting",
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
    },
    dedupeKey: {
      type: String,
      unique: true,
      sparse: true,
    },
    read: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
    },
  },
  { timestamps: true }
);
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

const Notification = mongoose.model("Notification", notificationSchema);

// Preference: per-user reminder/notification settings. A missing document
// means "defaults" — the GET /api/users/me/preferences route returns the
// defaults WITHOUT creating a document. NOTE: setting emailEnabled=true
// here does NOT send email — email stays stubbed behind the EMAIL_ENABLED
// env flag (see backend/scripts/reminders.js).
const preferenceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    emailEnabled: {
      type: Boolean,
      default: false,
    },
    reminderHoursBefore: {
      type: Number,
      default: 24,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
    },
  },
  { timestamps: true }
);

const Preference = mongoose.model("Preference", preferenceSchema);

// ===== P6: OAuth token storage =====
// One row per (user, provider). accessToken/refreshToken are stored
// AES-256-GCM-encrypted when TOKEN_ENCRYPTION_KEY is set, otherwise
// base64-obfuscated (see storeTokenSecret in the P6 helpers block).
const tokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: {
      type: String,
      enum: ["google", "slack"],
      required: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
    },
    expiresAt: {
      type: Date,
    },
    scope: {
      type: String,
    },
  },
  { timestamps: true }
);
tokenSchema.index({ user: 1, provider: 1 }, { unique: true });

const Token = mongoose.model("Token", tokenSchema);

// ===== P4 HELPERS START =====
// Pure, dependency-free helpers for workspace RBAC + meeting visibility.
// (Unit-tested by phase4-workspaces.test.js via source extraction.)
//
// getWorkspaceRole(workspace, userId) → "owner" | "admin" | "manager" |
// "member" | null. Tolerates populated or raw ObjectIds (compares via
// String()) so it works with hydrated docs, .lean() docs, and mocks.
const getWorkspaceRole = (workspace, userId) => {
  if (!workspace || !userId) return null;
  const uid = String(userId);
  const ownerId =
    workspace.owner && workspace.owner._id ? workspace.owner._id : workspace.owner;
  if (ownerId && String(ownerId) === uid) return "owner";
  const members = Array.isArray(workspace.members) ? workspace.members : [];
  for (const m of members) {
    if (!m) continue;
    const memberId = m.user && m.user._id ? m.user._id : m.user;
    if (memberId && String(memberId) === uid) {
      return typeof m.role === "string" ? m.role : "member";
    }
  }
  return null;
};

// canReadMeeting(meeting, workspace, userId) → boolean. Pure, no DB.
// True when the requester owns the meeting, or when the meeting is shared
// to a workspace (visibility === "workspace") and the requester holds any
// role in that workspace.
const canReadMeeting = (meeting, workspace, userId) => {
  if (!meeting || !userId) return false;
  const meetingOwnerId =
    meeting.user && meeting.user._id ? meeting.user._id : meeting.user;
  if (meetingOwnerId && String(meetingOwnerId) === String(userId)) return true;
  if (
    meeting.visibility === "workspace" &&
    workspace &&
    getWorkspaceRole(workspace, userId)
  ) {
    return true;
  }
  return false;
};
// ===== P4 HELPERS END =====

// ===== P5 HELPERS START =====
// Pure, dependency-free helpers for notifications & reminders.
// (Unit-tested by phase5-notifications.test.js via source extraction.)
//
// buildDedupeKey(type, meetingId, itemIndex, date) -> the idempotency key
// used by the reminder job so a notification for the same
// (type, meeting, item, day) is never created twice, e.g.
//   "deadline_reminder:<meetingId>:<idx>:<YYYY-MM-DD>"
// The date is rendered as YYYY-MM-DD in UTC. Pure and null-safe: returns
// null when any input is missing (null/undefined/empty type) or the date
// is invalid/unparseable.
const buildDedupeKey = (type, meetingId, itemIndex, date) => {
  if (
    typeof type !== "string" ||
    !type ||
    meetingId === null ||
    meetingId === undefined ||
    itemIndex === null ||
    itemIndex === undefined
  ) {
    return null;
  }
  const d =
    date instanceof Date
      ? date
      : date === null || date === undefined || typeof date === "boolean"
        ? null // new Date(null)/new Date(false) silently coerce to epoch
        : new Date(date);
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const day = d.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  return `${type}:${String(meetingId)}:${String(itemIndex)}:${day}`;
};

// isReminderDue(deadline, now, hoursBefore) -> true when `deadline` is
// strictly in the future relative to `now` and no more than `hoursBefore`
// hours away: diff in (0, hoursBefore] hours. Pure; anything unparseable
// (garbage deadline, invalid `now`, non-positive/non-numeric window)
// yields false. Accepts Date objects, date strings, or timestamps.
const isReminderDue = (deadline, now = new Date(), hoursBefore = 24) => {
  const toDate = (v) => {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === "string" || typeof v === "number") {
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  const due = toDate(deadline);
  const ref = toDate(now);
  const window = Number(hoursBefore);
  if (!due || !ref || !Number.isFinite(window) || window <= 0) return false;
  const diffMs = due.getTime() - ref.getTime();
  return diffMs > 0 && diffMs <= window * 3600 * 1000;
};
// ===== P5 HELPERS END =====

// ===== P6 HELPERS START =====
// Pure, dependency-free helpers for OAuth token encryption + the Google
// OAuth2 authorization URL. (Unit-tested by
// backend/phase6-integrations.test.js via source extraction.)
//
// "Pure" here means the key is passed in by the caller — encryptToken /
// decryptToken never read process.env themselves. The route-facing wrappers
// storeTokenSecret / loadTokenSecret exist precisely to pick encryption vs.
// obfuscation based on the env.

// Base64 obfuscation fallback used when TOKEN_ENCRYPTION_KEY is missing or
// invalid. This is NOT encryption — it only keeps tokens out of plain sight.
const obfuscate = (plain) => {
  if (typeof plain !== "string") {
    throw new Error("obfuscate: input must be a string");
  }
  return Buffer.from(plain, "utf8").toString("base64");
};

const deobfuscate = (payload) => {
  if (typeof payload !== "string" || !payload) {
    throw new Error("deobfuscate: payload must be a non-empty string");
  }
  const decoded = Buffer.from(payload, "base64").toString("utf8");
  if (!decoded) {
    throw new Error("deobfuscate: payload is not valid base64");
  }
  return decoded;
};

// True only when keyHex is 64 hex characters (= 32 bytes) for AES-256.
const isValidEncryptionKeyHex = (keyHex) =>
  typeof keyHex === "string" && /^[0-9a-fA-F]{64}$/.test(keyHex);

// encryptToken(plain, keyHex): AES-256-GCM. Returns
// "ivHex:cipherHex:authTagHex". Throws on bad input. Uses a fresh random
// 96-bit IV per call, so identical inputs encrypt to different payloads.
const encryptToken = (plain, keyHex) => {
  if (typeof plain !== "string") {
    throw new Error("encryptToken: plain must be a string");
  }
  if (!isValidEncryptionKeyHex(keyHex)) {
    throw new Error("encryptToken: keyHex must be 64 hex chars (32 bytes)");
  }
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${authTag.toString("hex")}`;
};

// decryptToken(payload, keyHex): inverse of encryptToken. Throws on a
// malformed payload, a bad key, or a wrong key (GCM auth-tag check fails).
const decryptToken = (payload, keyHex) => {
  if (typeof payload !== "string") {
    throw new Error("decryptToken: payload must be a string");
  }
  if (!isValidEncryptionKeyHex(keyHex)) {
    throw new Error("decryptToken: keyHex must be 64 hex chars (32 bytes)");
  }
  const parts = payload.split(":");
  // Exactly 3 parts: iv and auth tag must be non-empty hex; the ciphertext
  // is hex but may be empty (encrypting "" is legitimate).
  const HEX = /^[0-9a-fA-F]+$/;
  if (
    parts.length !== 3 ||
    !HEX.test(parts[0]) ||
    !/^[0-9a-fA-F]*$/.test(parts[1]) ||
    !HEX.test(parts[2])
  ) {
    throw new Error("decryptToken: malformed payload");
  }
  const [ivHex, cipherHex, authTagHex] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  // decipher.final() throws when the auth tag doesn't verify (wrong key).
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
};

// Route-facing secret storage: AES-256-GCM when TOKEN_ENCRYPTION_KEY is a
// valid 64-hex key, base64 obfuscation otherwise (with the startup warning
// emitted once at boot). Never throws for a missing/invalid key.
const storeTokenSecret = (plain) => {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  return isValidEncryptionKeyHex(key)
    ? encryptToken(plain, key)
    : obfuscate(plain);
};

const loadTokenSecret = (payload) => {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  return isValidEncryptionKeyHex(key)
    ? decryptToken(payload, key)
    : deobfuscate(payload);
};

// Google OAuth2 scopes requested by this app. calendar.readonly +
// gmail.compose keep the grant minimal (no full inbox or calendar write).
const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

// buildGoogleAuthUrl({ clientId, redirectUri, state }): pure URL builder for
// Google's OAuth2 authorization endpoint. Throws on missing inputs.
const buildGoogleAuthUrl = ({ clientId, redirectUri, state } = {}) => {
  if (!clientId || !redirectUri || !state) {
    throw new Error(
      "buildGoogleAuthUrl: clientId, redirectUri and state are required"
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};
// ===== P6 HELPERS END =====

// ===== P11 HELPERS START =====
// Rule-based fallback for meeting chat when the LLM is unavailable
// (missing GROQ_API_KEY or a failed API call). Pure, dependency-free —
// never invents facts. (Unit-tested by backend/phase11-llm.test.js via
// source extraction.)
//
// answerMeetingQuestion(question, transcript) -> string.
// Finds the transcript sentence(s) with the most keyword overlap with the
// question. When nothing matches, answers honestly that the information
// was not discussed.
const FALLBACK_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "when",
  "while", "with", "without", "for", "from", "of", "on", "in", "to",
  "at", "by", "into", "over", "after", "before", "about", "as", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "can", "could", "should",
  "this", "that", "these", "those", "it", "its", "we", "they", "them",
  "you", "your", "our", "their", "what", "which", "who", "whom",
  "how", "why", "where", "there", "here", "not", "no", "yes", "so",
  "just", "also", "very", "much", "many", "more", "most", "some",
  "any", "tell", "me", "please", "give", "did", "said", "say",
]);

const answerMeetingQuestion = (question, transcript) => {
  if (typeof question !== "string" || !question.trim()) {
    return "Please ask a question about this meeting.";
  }
  if (typeof transcript !== "string" || !transcript.trim()) {
    return "There is no transcript available for this meeting.";
  }
  const keywords = new Set(
    question
      .toLowerCase()
      .split(/[\s]+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length >= 4 && !FALLBACK_STOPWORDS.has(w))
  );
  if (keywords.size === 0) {
    return "I couldn't find a match for your question in the transcript.";
  }
  const sentences = splitSentences(transcript);
  let best = null;
  let bestScore = 0;
  for (const sentence of sentences) {
    const words = new Set(
      sentence
        .toLowerCase()
        .split(/[\s]+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ""))
    );
    let score = 0;
    for (const kw of keywords) {
      if (words.has(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  if (bestScore === 0 || !best) {
    return "This information was not discussed in the meeting.";
  }
  return `Based on the transcript: ${best}`;
};
// ===== P11 HELPERS END =====

// ===== P4: workspace access helpers (async, DB-backed) =====

// findReadableMeeting(meetingId, userId) → { meeting, workspace } | null.
// READ gate for single-meeting routes: returns the meeting when the user
// may read it (owner, or shared to a workspace the user belongs to).
// null covers "not found" AND "no access" — callers answer 404 either way
// so strangers can't probe which meetings exist.
const findReadableMeeting = async (meetingId, userId) => {
  let meeting;
  try {
    meeting = await Meeting.findById(meetingId);
  } catch (err) {
    return null; // malformed id shape → treat as not found
  }
  if (!meeting) return null;
  if (String(meeting.user) === String(userId)) {
    return { meeting, workspace: null };
  }
  if (meeting.visibility === "workspace" && meeting.workspace) {
    const workspace = await Workspace.findById(meeting.workspace);
    if (workspace && getWorkspaceRole(workspace, userId)) {
      return { meeting, workspace };
    }
  }
  return null;
};

// RBAC middleware factory. Loads the workspace from req.params.id, then:
// - 404 when the workspace is missing OR the requester is not a member
//   (non-members must not learn the workspace exists — no existence leak).
// - 403 when the requester's role is not in `allowed`.
// The owner always passes. Attaches req.workspace for the handler.
const requireWorkspaceRole = (...allowed) => {
  return async (req, res, next) => {
    try {
      const workspace = await Workspace.findById(req.params.id);
      const role = getWorkspaceRole(workspace, req.userId);
      if (!workspace || !role) {
        return res.status(404).json({ message: "Workspace not found" });
      }
      if (role !== "owner" && !allowed.includes(role)) {
        return res.status(403).json({ message: "Insufficient permissions" });
      }
      req.workspace = workspace;
      next();
    } catch (err) {
      if (err && err.name === "CastError") {
        return res.status(404).json({ message: "Workspace not found" });
      }
      res.status(500).json({ message: "Server error" });
    }
  };
};

// Ids of every workspace the requester belongs to (owner or member).
// Used to scope meeting list + analytics queries to readable meetings.
const getMemberWorkspaceIds = async (userId) => {
  const workspaces = await Workspace.find({
    $or: [{ owner: userId }, { "members.user": userId }],
  }).select("_id");
  return workspaces.map((w) => w._id);
};

// Best-effort audit writer: audit must never break the API path, so
// failures are logged server-side and swallowed.
const audit = async (action, { actor, workspace, meeting, details } = {}) => {
  try {
    await AuditLog.create({
      actor,
      action,
      workspace: workspace || undefined,
      meeting: meeting || undefined,
      details: details || undefined,
    });
  } catch (err) {
    console.error("Audit log failed:", err.message || err);
  }
};

// Auth Middleware
const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        message: "No token provided",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        message: "Invalid token format",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({
      message: "Invalid or expired token",
    });
  }
};

// Reusable function for summary/action extraction
const processTranscript = (transcript) => {
  const sentences = transcript
    .split(".")
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

  const summary =
    sentences.length > 0
      ? `This meeting discussed: ${sentences[0]}.`
      : "No summary available.";

  const keyPoints = sentences.slice(0, 3);

  const speakerNotes = [];

  sentences.forEach((sentence) => {
    if (sentence.includes(":")) {
      const parts = sentence.split(":");
      const speaker = parts[0].trim();
      const note = parts.slice(1).join(":").trim();

      if (speaker && note) {
        speakerNotes.push({
          speaker,
          note,
        });
      }
    }
  });

  const actionItems = [];

  sentences.forEach((sentence) => {
    const lowerSentence = sentence.toLowerCase();

    if (lowerSentence.includes("will")) {
      let assignedTo = "Not specified";
      let task = sentence;
      let deadline = "Not specified";
      let priority = "Medium";

      if (sentence.includes(":")) {
        assignedTo = sentence.split(":")[0].trim();
      }

      const words = sentence.split(" ");

      const willIndex = words.findIndex(
        (word) => word.toLowerCase() === "will"
      );

      if (willIndex > 0) {
        if (assignedTo === "Not specified") {
          assignedTo = words[willIndex - 1].replace(":", "");
        }

        task = words.slice(willIndex + 1).join(" ");
      }

      const deadlineKeywords = [
        "by",
        "before",
        "within",
        "today",
        "tomorrow",
        "next week",
        "next monday",
        "next tuesday",
        "next wednesday",
        "next thursday",
        "next friday",
        "next saturday",
        "next sunday",
      ];

      for (let keyword of deadlineKeywords) {
        if (lowerSentence.includes(keyword)) {
          const keywordIndex = lowerSentence.indexOf(keyword);
          deadline = sentence.slice(keywordIndex).trim();

          const willPosition = lowerSentence.indexOf("will");

          if (willPosition !== -1 && keywordIndex > willPosition) {
            const taskPart = sentence.slice(willPosition + 4, keywordIndex);
            task = taskPart.trim() || task;
          }

          break;
        }
      }

      if (
        lowerSentence.includes("urgent") ||
        lowerSentence.includes("immediately") ||
        lowerSentence.includes("today") ||
        lowerSentence.includes("as soon as possible")
      ) {
        priority = "High";
      } else if (
        lowerSentence.includes("later") ||
        lowerSentence.includes("optional") ||
        lowerSentence.includes("whenever")
      ) {
        priority = "Low";
      } else if (
        lowerSentence.includes("this week") ||
        lowerSentence.includes("next week") ||
        lowerSentence.includes("by friday") ||
        lowerSentence.includes("by monday") ||
        lowerSentence.includes("by tuesday") ||
        lowerSentence.includes("by wednesday") ||
        lowerSentence.includes("by thursday") ||
        lowerSentence.includes("by saturday") ||
        lowerSentence.includes("by sunday")
      ) {
        priority = "Medium";
      }

      actionItems.push({
        task: task || "Task not specified",
        assignedTo,
        deadline,
        priority,
        status: "Pending",
      });
    }
  });

  const finalActionItems =
    actionItems.length > 0
      ? actionItems
      : [
          {
            task: "No action item found",
            assignedTo: "Not specified",
            deadline: "Not specified",
            priority: "Low",
            status: "Pending",
          },
        ];

  return {
    summary,
    keyPoints,
    speakerNotes,
    actionItems: finalActionItems,
  };
};

// Test Route
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// ===== P7 SECURITY: rate-limit all auth endpoints (register, login,
// forgot-password, reset-password) =====
app.use("/api/auth", authLimiter);

// Register API
app.post("/api/auth/register", async (req, res) => {
  try {
    // P7: validate body before touching the DB.
    const validationError = validateRegisterBody(req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: "Name, email and password are required",
      });
    }

    const existingUser = await User.findOne({ email: email.trim() });

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: name.trim(),
      email: email.trim(),
      password: hashedPassword,
    });

    res.status(201).json({
      message: "User registered successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Registration failed",
    });
  }
});

// Login API
app.post("/api/auth/login", async (req, res) => {
  try {
    // P7: validate shape only; wrong credentials keep the generic 400 below
    // so attackers can't enumerate valid emails.
    const validationError = validateLoginBody(req.body);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.trim() });

    if (!user) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    const isPasswordMatch = await bcrypt.compare(password, user.password);

    if (!isPasswordMatch) {
      return res.status(400).json({
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      {
        userId: user._id,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    res.status(500).json({
      message: "Login failed",
    });
  }
});

// Audio upload and transcription route (Groq whisper-large-v3-turbo)
app.post(
  "/api/meetings/transcribe-audio",
  authMiddleware,
  aiLimiter,
  handleAudioUpload,
  async (req, res) => {
    // Transcription can be slow; give this request a 2-minute window.
    req.setTimeout(120000);
    try {
      if (!req.file) {
        return res.status(400).json({
          message: "Audio file is required",
        });
      }

      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: "whisper-large-v3-turbo",
      });

      res.json({
        transcript: transcription.text,
      });
    } catch (error) {
      // Log provider details server-side only; the client gets a generic message.
      console.error("Audio transcription error:", error.message || error);

      res.status(500).json({
        message: "Audio transcription failed",
      });
    } finally {
      // Async cleanup of the temp upload; never blocks the hot path.
      if (req.file && req.file.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (cleanupError) {
          console.error(
            "Audio upload cleanup failed:",
            cleanupError.message || cleanupError
          );
        }
      }
    }
  }
);

// Create summary and save meeting
app.post("/api/meetings/summarize", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      category,
      transcript,
      manualNotes,
      tags,
      durationMinutes,
      hourlyRate,
      participantCount,
      recurrence,
    } = req.body;

    if (!transcript) {
      return res.status(400).json({
        message: "Transcript is required",
      });
    }

    const processedData = processTranscript(transcript);

    const meeting = await Meeting.create({
      user: req.userId,
      title: title || "Untitled Meeting",
      category: category || "General",
      transcript,
      summary: processedData.summary,
      keyPoints: processedData.keyPoints,
      speakerNotes: processedData.speakerNotes,
      actionItems: processedData.actionItems,
      // P2: accept manualNotes (string, default "") and tags (sanitized).
      // All insight extraction is rule-based (extractionMethod marks that).
      manualNotes: typeof manualNotes === "string" ? manualNotes : "",
      tags: sanitizeTags(tags),
      decisions: extractDecisions(transcript),
      risks: extractRisks(transcript),
      blockers: extractBlockers(transcript),
      openQuestions: extractOpenQuestions(transcript),
      importantTopics: extractTopics(transcript),
      extractionMethod: "rule-based",
      // P3: coerce; invalid/negative/oversized values become null.
      durationMinutes: coerceDurationMinutes(durationMinutes),
      // BACKEND-CORE: cost + recurrence inputs; coerced, else null.
      hourlyRate: coercePositiveNumber(hourlyRate),
      participantCount: coercePositiveNumber(participantCount),
      recurrence: coerceRecurrence(recurrence),
      // BACKEND-CORE: rule-based sentiment of the transcript.
      sentiment: analyzeSentiment(transcript),
    });

    res.status(201).json(meeting);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// Get only logged-in user's meetings
// ===== P8 PERF: pagination + transcript exclusion =====
// Query params: page (default 1, min 1), limit (default 50, min 1, max 100),
// include=transcript (includes the transcript field; excluded otherwise).
// Backward compat: if NEITHER `page` NOR `limit` was explicitly passed,
// responds with a plain JSON array (capped at 50, transcript excluded by
// default, newest-first) so the old frontend keeps working. If `page` or
// `limit` IS passed, responds with { meetings, page, limit, total, totalPages }.
// Non-integer / non-positive page or limit values return 400.
app.get("/api/meetings", authMiddleware, async (req, res) => {
  try {
    const paginated =
      req.query.page !== undefined || req.query.limit !== undefined;

    const parsePositiveInt = (raw) => {
      if (typeof raw !== "string" && typeof raw !== "number") return null;
      const s = String(raw).trim();
      if (!/^\d+$/.test(s)) return null;
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 1) return null;
      return n;
    };

    let page = 1;
    let limit = 50;
    if (paginated) {
      if (req.query.page !== undefined) {
        const parsedPage = parsePositiveInt(req.query.page);
        if (parsedPage === null) {
          return res
            .status(400)
            .json({ message: "page must be a positive integer" });
        }
        page = parsedPage;
      }
      if (req.query.limit !== undefined) {
        const parsedLimit = parsePositiveInt(req.query.limit);
        if (parsedLimit === null) {
          return res
            .status(400)
            .json({ message: "limit must be a positive integer" });
        }
        limit = Math.min(parsedLimit, 100);
      }
    }

    const includeTranscript = req.query.include === "transcript";
    const projection = includeTranscript ? undefined : "-transcript";

    // P4: meetings the user owns PLUS meetings shared to a workspace they
    // belong to (visibility "workspace"). Writes stay owner-only.
    const memberWorkspaceIds = await getMemberWorkspaceIds(req.userId);
    const filter = {
      $or: [
        { user: req.userId },
        {
          visibility: "workspace",
          workspace: { $in: memberWorkspaceIds },
        },
      ],
    };
    const sort = { createdAt: -1 };

    if (paginated) {
      const total = await Meeting.countDocuments(filter);
      const meetings = await Meeting.find(filter)
        .select(projection)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit);
      return res.json({
        meetings,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    }

    // Backward-compat mode: plain array, newest-first, capped at 50.
    const meetings = await Meeting.find(filter)
      .select(projection)
      .sort(sort)
      .limit(50);

    res.json(meetings);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// ===== P3: Dashboard analytics =====
// GET /api/meetings/analytics/summary — auth + scoped aggregation.
// Query: from, to (optional ISO date strings; 400 on unparseable values).
// P4: scope = meetings the user owns PLUS meetings shared to a workspace
// they belong to (same $or as the list route).
// Defined BEFORE /api/meetings/:id so the literal path always wins.
// Empty-data friendly: zeros/empty arrays, never 404.
app.get("/api/meetings/analytics/summary", authMiddleware, async (req, res) => {
  try {
    let from = null;
    let to = null;
    if (req.query.from !== undefined) {
      const t = Date.parse(req.query.from);
      if (isNaN(t)) {
        return res
          .status(400)
          .json({ message: "Invalid 'from' date: must be a valid date string" });
      }
      from = new Date(t);
    }
    if (req.query.to !== undefined) {
      const t = Date.parse(req.query.to);
      if (isNaN(t)) {
        return res
          .status(400)
          .json({ message: "Invalid 'to' date: must be a valid date string" });
      }
      to = new Date(t);
    }

    // P4: scope the analytics to the requesting user PLUS workspace-shared
    // meetings they can read (same $or as the list route). The aggregation
    // $match needs an explicitly cast user id, so the scope below builds it.
    const memberWorkspaceIds = await getMemberWorkspaceIds(req.userId);
    const scope = {
      $or: [
        { user: new mongoose.Types.ObjectId(req.userId) },
        {
          visibility: "workspace",
          workspace: { $in: memberWorkspaceIds },
        },
      ],
    };
    const dateClause =
      from || to
        ? {
            createdAt: {
              ...(from ? { $gte: from } : {}),
              ...(to ? { $lte: to } : {}),
            },
          }
        : {};
    const filter = { ...scope, ...dateClause };

    const meetings = await Meeting.find(filter).lean();
    const now = new Date();

    const totalMeetings = meetings.length;

    // byCategory via aggregation (scoped + date-filtered, P4 scope). The
    // user id is cast explicitly since $match doesn't inherit schema casting.
    const categoryAgg = await Meeting.aggregate([
      {
        $match: { ...scope, ...dateClause },
      },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]);
    const byCategory = {};
    for (const row of categoryAgg) {
      if (row._id != null) byCategory[row._id] = row.count;
    }

    // byWeek: last 12 ISO weeks, ending with the current week (oldest first).
    // Subtracting whole weeks always lands in a different ISO week.
    const byWeek = [];
    for (let i = 11; i >= 0; i--) {
      const ref = new Date(now);
      ref.setDate(ref.getDate() - 7 * i);
      byWeek.push({ week: isoWeekKey(ref), count: 0 });
    }
    const weekSlots = new Map(byWeek.map((w) => [w.week, w]));
    for (const m of meetings) {
      const slot = weekSlots.get(isoWeekKey(m.createdAt));
      if (slot) slot.count++;
    }

    // Action-item stats across all in-range meetings.
    const actionItems = {
      total: 0,
      pending: 0,
      completed: 0,
      overdue: 0,
      cancelled: 0,
      byPriority: { High: 0, Medium: 0, Low: 0 },
    };
    for (const m of meetings) {
      for (const item of m.actionItems || []) {
        actionItems.total++;
        if (item.status === "Completed") {
          actionItems.completed++;
        } else if (item.status === "Cancelled") {
          actionItems.cancelled++;
        } else if (item.status === "Pending" || item.status === "In Progress") {
          actionItems.pending++;
        }
        if (isOverdueActionItem(item, now)) actionItems.overdue++;
        if (actionItems.byPriority[item.priority] !== undefined) {
          actionItems.byPriority[item.priority]++;
        }
      }
    }
    const completionPct =
      actionItems.total > 0
        ? Math.round((actionItems.completed / actionItems.total) * 100)
        : 0;

    // Average duration over meetings that have one; null when none do.
    let durSum = 0;
    let durCount = 0;
    for (const m of meetings) {
      if (typeof m.durationMinutes === "number" && Number.isFinite(m.durationMinutes)) {
        durSum += m.durationMinutes;
        durCount++;
      }
    }
    const avgDurationMinutes =
      durCount > 0 ? Math.round((durSum / durCount) * 10) / 10 : null;

    // Last 20 meetings by updatedAt, newest first (fields only as needed).
    const recent = await Meeting.find(filter)
      .select("title createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
    const activityTimeline = recent.map((m) => ({
      id: m._id,
      title: m.title,
      updatedAt: m.updatedAt,
      action:
        m.createdAt.getTime() === m.updatedAt.getTime() ? "created" : "updated",
    }));

    res.json({
      totalMeetings,
      byCategory,
      byWeek,
      actionItems,
      completionPct,
      avgDurationMinutes,
      activityTimeline,
      // BACKEND-CORE: sentiment distribution from stored sentiment labels,
      // and total attendee-cost estimate (2dp) across the scoped meetings.
      sentimentTrend: (() => {
        const trend = { Positive: 0, Neutral: 0, Negative: 0, Unknown: 0 };
        for (const m of meetings) {
          const label = m.sentiment && m.sentiment.label;
          if (label === "Positive" || label === "Neutral" || label === "Negative") {
            trend[label]++;
          } else {
            trend.Unknown++;
          }
        }
        return trend;
      })(),
      totalCost: (() => {
        let sum = 0;
        for (const m of meetings) {
          const c = computeMeetingCost({
            durationMinutes: m.durationMinutes,
            hourlyRate: m.hourlyRate,
            participantCount: m.participantCount,
          });
          if (c !== null) sum += c;
        }
        return Math.round(sum * 100) / 100;
      })(),
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// ===== BACKEND-CORE: decisions digest =====
// GET /api/meetings/decisions — auth + read scope (own + workspace-shared).
// Query: page (default 1, min 1), limit (default 20, min 1, max 100),
// search (optional case-insensitive substring over the decision text).
// Registered BEFORE the /api/meetings/:id route so "decisions" is not
// captured as an :id.
app.get("/api/meetings/decisions", authMiddleware, async (req, res) => {
  try {
    const parsePositiveInt = (raw) => {
      if (typeof raw !== "string" && typeof raw !== "number") return null;
      const s = String(raw).trim();
      if (!/^\d+$/.test(s)) return null;
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n < 1) return null;
      return n;
    };

    let page = 1;
    let limit = 20;
    if (req.query.page !== undefined) {
      const p = parsePositiveInt(req.query.page);
      if (p === null) {
        return res
          .status(400)
          .json({ message: "page must be a positive integer" });
      }
      page = p;
    }
    if (req.query.limit !== undefined) {
      const l = parsePositiveInt(req.query.limit);
      if (l === null) {
        return res
          .status(400)
          .json({ message: "limit must be a positive integer" });
      }
      limit = Math.min(l, 100);
    }

    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    // Same read scope as GET /api/meetings (own + workspace-readable).
    const memberWorkspaceIds = await getMemberWorkspaceIds(req.userId);
    const filter = {
      $or: [
        { user: req.userId },
        {
          visibility: "workspace",
          workspace: { $in: memberWorkspaceIds },
        },
      ],
    };

    const meetings = await Meeting.find(filter)
      .select("_id title decisions createdAt")
      .lean();

    let decisions = [];
    for (const m of meetings) {
      for (const decision of m.decisions || []) {
        decisions.push({
          decision,
          meetingId: String(m._id),
          meetingTitle: m.title || "Untitled Meeting",
          date: m.createdAt,
        });
      }
    }

    if (search) {
      const needle = search.toLowerCase();
      decisions = decisions.filter((d) =>
        String(d.decision).toLowerCase().includes(needle)
      );
    }

    decisions.sort((a, b) => new Date(b.date) - new Date(a.date));

    const total = decisions.length;
    const paged = decisions.slice((page - 1) * limit, page * limit);

    res.json({ decisions: paged, page, limit, total });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// ===== P8 PERF: single-meeting fetch (full document, transcript included) =====
// Placed after /api/meetings; no GET-route conflicts (the only other GET
// under /api/meetings/* is the two-segment /:id/action-items route).
app.get("/api/meetings/:id", authMiddleware, async (req, res) => {
  try {
    // P4: readable by the owner OR by a workspace member the meeting is
    // shared to (findReadableMeeting → 404 covers "not found" and "no access").
    const result = await findReadableMeeting(req.params.id, req.userId);

    if (!result) {
      return res.status(404).json({
        message: "Meeting not found",
      });
    }

    res.json(result.meeting);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// ===== PHASE 2: Structured meeting intelligence report =====
// GET /api/meetings/:id/report — auth + ownership enforced.
app.get("/api/meetings/:id/report", authMiddleware, async (req, res) => {
  try {
    // P4: readable by the owner OR by a workspace member the meeting is
    // shared to.
    const result = await findReadableMeeting(req.params.id, req.userId);

    if (!result) {
      return res.status(404).json({
        message: "Meeting not found",
      });
    }
    const meeting = result.meeting;

    res.json({
      title: meeting.title,
      category: meeting.category,
      tags: meeting.tags || [],
      manualNotes: meeting.manualNotes || "",
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      summary: meeting.summary,
      keyPoints: meeting.keyPoints || [],
      speakerNotes: meeting.speakerNotes || [],
      decisions: meeting.decisions || [],
      risks: meeting.risks || [],
      blockers: meeting.blockers || [],
      openQuestions: meeting.openQuestions || [],
      importantTopics: meeting.importantTopics || [],
      actionItems: meeting.actionItems || [],
      extractionMethod: meeting.extractionMethod || "rule-based",
      // BACKEND-CORE: rule-based talk-time breakdown, sentiment (stored when
      // present, otherwise computed from the transcript), and attendee cost
      // estimate (null unless durationMinutes/hourlyRate/participantCount
      // are all valid positive numbers).
      talkTime: analyzeTalkTime(meeting.transcript || ""),
      sentiment:
        meeting.sentiment && meeting.sentiment.label
          ? meeting.sentiment
          : analyzeSentiment(meeting.transcript || ""),
      cost: computeMeetingCost({
        durationMinutes: meeting.durationMinutes,
        hourlyRate: meeting.hourlyRate,
        participantCount: meeting.participantCount,
      }),
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// ===== BACKEND-CORE: rule-based follow-up suggestions =====
// GET /api/meetings/:id/suggestions — auth + readable access.
// Returns follow-up commitments detected in the transcript by the
// RULE-BASED detectFollowUps() helper — honestly labeled, never AI.
app.get("/api/meetings/:id/suggestions", authMiddleware, async (req, res) => {
  try {
    const result = await findReadableMeeting(req.params.id, req.userId);
    if (!result) {
      return res.status(404).json({ message: "Meeting not found" });
    }
    const meeting = result.meeting;
    res.json({
      suggestions: detectFollowUps(meeting.transcript || ""),
      extractionMethod: "rule-based",
      note: "Rule-based suggestions — not AI-generated.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// ===== PHASE 2: Follow-up email draft (template-based, never sent) =====
// POST /api/meetings/:id/email-draft — auth + ownership enforced.
// Returns { draft }: a plain-text follow-up draft built from the meeting's
// rule-based summary, decisions and action items. No email is sent here.
app.post(
  "/api/meetings/:id/email-draft",
  authMiddleware,
  async (req, res) => {
    try {
      // P4: readable by the owner OR by a workspace member the meeting is
      // shared to.
      const result = await findReadableMeeting(req.params.id, req.userId);

      if (!result) {
        return res.status(404).json({
          message: "Meeting not found",
        });
      }
      const meeting = result.meeting;

      const lines = [];
      lines.push(`Subject: Follow-up: ${meeting.title}`);
      lines.push("");
      lines.push("Hi team,");
      lines.push("");
      lines.push(
        `Here is the follow-up for the meeting "${meeting.title}":`
      );
      lines.push("");
      lines.push("Summary:");
      lines.push(meeting.summary || "No summary available.");
      lines.push("");

      const decisions = meeting.decisions || [];
      if (decisions.length > 0) {
        lines.push("Decisions:");
        for (const decision of decisions) {
          lines.push(`- ${decision}`);
        }
        lines.push("");
      }

      const actionItems = meeting.actionItems || [];
      if (actionItems.length > 0) {
        lines.push("Action items:");
        for (const item of actionItems) {
          lines.push(
            `- ${item.task} (Assigned to: ${item.assignedTo || "Not specified"}, Deadline: ${item.deadline || "Not specified"})`
          );
        }
        lines.push("");
      }

      lines.push("Best regards");

      res.json({ draft: lines.join("\n") });
    } catch (error) {
      res.status(500).json({
        message: "Server error",
      });
    }
  }
);

// ===== BACKEND-CORE: send meeting summary by email =====
// POST /api/meetings/:id/send-summary — OWNER ONLY. Explicit send only:
// nothing in the codebase auto-sends from any other path.
// Body { emails }: array of 1..10 valid email addresses.
// 501 if SMTP is not configured (SMTP_HOST/USER/PASS missing) or nodemailer
// is not installed. Errors are logged server-side; the client gets 502.
app.post("/api/meetings/:id/send-summary", authMiddleware, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      user: req.userId,
    });
    if (!meeting) {
      return res.status(404).json({ message: "Meeting not found" });
    }

    const { emails } = req.body || {};
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (
      !Array.isArray(emails) ||
      emails.length < 1 ||
      emails.length > 10 ||
      !emails.every((e) => typeof e === "string" && emailRe.test(e.trim()))
    ) {
      return res.status(400).json({
        message:
          "emails must be an array of 1-10 valid email addresses",
      });
    }

    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      return res.status(501).json({
        message: "Email not configured",
        setup:
          "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env — see backend/INTEGRATIONS.md",
      });
    }

    let nodemailer;
    try {
      nodemailer = require("nodemailer");
    } catch (e) {
      return res.status(501).json({
        message: "nodemailer is not installed",
        setup: "Run: npm install nodemailer",
      });
    }

    // Text body, mirroring the email-draft route style.
    const lines = [];
    lines.push("Hi team,");
    lines.push("");
    lines.push(`Here is the summary for the meeting "${meeting.title}":`);
    lines.push("");
    lines.push("Summary:");
    lines.push(meeting.summary || "No summary available.");
    lines.push("");

    const decisions = meeting.decisions || [];
    if (decisions.length > 0) {
      lines.push("Decisions:");
      for (const decision of decisions) {
        lines.push(`- ${decision}`);
      }
      lines.push("");
    }

    const actionItems = meeting.actionItems || [];
    if (actionItems.length > 0) {
      lines.push("Action items:");
      for (const item of actionItems) {
        lines.push(
          `- ${item.task} (Assigned to: ${item.assignedTo || "Not specified"}, Deadline: ${item.deadline || "Not specified"})`
        );
      }
      lines.push("");
    }

    lines.push("Best regards");

    const port = Number(SMTP_PORT) || 587;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    try {
      await transporter.sendMail({
        from: SMTP_USER,
        to: emails.map((e) => e.trim()).join(","),
        subject: `Meeting summary: ${meeting.title}`,
        text: lines.join("\n"),
      });
    } catch (sendError) {
      console.error(
        "[send-summary] email send failed:",
        sendError && sendError.message,
      );
      return res.status(502).json({ message: "Email send failed" });
    }

    res.json({ sent: true, to: emails });
  } catch (error) {
    console.error("[send-summary] unexpected error:", error && error.message);
    res.status(500).json({ message: "Server error" });
  }
});

// Update action item status (kept for backward compatibility with the
// existing frontend status dropdown)
app.patch(
  "/api/meetings/:meetingId/action-items/:actionIndex/status",
  authMiddleware,
  async (req, res) => {
    try {
      const { meetingId, actionIndex } = req.params;
      const { status } = req.body;

      const meeting = await Meeting.findOne({
        _id: meetingId,
        user: req.userId,
      });

      if (!meeting) {
        return res.status(404).json({
          message: "Meeting not found",
        });
      }

      const parsed = parseActionIndex(actionIndex, meeting.actionItems.length);
      if (!parsed.ok) {
        return res.status(parsed.status).json({ message: parsed.message });
      }

      if (status !== undefined && !ACTION_STATUSES.includes(status)) {
        return res.status(400).json({
          message: `status must be one of: ${ACTION_STATUSES.join(", ")}`,
        });
      }

      meeting.actionItems[parsed.index].status = status;
      await meeting.save();

      res.json({
        message: "Status updated successfully",
        meeting,
      });
    } catch (error) {
      res.status(500).json({
        message: "Server error",
      });
    }
  }
);

// ===== PHASE 1: Action-item CRUD =====

// Create an action item manually
app.post("/api/meetings/:id/action-items", authMiddleware, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      user: req.userId,
    });

    if (!meeting) {
      return res.status(404).json({ message: "Meeting not found" });
    }

    const { errors, value } = validateActionItemInput(req.body, {
      partial: false,
    });
    if (errors.length > 0) {
      return res.status(400).json({ message: "Validation failed", errors });
    }

    meeting.actionItems.push({
      task: value.task,
      assignedTo: value.assignedTo || "Not specified",
      deadline: value.deadline || "Not specified",
      priority: value.priority || "Medium",
      status: value.status || "Pending",
    });
    await meeting.save();

    res.status(201).json({
      message: "Action item created",
      actionItem: meeting.actionItems[meeting.actionItems.length - 1],
      meeting,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// Edit an action item (task, assignedTo, deadline, priority, status)
app.patch(
  "/api/meetings/:id/action-items/:index",
  authMiddleware,
  async (req, res) => {
    try {
      const meeting = await Meeting.findOne({
        _id: req.params.id,
        user: req.userId,
      });

      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }

      const parsed = parseActionIndex(
        req.params.index,
        meeting.actionItems.length
      );
      if (!parsed.ok) {
        return res.status(parsed.status).json({ message: parsed.message });
      }

      const { errors, value } = validateActionItemInput(req.body, {
        partial: true,
      });
      if (errors.length > 0) {
        return res.status(400).json({ message: "Validation failed", errors });
      }
      if (Object.keys(value).length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      Object.assign(meeting.actionItems[parsed.index], value);
      await meeting.save();

      res.json({
        message: "Action item updated",
        actionItem: meeting.actionItems[parsed.index],
        meeting,
      });
    } catch (error) {
      res.status(500).json({
        message: "Server error",
      });
    }
  }
);

// Delete an action item
app.delete(
  "/api/meetings/:id/action-items/:index",
  authMiddleware,
  async (req, res) => {
    try {
      const meeting = await Meeting.findOne({
        _id: req.params.id,
        user: req.userId,
      });

      if (!meeting) {
        return res.status(404).json({ message: "Meeting not found" });
      }

      const parsed = parseActionIndex(
        req.params.index,
        meeting.actionItems.length
      );
      if (!parsed.ok) {
        return res.status(parsed.status).json({ message: parsed.message });
      }

      meeting.actionItems.splice(parsed.index, 1);
      await meeting.save();

      res.json({ message: "Action item deleted", meeting });
    } catch (error) {
      res.status(500).json({
        message: "Server error",
      });
    }
  }
);

// ===== P1-INC2: Action-item list with filters, sorting, pagination =====
// GET /api/meetings/:id/action-items
// Query: status, priority, search (case-insensitive substring on
// task/assignedTo), sort (deadline | -deadline | priority | -priority;
// default = stored array order), page (default 1), limit (default 20, max 100).
// Each item carries originalIndex (its index in the meeting's stored array,
// for index-based PATCH/DELETE) and isOverdue.
app.get("/api/meetings/:id/action-items", authMiddleware, async (req, res) => {
  try {
    // P4: readable by the owner OR by a workspace member the meeting is
    // shared to. (Item edits below stay owner-only.)
    const result = await findReadableMeeting(req.params.id, req.userId);

    if (!result) {
      return res.status(404).json({ message: "Meeting not found" });
    }
    const meeting = result.meeting;

    const now = new Date();

    // Decorate with the stored-array index FIRST so filters/sorting preserve
    // the original index the frontend needs for PATCH/DELETE.
    let items = meeting.actionItems.map((item, idx) => ({
      ...item.toObject(),
      originalIndex: idx,
      isOverdue: isOverdueActionItem(item, now),
    }));

    const { status, priority, search, sort } = req.query;

    if (status) {
      items = items.filter((i) => i.status === status);
    }
    if (priority) {
      items = items.filter((i) => i.priority === priority);
    }
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      items = items.filter(
        (i) =>
          (i.task || "").toLowerCase().includes(q) ||
          (i.assignedTo || "").toLowerCase().includes(q)
      );
    }

    if (sort === "deadline" || sort === "-deadline") {
      const dir = sort === "-deadline" ? -1 : 1;
      items = items
        .map((i) => ({ i, due: parseDueDate(i.deadline, now) }))
        .sort((a, b) => {
          if (a.due && b.due) return dir * (a.due - b.due);
          if (a.due) return -1; // parseable dates first, unparseable last
          if (b.due) return 1;
          return 0;
        })
        .map(({ i }) => i);
    } else if (sort === "priority" || sort === "-priority") {
      const rank = { High: 3, Medium: 2, Low: 1 };
      const dir = sort === "-priority" ? -1 : 1;
      items = [...items].sort(
        (a, b) => dir * ((rank[b.priority] ?? 0) - (rank[a.priority] ?? 0))
      );
    }
    // default: stored array order

    let page = parseInt(req.query.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 20;
    limit = Math.min(limit, 100);

    const total = items.length;
    const totalPages = Math.ceil(total / limit);
    const startIdx = (page - 1) * limit;

    res.json({
      actionItems: items.slice(startIdx, startIdx + limit),
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// Update full meeting
// Phase 1 fix: analysis fields (incl. actionItems) are only regenerated when the
// transcript actually changes, so manual action-item edits survive title/category edits.
// P2: manualNotes + tags are stored ALWAYS (even when the transcript is unchanged);
// the P2 rule-based extractors only re-run when the transcript changed.
app.put("/api/meetings/:id", authMiddleware, async (req, res) => {
  try {
    const {
      title,
      category,
      transcript,
      manualNotes,
      tags,
      durationMinutes,
      hourlyRate,
      participantCount,
      recurrence,
    } = req.body;

    if (!transcript) {
      return res.status(400).json({
        message: "Transcript is required",
      });
    }

    const meeting = await Meeting.findOne({
      _id: req.params.id,
      user: req.userId,
    });

    if (!meeting) {
      return res.status(404).json({
        message: "Meeting not found",
      });
    }

    meeting.title = title || "Untitled Meeting";
    meeting.category = category || "General";

    // P2: always store manualNotes + tags, transcript change or not.
    meeting.manualNotes =
      typeof manualNotes === "string" ? manualNotes : "";
    meeting.tags = sanitizeTags(tags);

    // P3: only overwrite durationMinutes when the client sent the field
    // (never null it out implicitly when the body omits it).
    if (durationMinutes !== undefined) {
      meeting.durationMinutes = coerceDurationMinutes(durationMinutes);
    }

    // BACKEND-CORE: same only-when-sent rule for the cost + recurrence
    // inputs.
    if (hourlyRate !== undefined) {
      meeting.hourlyRate = coercePositiveNumber(hourlyRate);
    }
    if (participantCount !== undefined) {
      meeting.participantCount = coercePositiveNumber(participantCount);
    }
    if (recurrence !== undefined) {
      meeting.recurrence = coerceRecurrence(recurrence);
    }

    if (transcript !== meeting.transcript) {
      const processedData = processTranscript(transcript);
      meeting.transcript = transcript;
      meeting.summary = processedData.summary;
      meeting.keyPoints = processedData.keyPoints;
      meeting.speakerNotes = processedData.speakerNotes;
      meeting.actionItems = processedData.actionItems;
      // P2: re-run the rule-based extractors only when the transcript changed.
      meeting.decisions = extractDecisions(transcript);
      meeting.risks = extractRisks(transcript);
      meeting.blockers = extractBlockers(transcript);
      meeting.openQuestions = extractOpenQuestions(transcript);
      meeting.importantTopics = extractTopics(transcript);
      meeting.extractionMethod = "rule-based";
      // BACKEND-CORE: recompute rule-based sentiment with the transcript.
      meeting.sentiment = analyzeSentiment(transcript);
    }

    await meeting.save();

    res.json({
      message: "Meeting updated successfully",
      meeting,
    });
  } catch (error) {
    res.status(500).json({
      message: "Update failed",
    });
  }
});

// Delete meeting
app.delete("/api/meetings/:id", authMiddleware, async (req, res) => {
  try {
    const meeting = await Meeting.findOneAndDelete({
      _id: req.params.id,
      user: req.userId,
    });

    if (!meeting) {
      return res.status(404).json({
        message: "Meeting not found",
      });
    }

    res.json({
      message: "Meeting deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
});

// ===== BACKEND-CORE: recurring meeting instances =====
// POST /api/meetings/:id/recur — OWNER ONLY. Creates the next instance of a
// recurring meeting. The parent must have recurrence.frequency set, else 400.
// The new instance is titled "<base> (<n>)" (first recur is " (2)") and is a
// fresh shell: no transcript yet, no extracted intelligence, neutral
// sentiment, private visibility. nextDate is informational only — nothing is
// scheduled.
app.post("/api/meetings/:id/recur", authMiddleware, async (req, res) => {
  try {
    const parent = await Meeting.findOne({
      _id: req.params.id,
      user: req.userId,
    });
    if (!parent) {
      return res.status(404).json({ message: "Meeting not found" });
    }

    const frequency = parent.recurrence && parent.recurrence.frequency;
    if (!frequency) {
      return res
        .status(400)
        .json({ message: "Meeting has no recurrence frequency set" });
    }

    const base = String(parent.title || "Untitled Meeting").replace(
      /\s*\(\d+\)$/,
      ""
    );
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existing = await Meeting.countDocuments({
      user: req.userId,
      title: new RegExp(
        "^" + escapeRegExp(base) + "(\\s*\\(\\d+\\))?$"
      ),
    });
    const title = `${base} (${existing + 1})`;

    const instance = await Meeting.create({
      user: parent.user,
      title,
      category: parent.category,
      tags: parent.tags || [],
      manualNotes: "",
      transcript: "(No transcript yet — paste or transcribe after the meeting.)",
      summary: "Recurring meeting instance — summary pending.",
      keyPoints: [],
      decisions: [],
      risks: [],
      blockers: [],
      openQuestions: [],
      importantTopics: [],
      actionItems: [],
      extractionMethod: "rule-based",
      durationMinutes: parent.durationMinutes,
      hourlyRate: parent.hourlyRate,
      participantCount: parent.participantCount,
      recurrence: {
        frequency,
        occurrences: parent.recurrence ? parent.recurrence.occurrences : null,
      },
      sentiment: { score: 0, label: "Neutral" },
      visibility: "private",
      workspace: null,
    });

    res.status(201).json({
      meeting: instance,
      nextDate: nextRecurrenceDate(parent.createdAt, frequency),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Chat with Meeting Route (P11: Groq LLM with rule-based fallback)
// Response shape: { reply: string, aiSource: "llm" | "rule-based" }.
// The `reply` field name is kept for frontend compatibility (added aiSource).
// When the LLM is unavailable (missing GROQ_API_KEY or a failed call), the
// deterministic rule-based answerMeetingQuestion always answers instead.
app.post("/api/meetings/:id/chat", authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { message } = req.body;
    const meetingId = req.params.id;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    // P4: readable by the owner OR by a workspace member the meeting is
    // shared to.
    const readResult = await findReadableMeeting(meetingId, req.userId);

    if (!readResult) {
      return res.status(404).json({ message: "Meeting not found" });
    }
    const meeting = readResult.meeting;

    // P11: LLM first when a key is configured, rule-based fallback otherwise.
    const question = String(message);
    if (process.env.GROQ_API_KEY) {
      try {
        const result = await chatCompletion({
          system: buildChatSystemPrompt(),
          user:
            "Transcript:\n" +
            truncateTranscript(meeting.transcript) +
            "\n\nQuestion: " +
            question,
          maxTokens: 800,
        });
        logLLMUsage({
          model: result.model,
          latencyMs: result.latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          meetingId,
          op: "chat",
        });
        return res.json({
          reply: result.text || "No response generated.",
          aiSource: "llm",
        });
      } catch (llmError) {
        // Log server-side only; fall through to the rule-based answer so
        // chat keeps working when the provider is down or misconfigured.
        console.error(
          "Chat LLM error, falling back to rule-based:",
          llmError.message || llmError
        );
      }
    }

    const reply = answerMeetingQuestion(question, meeting.transcript);
    return res.json({ reply, aiSource: "rule-based" });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ===== P11: AI meeting summary (Groq, structured JSON) =====
// POST /api/meetings/:id/ai-summary?save=true|false (default false).
// Runs the LLM summarizer over the meeting transcript and returns validated
// structured intelligence with aiSource: "llm". save=true also persists the
// results onto the meeting (extractionMethod: "llm") — writes require
// meeting ownership (403 for workspace readers).
// AI-heavy route: falls under the existing aiLimiter (30 req / 15 min / IP),
// the same limiter used by the transcription and chat routes.
// On ANY LLM failure (no key, API error, invalid JSON, validation error)
// responds 502 with the rule-based processTranscript extraction as fallback
// data: { message, aiSource: "rule-based", fallback: {...} }.
app.post(
  "/api/meetings/:id/ai-summary",
  authMiddleware,
  aiLimiter,
  async (req, res) => {
    try {
      const meetingId = req.params.id;
      const save = req.query.save === "true";

      const readResult = await findReadableMeeting(meetingId, req.userId);

      if (!readResult) {
        return res.status(404).json({ message: "Meeting not found" });
      }
      const meeting = readResult.meeting;

      // Writes require ownership: workspace-shared readers may read AI
      // summaries but may not persist them onto someone else's meeting.
      if (save && String(meeting.user) !== String(req.userId)) {
        return res.status(403).json({
          message: "Only the meeting owner can save AI summaries",
        });
      }

      let validated;
      try {
        const result = await chatCompletion({
          system: "You extract structured meeting intelligence. Return STRICT JSON only.",
          user: buildSummarizeUserPrompt(truncateTranscript(meeting.transcript)),
          json: true,
          maxTokens: 2500,
        });
        logLLMUsage({
          model: result.model,
          latencyMs: result.latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          meetingId,
          op: "ai-summary",
        });
        validated = validateAiSummary(safeParseJson(result.text));
      } catch (llmError) {
        // Honest 502: the LLM path failed, so hand back the rule-based
        // extraction as fallback data rather than pretending AI ran.
        const fallback = processTranscript(meeting.transcript);
        return res.status(502).json({
          message:
            "AI summary failed: " + (llmError.message || "unknown error"),
          aiSource: "rule-based",
          fallback,
        });
      }

      if (save) {
        meeting.summary = validated.summary || meeting.summary;
        meeting.keyPoints = validated.keyPoints;
        meeting.decisions = validated.decisions;
        meeting.risks = validated.risks;
        meeting.blockers = validated.blockers;
        meeting.openQuestions = validated.openQuestions;
        meeting.importantTopics = validated.importantTopics;
        meeting.actionItems = validated.actionItems.map((item) => ({
          task: item.text,
          assignedTo: item.assignee || "Not specified",
          deadline: item.deadline || "Not specified",
          priority: item.priority,
          status: "Pending",
        }));
        meeting.extractionMethod = "llm";
        await meeting.save();
      }

      return res.json({ ...validated, aiSource: "llm" });
    } catch (error) {
      console.error("AI summary error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// ===== P12: RAG Q&A across meetings =====
// POST /api/meetings/ask — auth + aiLimiter. Ask a question over the
// requester's readable meetings (own + workspace-shared, the same $or scope
// as GET /api/meetings — other users' meetings are NEVER included).
// Body: { question (required, non-empty string), topK (optional int 1-10,
// default 5) }.
// Retrieval is LOCAL lexical TF-IDF (services/rag.js); no embedding
// provider is needed or called. When GROQ_API_KEY is configured, the top
// retrieved chunks are used to ground a Groq chat completion; otherwise (or
// on LLM failure) the route honestly returns the top matching excerpts as
// rule-based output with aiSource "rule-based".
// Response: { answer, citations: [{ meetingId, title, excerpt }], aiSource:
// "llm" | "rule-based" | "none", note? }.
// NOTE on VECTOR_SEARCH_ENABLED: this build has no live Atlas cluster and
// persists no chunk embeddings — the Atlas Vector Search wiring exists only
// as documentation in atlasVectorSearchHint()/RAG.md. Setting
// VECTOR_SEARCH_ENABLED=true logs a warning and still uses local retrieval.
app.post("/api/meetings/ask", authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { question, topK: topKRaw } = req.body || {};

    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({
        message: "question is required and must be a non-empty string",
      });
    }

    let topK = 5;
    if (topKRaw !== undefined) {
      const n = Number(topKRaw);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(400).json({
          message: "topK must be an integer between 1 and 10",
        });
      }
      topK = n;
    }

    // Honest VECTOR_SEARCH_ENABLED path: documented, not live.
    if (process.env.VECTOR_SEARCH_ENABLED === "true") {
      console.warn(
        "[RAG] VECTOR_SEARCH_ENABLED is set but Atlas Vector Search is not " +
          "wired to a live cluster in this build — using local retrieval. " +
          "See backend/RAG.md."
      );
    }

    // P4 auth scope: own meetings + workspace-shared meetings the requester
    // belongs to (identical $or to the GET /api/meetings list route).
    const memberWorkspaceIds = await getMemberWorkspaceIds(req.userId);
    const filter = {
      $or: [
        { user: req.userId },
        {
          visibility: "workspace",
          workspace: { $in: memberWorkspaceIds },
        },
      ],
    };

    // Cap at 50 most recent meetings (only title + transcript are fetched —
    // nothing else is needed to answer).
    const meetings = await Meeting.find(filter)
      .select("title transcript")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    if (meetings.length === 0) {
      return res.json({
        answer: "No meetings found to search.",
        citations: [],
        aiSource: "none",
        retrievalMethod: "lexical",
      });
    }

    // Chunk every transcript; the 500-chunk cap bounds per-request memory
    // and CPU for the in-memory TF-IDF index (chunks are built per request
    // and never persisted — see RAG.md limitations).
    const docs = [];
    for (const m of meetings) {
      const chunks = chunkText(m.transcript || "");
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        docs.push({
          id: `${m._id}:${chunkIndex}`,
          text: chunks[chunkIndex],
          meta: {
            meetingId: String(m._id),
            title: m.title || "Untitled Meeting",
          },
        });
        if (docs.length >= 500) break;
      }
      if (docs.length >= 500) break;
    }

    if (docs.length === 0) {
      return res.json({
        answer: "No meetings found to search.",
        citations: [],
        aiSource: "none",
        retrievalMethod: "lexical",
      });
    }

    // BACKEND-CORE: embedding retrieval when a non-local provider is
    // configured; wraps everything so an unconfigured/failing provider can
    // never break the route — it falls back to local lexical retrieval.
    let retrievalMethod = "lexical";
    let hits;
    try {
      const provider = getEmbeddingProvider();
      if (provider.name !== "local" && provider.embed) {
        const embedDocs = docs.slice(0, 200);
        const qv = (await provider.embed([question]))[0];
        const dv = await provider.embed(embedDocs.map((d) => d.text));
        hits = embedDocs
          .map((d, i) => ({ doc: d, score: cosineSim(qv, dv[i]) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .map((x) => ({ meta: x.doc.meta, text: x.doc.text }));
        retrievalMethod = "embeddings:" + provider.name;
      }
    } catch (e) {
      console.warn("[RAG] embeddings failed, lexical fallback:", e.message);
    }
    if (!hits) hits = retrieve(question, docs, topK);
    const citations = hits.map((h) => ({
      meetingId: h.meta.meetingId,
      title: h.meta.title,
      excerpt: h.text.slice(0, 200),
    }));

    // LLM-grounded answer when a key is configured.
    if (process.env.GROQ_API_KEY) {
      try {
        const context = truncateTranscript(
          hits.map((h) => `[${h.meta.title}]\n${h.text}`).join("\n\n"),
          8000
        );
        const result = await chatCompletion({
          system:
            buildChatSystemPrompt() + "\nCite the meeting titles you used.",
          user: `Contexts:\n${context}\n\nQuestion: ${question.trim()}`,
          maxTokens: 800,
        });
        logLLMUsage({
          model: result.model,
          latencyMs: result.latencyMs,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          op: "ask",
        });
        return res.json({
          answer: result.text || "No answer generated.",
          citations,
          aiSource: "llm",
          retrievalMethod,
        });
      } catch (llmError) {
        // Log server-side only; fall through to the rule-based excerpts so
        // the route keeps working when the provider is down.
        console.error(
          "[RAG] LLM error, falling back to rule-based excerpts:",
          llmError.message || llmError
        );
      }
    }

    // Rule-based fallback: top-3 matching excerpts, clearly labeled.
    const answer = hits
      .slice(0, 3)
      .map((h) => `--- From "${h.meta.title}" ---\n${h.text}`)
      .join("\n\n");

    return res.json({
      answer,
      citations,
      aiSource: "rule-based",
      retrievalMethod,
      note: "LLM unavailable — showing top matching excerpts (lexical retrieval, not AI-generated).",
    });
  } catch (error) {
    console.error("[RAG] ask error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// 1. Forgot Password Route
// P1-FIX-B2: fixed version.
// - Never reveals whether an email is registered (no enumeration): always 200.
// - Stores only a SHA-256 hash of the token; the raw token is never persisted.
// - Real email sending is stubbed until SMTP is configured (Phase 5);
//   until then the reset link is logged server-side for local testing.
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    const user = email ? await User.findOne({ email }) : null;

    if (user) {
      const resetToken = crypto.randomBytes(32).toString("hex");

      // Store only the hash of the token so a DB leak can't be used directly.
      user.resetPasswordToken = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");
      user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();

      const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/#/reset/${resetToken}`;

      // [EMAIL STUB] No SMTP configured — log the reset link only.
      // Replace with real email sending once SMTP is configured (Phase 5).
      console.log(
        `[EMAIL STUB] No SMTP configured — password reset link (log only): ${resetUrl}`
      );
    }

    res.status(200).json({
      message: "If an account exists for this email, a reset link has been generated.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// 2. Reset Password Route
// P1-FIX-B2: fixed version. Hashes the incoming token and matches it against
// the stored hash; single-use (fields cleared after success).
app.post("/api/auth/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    const hashedToken = crypto
      .createHash("sha256")
      .update(String(token || ""))
      .digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired password reset token" });
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({
        message: "New password is required and must be at least 6 characters long",
      });
    }

    user.password = await bcrypt.hash(newPassword, 10);

    // Clear the token fields so the link is single-use.
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.status(200).json({ message: "Password updated successfully!" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ===== P4: Workspaces + meeting sharing =====

// Create a workspace (any authenticated user). The creator becomes the owner.
app.post("/api/workspaces", authMiddleware, async (req, res) => {
  try {
    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ message: "Workspace name is required" });
    }

    const workspace = await Workspace.create({
      name,
      owner: req.userId,
      members: [],
    });

    await audit("workspace.created", {
      actor: req.userId,
      workspace: workspace._id,
      details: { name },
    });

    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// List workspaces the requester owns or is a member of. Each workspace
// carries `myRole` ("owner"/"admin"/"manager"/"member") computed in JS so
// the frontend can render role-aware UI.
app.get("/api/workspaces", authMiddleware, async (req, res) => {
  try {
    const workspaces = await Workspace.find({
      $or: [{ owner: req.userId }, { "members.user": req.userId }],
    });

    res.json(
      workspaces.map((w) => {
        const obj = w.toObject();
        obj.myRole = getWorkspaceRole(w, req.userId);
        return obj;
      })
    );
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Generate an invite link (owner/admin). The raw token is returned once in
// the URL; only its SHA-256 hash is persisted (7-day expiry).
app.post(
  "/api/workspaces/:id/invite",
  authMiddleware,
  requireWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const token = crypto.randomBytes(32).toString("hex");
      req.workspace.inviteTokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
      req.workspace.inviteExpires = new Date(
        Date.now() + 7 * 24 * 3600 * 1000
      );
      await req.workspace.save();

      await audit("workspace.invite_created", {
        actor: req.userId,
        workspace: req.workspace._id,
      });

      const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
      res.json({
        inviteUrl: `${frontend}/#/workspaces/accept/${token}`,
      });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Accept an invite link (any authenticated user holding a valid token).
// Idempotent: owners/members re-accepting just get the workspace back.
app.post("/api/workspaces/accept/:token", authMiddleware, async (req, res) => {
  try {
    const hash = crypto
      .createHash("sha256")
      .update(String(req.params.token || ""))
      .digest("hex");

    const workspace = await Workspace.findOne({
      inviteTokenHash: hash,
      inviteExpires: { $gt: new Date() },
    });

    if (!workspace) {
      return res
        .status(400)
        .json({ message: "Invalid or expired invitation" });
    }

    if (!getWorkspaceRole(workspace, req.userId)) {
      workspace.members.push({ user: req.userId, role: "member" });
      await workspace.save();

      await audit("workspace.member_joined", {
        actor: req.userId,
        workspace: workspace._id,
      });
    }

    res.json({ workspace });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Remove a member (owner/admin). The owner can never be removed; only the
// owner may remove an admin; the owner removing themselves is rejected
// (ownership transfer is not implemented).
app.delete(
  "/api/workspaces/:id/members/:userId",
  authMiddleware,
  requireWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const workspace = req.workspace;
      const targetId = req.params.userId;
      const requesterRole = getWorkspaceRole(workspace, req.userId);
      const targetRole = getWorkspaceRole(workspace, targetId);

      if (String(workspace.owner) === String(targetId)) {
        return res
          .status(400)
          .json({ message: "Cannot remove the workspace owner" });
      }
      if (String(req.userId) === String(targetId) && requesterRole === "owner") {
        return res
          .status(400)
          .json({ message: "Transfer ownership first (not implemented)" });
      }
      if (!targetRole) {
        return res.status(404).json({ message: "Member not found" });
      }
      if (targetRole === "admin" && requesterRole !== "owner") {
        return res.status(403).json({ message: "Insufficient permissions" });
      }

      workspace.members = workspace.members.filter(
        (m) => String(m.user) !== String(targetId)
      );
      await workspace.save();

      await audit("workspace.member_removed", {
        actor: req.userId,
        workspace: workspace._id,
        details: { removedUserId: targetId, removedRole: targetRole },
      });

      res.json({ message: "Member removed", workspace });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Workspace audit log (owner/admin/manager): last 50 entries, newest first.
app.get(
  "/api/workspaces/:id/audit",
  authMiddleware,
  requireWorkspaceRole("owner", "admin", "manager"),
  async (req, res) => {
    try {
      const entries = await AuditLog.find({ workspace: req.workspace._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate("actor", "name email");
      res.json(entries);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// ===== P4: Share a meeting to a workspace =====
// PATCH /api/meetings/:id/share — OWNER ONLY (the meeting owner can share
// their own meetings; non-owners get 404 here, same as other write routes).
// Body: { visibility: "private"|"workspace" (required), workspaceId }.
// "workspace" requires workspaceId + workspace membership of the requester
// (404 when the workspace doesn't exist or the id is malformed, 403 when it
// exists but the requester is a stranger). "private" unshares (clears
// workspace).
app.patch("/api/meetings/:id/share", authMiddleware, async (req, res) => {
  try {
    const meeting = await Meeting.findOne({
      _id: req.params.id,
      user: req.userId,
    });

    if (!meeting) {
      return res.status(404).json({ message: "Meeting not found" });
    }

    const { visibility, workspaceId } = req.body || {};
    if (visibility !== "private" && visibility !== "workspace") {
      return res.status(400).json({
        message: 'visibility is required and must be "private" or "workspace"',
      });
    }

    if (visibility === "workspace") {
      if (!workspaceId) {
        return res.status(400).json({ message: "workspaceId is required" });
      }
      let workspace = null;
      try {
        workspace = await Workspace.findById(workspaceId);
      } catch (castErr) {
        workspace = null; // malformed id → treat as not found
      }
      if (!workspace) {
        return res.status(404).json({ message: "Workspace not found" });
      }
      if (!getWorkspaceRole(workspace, req.userId)) {
        return res
          .status(403)
          .json({ message: "You are not a member of this workspace" });
      }
      meeting.visibility = "workspace";
      meeting.workspace = workspace._id;
    } else {
      meeting.visibility = "private";
      meeting.workspace = null;
    }

    await meeting.save();

    await audit("meeting.shared", {
      actor: req.userId,
      workspace: meeting.workspace || undefined,
      meeting: meeting._id,
      details: { visibility: meeting.visibility },
    });

    res.json({ meeting });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// ===== P5: Notifications & preferences =====
// NOTE on email: there is NO SMTP in this project and no email is ever
// auto-sent. The reminder job (backend/scripts/reminders.js) creates in-app
// notifications; its email path only fires behind an explicit
// EMAIL_ENABLED=true env flag via a stub mailer that logs "[EMAIL STUB]"
// and never delivers anything. Setting a user's emailEnabled preference to
// true therefore does NOT send email by itself.

// Parse a positive-integer query param (same convention as the meeting
// list route); returns null when the value is missing or invalid.
const parsePositiveIntParam = (raw) => {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
};

// Defaults returned by GET /api/users/me/preferences when the user has no
// Preference document yet. Returned WITHOUT creating a document.
const DEFAULT_PREFERENCES = {
  emailEnabled: false,
  reminderHoursBefore: 24,
  timezone: "Asia/Kolkata",
};

// List the requester's notifications, newest first, paginated.
// Query: page (default 1), limit (default 20, max 100).
// Response: { notifications, page, limit, total, totalPages, unreadCount }.
app.get("/api/notifications", authMiddleware, async (req, res) => {
  try {
    let page = 1;
    let limit = 20;
    if (req.query.page !== undefined) {
      const parsedPage = parsePositiveIntParam(req.query.page);
      if (parsedPage === null) {
        return res
          .status(400)
          .json({ message: "page must be a positive integer" });
      }
      page = parsedPage;
    }
    if (req.query.limit !== undefined) {
      const parsedLimit = parsePositiveIntParam(req.query.limit);
      if (parsedLimit === null) {
        return res
          .status(400)
          .json({ message: "limit must be a positive integer" });
      }
      limit = Math.min(parsedLimit, 100);
    }

    const filter = { user: req.userId };
    const [total, notifications, unreadCount] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Notification.countDocuments({ user: req.userId, read: false }),
    ]);

    res.json({
      notifications,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      unreadCount,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Mark ALL of the requester's notifications as read.
// (Defined before /:id/read; the shapes don't collide, but explicit order
// keeps the intent obvious.)
app.patch("/api/notifications/read-all", authMiddleware, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { user: req.userId, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    res.json({ updated: result.modifiedCount ?? 0 });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Mark one notification as read. User-scoped: 404 when the id is unknown,
// malformed, or belongs to another user.
app.patch("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    let notification = null;
    try {
      notification = await Notification.findOne({
        _id: req.params.id,
        user: req.userId,
      });
    } catch (castErr) {
      notification = null; // malformed id -> 404 below
    }

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    notification.read = true;
    notification.readAt = new Date();
    await notification.save();

    res.json({ notification });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Get the requester's reminder preferences. When no Preference document
// exists yet, returns the defaults WITHOUT creating one.
app.get("/api/users/me/preferences", authMiddleware, async (req, res) => {
  try {
    const prefs = await Preference.findOne({ user: req.userId }).lean();
    if (!prefs) {
      return res.json({ ...DEFAULT_PREFERENCES });
    }
    res.json({
      emailEnabled: prefs.emailEnabled,
      reminderHoursBefore: prefs.reminderHoursBefore,
      timezone: prefs.timezone,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// Upsert the requester's reminder preferences.
// Validates: reminderHoursBefore (number 1-168), timezone (non-empty
// string, max 60 chars), emailEnabled (boolean). Returns { preferences }.
// NOTE: emailEnabled=true does NOT send email — email stays stubbed
// behind the EMAIL_ENABLED env flag (no SMTP configured).
app.patch("/api/users/me/preferences", authMiddleware, async (req, res) => {
  try {
    const { emailEnabled, reminderHoursBefore, timezone } = req.body || {};
    const update = {};

    if (emailEnabled !== undefined) {
      if (typeof emailEnabled !== "boolean") {
        return res
          .status(400)
          .json({ message: "emailEnabled must be a boolean" });
      }
      update.emailEnabled = emailEnabled;
    }

    if (reminderHoursBefore !== undefined) {
      const n = Number(reminderHoursBefore);
      if (!Number.isFinite(n) || n < 1 || n > 168) {
        return res.status(400).json({
          message: "reminderHoursBefore must be a number between 1 and 168",
        });
      }
      update.reminderHoursBefore = n;
    }

    if (timezone !== undefined) {
      if (typeof timezone !== "string") {
        return res
          .status(400)
          .json({ message: "timezone must be a non-empty string" });
      }
      const tz = timezone.trim();
      if (!tz || tz.length > 60) {
        return res.status(400).json({
          message: "timezone must be a non-empty string of max 60 characters",
        });
      }
      update.timezone = tz;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const preferences = await Preference.findOneAndUpdate(
      { user: req.userId },
      { $set: update },
      { new: true, upsert: true }
    );

    res.json({ preferences });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// ===== P6: Integrations (Google OAuth / Calendar / Gmail / Slack) =====
// All Google calls below are credential-gated stubs: without
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET configured, every route degrades
// gracefully with a setup message. Nothing is ever auto-sent — Gmail only
// builds drafts, Slack only logs. See backend/INTEGRATIONS.md.

// GET /api/integrations/status — connection state for each provider.
// google.connected = a Token row exists; slack.connected = a Token row
// exists OR SLACK_WEBHOOK_URL is configured.
app.get("/api/integrations/status", authMiddleware, async (req, res) => {
  try {
    const tokens = await Token.find({
      user: req.userId,
      provider: { $in: ["google", "slack"] },
    }).lean();
    const google = tokens.find((t) => t.provider === "google") || null;
    const slack = tokens.find((t) => t.provider === "slack") || null;

    res.json({
      google: {
        connected: !!google,
        expiresAt:
          google && google.expiresAt
            ? new Date(google.expiresAt).toISOString()
            : null,
      },
      slack: {
        connected: !!slack || !!process.env.SLACK_WEBHOOK_URL,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/integrations/google/authorize — start the OAuth2 flow.
// Returns the Google consent-screen URL; the signed `state` JWT binds the
// flow to this user and expires after 10 minutes (CSRF protection).
app.get("/api/integrations/google/authorize", authMiddleware, async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({
        message: "Google OAuth not configured. See INTEGRATIONS.md.",
      });
    }

    const state = jwt.sign(
      {
        userId: req.userId,
        nonce: crypto.randomBytes(16).toString("hex"),
      },
      process.env.JWT_SECRET,
      { expiresIn: "10m" }
    );
    const redirectUri = `${req.protocol}://${req.get("host")}/api/integrations/google/callback`;

    res.json({
      url: buildGoogleAuthUrl({
        clientId: process.env.GOOGLE_CLIENT_ID,
        redirectUri,
        state,
      }),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/integrations/google/callback — OAuth2 redirect target. NO
// authMiddleware here: the user arrives from Google's consent screen.
// Verifies the state JWT, exchanges the code for tokens, stores the Token
// row (encrypted at rest when TOKEN_ENCRYPTION_KEY is set), then 303s back
// to the frontend.
app.get("/api/integrations/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    let statePayload;
    try {
      statePayload = jwt.verify(String(state || ""), process.env.JWT_SECRET);
    } catch (err) {
      return res
        .status(400)
        .json({ message: "Invalid or expired OAuth state" });
    }

    if (!code) {
      return res.status(400).json({ message: "Missing authorization code" });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(400).json({
        message: "Google OAuth not configured. See INTEGRATIONS.md.",
      });
    }

    const redirectUri = `${req.protocol}://${req.get("host")}/api/integrations/google/callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      // Provider detail is logged server-side only — never sent to the client.
      let detail = "";
      try {
        detail = await tokenRes.text();
      } catch (readErr) {
        // ignore — a status is enough to log
      }
      console.error(
        "[P6] Google token exchange failed:",
        tokenRes.status,
        detail ? detail.slice(0, 500) : ""
      );
      return res.status(400).json({ message: "Google token exchange failed" });
    }

    const tokenBody = await tokenRes.json();
    if (!tokenBody.access_token) {
      console.error("[P6] Google token exchange returned no access_token");
      return res.status(400).json({ message: "Google token exchange failed" });
    }

    const update = {
      user: statePayload.userId,
      provider: "google",
      accessToken: storeTokenSecret(tokenBody.access_token),
      expiresAt: tokenBody.expires_in
        ? new Date(Date.now() + Number(tokenBody.expires_in) * 1000)
        : undefined,
      scope: tokenBody.scope || undefined,
    };
    if (tokenBody.refresh_token) {
      update.refreshToken = storeTokenSecret(tokenBody.refresh_token);
    }

    await Token.findOneAndUpdate(
      { user: statePayload.userId, provider: "google" },
      update,
      { upsert: true, new: true }
    );

    const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
    return res.redirect(303, `${frontend}/#/?google=connected`);
  } catch (error) {
    console.error("[P6] Google callback error:", error.message || error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/integrations/:provider/disconnect — remove the stored OAuth
// tokens for google or slack. (Slack via SLACK_WEBHOOK_URL is env-configured
// and is unaffected — clear the env var to fully disconnect it.)
app.delete(
  "/api/integrations/:provider/disconnect",
  authMiddleware,
  async (req, res) => {
    try {
      const { provider } = req.params;
      if (provider !== "google" && provider !== "slack") {
        return res
          .status(400)
          .json({ message: 'provider must be "google" or "slack"' });
      }
      await Token.deleteOne({ user: req.userId, provider });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// ===== BACKEND-CORE: Google Calendar import (upgraded from stub) =====
// Shared handler for two routes:
//   POST /api/integrations/google/calendar/import (original path)
//   POST /api/integrations/google/import-calendar   (alias)
// Validates { from, to } and requires a connected Google account. When
// GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET are set AND a Google token
// exists, it lists real Calendar events (read-only). Without credentials,
// it keeps the EXACT original stub response (imported: 0, no events).
// Meetings are NEVER auto-created — import is manual.
const handleCalendarImport = async (req, res) => {
  try {
    const parseOptionalDate = (v) => {
      if (v === undefined || v === null || v === "") return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? "invalid" : d;
    };
    const from = parseOptionalDate(req.body?.from);
    const to = parseOptionalDate(req.body?.to);
    if (from === "invalid" || to === "invalid") {
      return res
        .status(400)
        .json({ message: "Invalid 'from'/'to' dates" });
    }

    const token = await Token.findOne({
      user: req.userId,
      provider: "google",
    });
    if (!token) {
      return res.status(400).json({ message: "Google not connected" });
    }

    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      // No OAuth credentials — original stub response, unchanged.
      return res.json({
        imported: 0,
        events: [],
        note: "Calendar import is stubbed — real Google Calendar calls need OAuth credentials (see INTEGRATIONS.md). No events were imported.",
      });
    }

    let googleapis;
    try {
      googleapis = require("googleapis");
    } catch (requireError) {
      return res.status(501).json({
        message: "googleapis package is not installed",
        setup: "Run: npm install googleapis",
      });
    }

    let accessToken;
    try {
      accessToken = loadTokenSecret(token.accessToken);
    } catch (decryptError) {
      return res.status(502).json({
        message:
          "Google token expired — reconnect via /api/integrations/google/authorize",
      });
    }

    const oauth2Client = new googleapis.google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = googleapis.google.calendar({
      version: "v3",
      auth: oauth2Client,
    });

    let eventsResp;
    try {
      eventsResp = await calendar.events.list({
        calendarId: "primary",
        timeMin: from ? from.toISOString() : undefined,
        timeMax: to ? to.toISOString() : undefined,
        maxResults: 50,
        singleEvents: true,
        orderBy: "startTime",
      });
    } catch (apiError) {
      const status =
        apiError && (apiError.code || (apiError.response && apiError.response.status));
      if (status === 401) {
        return res.status(502).json({
          message:
            "Google token expired — reconnect via /api/integrations/google/authorize",
        });
      }
      console.error(
        "[calendar-import] Google API error:",
        apiError && apiError.message
      );
      return res
        .status(502)
        .json({ message: "Google Calendar request failed" });
    }

    const events = (eventsResp.data.items || []).map((ev) => ({
      id: ev.id,
      summary: ev.summary || null,
      start: (ev.start && (ev.start.dateTime || ev.start.date)) || null,
      end: (ev.end && (ev.end.dateTime || ev.end.date)) || null,
      location: ev.location || null,
    }));

    return res.json({
      imported: 0,
      events,
      note: "Real Google Calendar events listed. Meetings are not auto-created — import manually.",
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
app.post(
  "/api/integrations/google/calendar/import",
  authMiddleware,
  handleCalendarImport,
);
app.post(
  "/api/integrations/google/import-calendar",
  authMiddleware,
  handleCalendarImport,
);

// POST /api/integrations/google/gmail/draft — STUB.
// Builds a follow-up email draft from a readable meeting (subject
// "Follow-up: <title>", body = summary + decisions + action items).
// Nothing is ever sent — the real Gmail send must be implemented per
// INTEGRATIONS.md after Google is connected.
app.post(
  "/api/integrations/google/gmail/draft",
  authMiddleware,
  async (req, res) => {
    try {
      const { meetingId, to } = req.body || {};
      if (!meetingId) {
        return res.status(400).json({ message: "meetingId is required" });
      }

      const result = await findReadableMeeting(meetingId, req.userId);
      if (!result) {
        return res.status(404).json({ message: "Meeting not found" });
      }

      const token = await Token.findOne({
        user: req.userId,
        provider: "google",
      });
      if (!token) {
        return res.status(400).json({ message: "Google not connected" });
      }

      const meeting = result.meeting;
      const subject = `Follow-up: ${meeting.title}`;

      const lines = [];
      lines.push("Hi team,");
      lines.push("");
      lines.push(`Here is the follow-up for the meeting "${meeting.title}":`);
      lines.push("");
      lines.push("Summary:");
      lines.push(meeting.summary || "No summary available.");
      lines.push("");

      const decisions = meeting.decisions || [];
      if (decisions.length > 0) {
        lines.push("Decisions:");
        for (const decision of decisions) {
          lines.push(`- ${decision}`);
        }
        lines.push("");
      }

      const actionItems = meeting.actionItems || [];
      if (actionItems.length > 0) {
        lines.push("Action items:");
        for (const item of actionItems) {
          lines.push(
            `- ${item.task} (Assigned to: ${item.assignedTo || "Not specified"}, Deadline: ${item.deadline || "Not specified"})`
          );
        }
        lines.push("");
      }

      lines.push("Best regards");

      res.json({
        draft: {
          to: typeof to === "string" && to.trim() ? to.trim() : null,
          subject,
          body: lines.join("\n"),
        },
        sent: false,
        note: "Gmail draft is stubbed — nothing was sent. Connect Google and implement sending per INTEGRATIONS.md.",
      });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// POST /api/integrations/slack/notify — STUB.
// Validates { text } (required, non-empty, max 2000 chars) then logs it.
// No message is ever posted — implement real posting with SLACK_WEBHOOK_URL
// per INTEGRATIONS.md.
app.post(
  "/api/integrations/slack/notify",
  authMiddleware,
  async (req, res) => {
    try {
      const { text } = req.body || {};
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({
          message: "text is required and must be a non-empty string",
        });
      }
      if (text.length > 2000) {
        return res
          .status(400)
          .json({ message: "text must be at most 2000 characters" });
      }

      console.log(`[SLACK STUB] ${text.slice(0, 120)}`);

      res.json({
        posted: false,
        note: "Slack posting is stubbed — no message was sent. Set SLACK_WEBHOOK_URL and implement posting per INTEGRATIONS.md.",
      });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  }
);

// ===== P7 SECURITY: Centralized error middleware =====
// Must be the LAST middleware (after all routes). Logs full details
// server-side, but the client only ever gets a generic message.
// This also catches express.json() parse errors (entity.too.large,
// SyntaxError on malformed JSON).
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ message: "Internal server error" });
});

const PORT = process.env.PORT || 5000;

// P5 + BACKEND-CORE: only start the HTTP listener when server.js is the
// entry point. backend/scripts/reminders.js requires this module for its
// models + pure helpers; requiring it must NOT open a port.
// BACKEND-CORE: socket.io realtime is initialized when available (services/
// realtime.js is provided by another worker). If the module or init fails,
// the HTTP server still starts with realtime disabled — never crashes boot.
if (require.main === module) {
  const server = http.createServer(app);
  try {
    const { initRealtime } = require("./services/realtime");
    initRealtime(server, {
      JWT_SECRET: process.env.JWT_SECRET,
      Meeting,
      findReadableMeeting,
      ACTION_STATUSES,
      ACTION_PRIORITIES,
    });
    console.log("[realtime] socket.io enabled");
  } catch (e) {
    console.warn("[realtime] disabled:", e && e.message);
  }
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// P5: exports for the standalone reminder job (backend/scripts/reminders.js),
// which requires this module for the compiled models + pure helpers.
// Requiring this file does NOT start the HTTP server (see the
// require.main guard above) and sends no email.
module.exports = {
  app,
  mongoose,
  User,
  Meeting,
  Workspace,
  AuditLog,
  Notification,
  Preference,
  Token,
  parseDueDate,
  isOverdueActionItem,
  buildDedupeKey,
  isReminderDue,
  encryptToken,
  decryptToken,
  buildGoogleAuthUrl,
  // P11: LLM service re-exports for tests + scripts.
  answerMeetingQuestion,
  PROMPT_VERSION,
  truncateTranscript,
  safeParseJson,
  buildChatSystemPrompt,
  buildSummarizeUserPrompt,
  validateAiSummary,
  chatCompletion,
  logLLMUsage,
  // P12: RAG service re-exports for tests + scripts.
  chunkText,
  hashFeatures,
  cosineSim,
  buildTfIdfIndex,
  retrieve,
  getEmbeddingProvider,
  atlasVectorSearchHint,
  // BACKEND-CORE: insights service re-exports for tests + scripts.
  analyzeSentiment,
  analyzeTalkTime,
  detectFollowUps,
  computeMeetingCost,
  nextRecurrenceDate,
};
