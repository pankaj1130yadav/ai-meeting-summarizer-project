// backend/services/insights.js
//
// Pure, dependency-free meeting-insight helpers:
//   - analyzeSentiment(text)      — word-list sentiment scoring
//   - analyzeTalkTime(transcript) — per-speaker word counts/percentages
//   - detectFollowUps(transcript) — follow-up commitment sentence detection
//   - computeMeetingCost(...)     — attendee cost estimate
//   - nextRecurrenceDate(...)     — weekly/biweekly/monthly recurrence math
//
// No network, no DB, no secrets. All extraction here is RULE-BASED — callers
// must label outputs as "rule-based", never AI-generated.

"use strict";

// ---- Sentiment word lists (~40 words each, matched case-insensitively on
// word boundaries) ----
const POSITIVE_WORDS = [
  "great",
  "excellent",
  "awesome",
  "fantastic",
  "amazing",
  "wonderful",
  "brilliant",
  "outstanding",
  "superb",
  "terrific",
  "perfect",
  "love",
  "loved",
  "like",
  "liked",
  "enjoy",
  "enjoyed",
  "happy",
  "glad",
  "pleased",
  "excited",
  "thrilled",
  "delighted",
  "satisfied",
  "good",
  "better",
  "best",
  "success",
  "successful",
  "win",
  "won",
  "approved",
  "agree",
  "agreed",
  "support",
  "supported",
  "confident",
  "progress",
  "improved",
  "impressive",
  "thank",
  "thanks",
];

const NEGATIVE_WORDS = [
  "terrible",
  "awful",
  "horrible",
  "bad",
  "worse",
  "worst",
  "hate",
  "hated",
  "dislike",
  "disliked",
  "angry",
  "frustrated",
  "frustrating",
  "disappointed",
  "disappointing",
  "sad",
  "upset",
  "worried",
  "worry",
  "concern",
  "concerned",
  "problem",
  "problems",
  "issue",
  "issues",
  "failure",
  "failed",
  "fail",
  "wrong",
  "broken",
  "blocked",
  "delay",
  "delayed",
  "missed",
  "poor",
  "weak",
  "risk",
  "risky",
  "critical",
  "urgent",
  "complain",
  "complaint",
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildWordRegex = (words) =>
  new RegExp(`\\b(?:${words.map(escapeRegex).join("|")})\\b`, "gi");

// analyzeSentiment(text) -> { score, label }.
// score = (pos - neg) / max(1, pos + neg), rounded to 2dp, clamped to [-1, 1].
// label: "Positive" if score > 0.15, "Negative" if score < -0.15, else "Neutral".
const POSITIVE_RE = buildWordRegex(POSITIVE_WORDS);
const NEGATIVE_RE = buildWordRegex(NEGATIVE_WORDS);

const countMatches = (text, re) => {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
};

const analyzeSentiment = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return { score: 0, label: "Neutral" };
  }
  const pos = countMatches(text, POSITIVE_RE);
  const neg = countMatches(text, NEGATIVE_RE);
  const denom = Math.max(1, pos + neg);
  let score = (pos - neg) / denom;
  score = Math.max(-1, Math.min(1, score));
  score = Math.round(score * 100) / 100;
  const label =
    score > 0.15 ? "Positive" : score < -0.15 ? "Negative" : "Neutral";
  return { score, label };
};

// analyzeTalkTime(transcript) -> [{ speaker, words, percent }] sorted desc.
// Parses lines of the form "Name: speech" (name up to 40 chars, no colon or
// newline). percent = words/total*100 rounded to 1dp. Capped at 20 speakers.
const SPEAKER_LINE_RE = /^([^:\n]{1,40}):\s*(.+)$/gm;

const analyzeTalkTime = (transcript) => {
  if (typeof transcript !== "string" || !transcript) return [];
  const counts = new Map();
  let total = 0;
  SPEAKER_LINE_RE.lastIndex = 0;
  let m;
  while ((m = SPEAKER_LINE_RE.exec(transcript)) !== null) {
    const speaker = m[1].trim();
    const speech = m[2].trim();
    if (!speaker || !speech) continue;
    const words = speech.split(/\s+/).filter(Boolean).length;
    if (words === 0) continue;
    counts.set(speaker, (counts.get(speaker) || 0) + words);
    total += words;
  }
  if (total === 0) return [];
  return Array.from(counts.entries())
    .map(([speaker, words]) => ({
      speaker,
      words,
      percent: Math.round((words / total) * 1000) / 10,
    }))
    .sort((a, b) => b.words - a.words || a.speaker.localeCompare(b.speaker))
    .slice(0, 20);
};

// detectFollowUps(transcript) -> [{ text }].
// Keeps sentences matching follow-up-commitment patterns; excludes questions.
// Dedupes case-insensitively, capped at 10.
const FOLLOWUP_RE =
  /\b(i will|i'll|i promise|promise to|let me|i'll send|i'll share|by tomorrow|by (monday|tuesday|wednesday|thursday|friday)|i will send|we should)\b/i;

const detectFollowUps = (transcript) => {
  if (typeof transcript !== "string" || !transcript) return [];
  // Split on sentence terminators, keeping it simple and deterministic.
  const sentences = transcript
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    if (out.length >= 10) break;
    if (s.endsWith("?")) continue; // exclude questions
    if (!FOLLOWUP_RE.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: s });
  }
  return out;
};

// computeMeetingCost({ durationMinutes, hourlyRate, participantCount }) ->
// Number (2dp) or null unless all three are finite numbers > 0.
const computeMeetingCost = ({
  durationMinutes,
  hourlyRate,
  participantCount,
} = {}) => {
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!ok(durationMinutes) || !ok(hourlyRate) || !ok(participantCount)) {
    return null;
  }
  const cost = (durationMinutes / 60) * hourlyRate * participantCount;
  return Math.round(cost * 100) / 100;
};

// nextRecurrenceDate(fromDate, frequency) -> Date or null.
// frequency: "weekly" (+7d), "biweekly" (+14d), "monthly" (+1 month, same
// date, clamped to month end).
const nextRecurrenceDate = (fromDate, frequency) => {
  let base;
  if (fromDate instanceof Date) {
    base = new Date(fromDate.getTime());
  } else if (typeof fromDate === "string" || typeof fromDate === "number") {
    base = new Date(fromDate);
  } else {
    return null;
  }
  if (isNaN(base.getTime())) return null;

  if (frequency === "weekly") {
    const d = new Date(base);
    d.setDate(d.getDate() + 7);
    return d;
  }
  if (frequency === "biweekly") {
    const d = new Date(base);
    d.setDate(d.getDate() + 14);
    return d;
  }
  if (frequency === "monthly") {
    const y = base.getFullYear();
    const mo = base.getMonth();
    const day = base.getDate();
    // Clamp to the last day of the target month (e.g. Jan 31 -> Feb 28/29).
    const lastDay = new Date(y, mo + 2, 0).getDate();
    const d = new Date(base);
    d.setFullYear(y, mo + 1, Math.min(day, lastDay));
    return d;
  }
  return null;
};

module.exports = {
  analyzeSentiment,
  analyzeTalkTime,
  detectFollowUps,
  computeMeetingCost,
  nextRecurrenceDate,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
};
