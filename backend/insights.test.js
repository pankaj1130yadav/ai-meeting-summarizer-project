// backend/insights.test.js
// Unit tests for backend/services/insights.js (pure helpers).
// Run: node backend/insights.test.js (or: cd backend && node insights.test.js)
"use strict";

const assert = require("assert");
const {
  analyzeSentiment,
  analyzeTalkTime,
  detectFollowUps,
  computeMeetingCost,
  nextRecurrenceDate,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
} = require("./services/insights");

let count = 0;
const ok = (cond, name) => {
  count++;
  assert(cond, `FAIL: ${name}`);
  console.log(`ok ${count} - ${name}`);
};

// ---------- analyzeSentiment ----------
{
  const r = analyzeSentiment(
    "This was a great, excellent meeting. I loved the amazing progress!",
  );
  ok(
    r.label === "Positive" && r.score > 0.15,
    "sentiment: strongly positive text",
  );
}
{
  const r = analyzeSentiment(
    "Terrible failure. Awful problems, everything was broken and delayed.",
  );
  ok(
    r.label === "Negative" && r.score < -0.15,
    "sentiment: strongly negative text",
  );
}
{
  const r = analyzeSentiment(
    "We discussed the timeline and reviewed the document together.",
  );
  ok(
    r.label === "Neutral" && r.score === 0,
    "sentiment: neutral text scores 0",
  );
}
{
  const r = analyzeSentiment("");
  ok(
    r.score === 0 && r.label === "Neutral",
    "sentiment: empty string -> neutral",
  );
}
{
  const r = analyzeSentiment(null);
  ok(
    r.score === 0 && r.label === "Neutral",
    "sentiment: non-string -> neutral",
  );
}
{
  // "greatness" must NOT match "great" (word-boundary match)
  const r = analyzeSentiment("greatness is not greatness. GREATNESS!");
  ok(
    r.label === "Neutral",
    "sentiment: word-boundary matching (greatness != great)",
  );
}
{
  const r = analyzeSentiment("GREAT meeting, TERRIBLE coffee");
  ok(
    r.label === "Neutral" && r.score === 0,
    "sentiment: balanced pos/neg -> 0",
  );
}
{
  ok(
    POSITIVE_WORDS.length >= 40 && NEGATIVE_WORDS.length >= 40,
    "word lists have ~40 words each",
  );
}

// ---------- analyzeTalkTime ----------
{
  const t =
    "Alice: hello world\nBob: one two three four\nAlice: more words here please";
  const r = analyzeTalkTime(t);
  ok(r.length === 2, "talkTime: two speakers detected");
  ok(
    r[0].speaker === "Alice" && r[0].words === 6,
    "talkTime: sorted desc by words",
  );
  ok(
    r[1].speaker === "Bob" && r[1].words === 4,
    "talkTime: second speaker word count",
  );
  ok(
    Math.abs(r[0].percent + r[1].percent - 100) < 0.1,
    "talkTime: percentages sum to ~100",
  );
  ok(r[0].percent === 60, "talkTime: percentage rounded to 1dp (6/10=60.0)");
}
{
  const r = analyzeTalkTime("no speaker lines here at all");
  ok(Array.isArray(r) && r.length === 0, "talkTime: [] when no speaker lines");
}
{
  const r = analyzeTalkTime(
    "This line has: a colon too late in the line so the name is too long xxxxxxxxxxxxxx\n",
  );
  // name part is 63 chars > 40 — the regex caps name at 40 chars
  ok(Array.isArray(r), "talkTime: handles long-name lines without crashing");
}
{
  const r = analyzeTalkTime(null);
  ok(Array.isArray(r) && r.length === 0, "talkTime: non-string -> []");
}
{
  let t = "";
  for (let i = 0; i < 25; i++) t += `Speaker${i}: hello world\n`;
  const r = analyzeTalkTime(t);
  ok(r.length === 20, "talkTime: capped at 20 speakers");
}

// ---------- detectFollowUps ----------
{
  const r = detectFollowUps(
    "I will send the report. Let me check the numbers. We should align on the timeline.",
  );
  ok(r.length === 3, "followups: detects i will / let me / we should");
  ok(
    r[0].text === "I will send the report",
    "followups: sentence trimmed, terminator stripped",
  );
}
{
  const r = detectFollowUps(
    "Will you send the report? I'll send it by tomorrow.",
  );
  ok(
    r.length === 1 && r[0].text === "I'll send it by tomorrow",
    "followups: questions excluded",
  );
}
{
  const r = detectFollowUps("I will send it. i will send it. I WILL SEND IT.");
  ok(r.length === 1, "followups: dedupes case-insensitively");
}
{
  let t = "";
  for (let i = 0; i < 15; i++) t += `I will handle task number ${i}. `;
  const r = detectFollowUps(t);
  ok(r.length === 10, "followups: capped at 10");
}
{
  const r = detectFollowUps(
    "I promise to review this by Friday and I'll share the notes.",
  );
  ok(r.length >= 1, "followups: detects promise-to / by weekday / i'll share");
}
{
  const r = detectFollowUps(null);
  ok(Array.isArray(r) && r.length === 0, "followups: non-string -> []");
}
{
  const r = detectFollowUps("Just a normal status update with no commitments.");
  ok(r.length === 0, "followups: no patterns -> []");
}

// ---------- computeMeetingCost ----------
{
  ok(
    computeMeetingCost({
      durationMinutes: 60,
      hourlyRate: 50,
      participantCount: 4,
    }) === 200,
    "cost: 60min/50/hr/4 = 200",
  );
}
{
  ok(
    computeMeetingCost({
      durationMinutes: 45,
      hourlyRate: 33.33,
      participantCount: 3,
    }) === 74.99,
    "cost: rounds to 2dp (74.9925 -> 74.99)",
  );
}
{
  ok(
    computeMeetingCost({
      durationMinutes: 0,
      hourlyRate: 50,
      participantCount: 4,
    }) === null,
    "cost: zero duration -> null",
  );
}
{
  ok(
    computeMeetingCost({
      durationMinutes: 30,
      hourlyRate: -10,
      participantCount: 2,
    }) === null,
    "cost: negative rate -> null",
  );
}
{
  ok(
    computeMeetingCost({
      durationMinutes: 30,
      hourlyRate: NaN,
      participantCount: 2,
    }) === null,
    "cost: NaN -> null",
  );
}
{
  ok(
    computeMeetingCost({
      durationMinutes: "30",
      hourlyRate: 50,
      participantCount: 2,
    }) === null,
    "cost: string duration -> null",
  );
}
{
  ok(computeMeetingCost({}) === null, "cost: missing fields -> null");
}

// ---------- nextRecurrenceDate ----------
{
  const d = nextRecurrenceDate(new Date(2026, 9, 1), "weekly");
  ok(
    d instanceof Date &&
      d.getFullYear() === 2026 &&
      d.getMonth() === 9 &&
      d.getDate() === 8,
    "recurrence: weekly +7d",
  );
}
{
  const base = new Date("2026-10-01T00:00:00Z").getTime();
  const d = nextRecurrenceDate("2026-10-01T00:00:00Z", "biweekly");
  ok(
    d instanceof Date && d.getTime() - base === 14 * 24 * 3600 * 1000,
    "recurrence: biweekly accepts ISO string, +14d",
  );
}
{
  const d = nextRecurrenceDate(new Date(2026, 0, 31), "monthly");
  ok(
    d instanceof Date && d.getMonth() === 1 && d.getDate() === 28,
    "recurrence: monthly clamps Jan 31 -> Feb 28 (2026 non-leap)",
  );
}
{
  const d = nextRecurrenceDate(new Date(2026, 9, 15), "monthly");
  ok(
    d.getMonth() === 10 && d.getDate() === 15,
    "recurrence: monthly keeps same date",
  );
}
{
  ok(
    nextRecurrenceDate(new Date(2026, 9, 1), "daily") === null,
    "recurrence: unknown frequency -> null",
  );
}
{
  ok(
    nextRecurrenceDate("not a date", "weekly") === null,
    "recurrence: invalid date string -> null",
  );
}
{
  ok(
    nextRecurrenceDate(null, "weekly") === null,
    "recurrence: null fromDate -> null",
  );
}
{
  const ts = Date.now();
  const d = nextRecurrenceDate(ts, "weekly");
  ok(
    d instanceof Date && d.getTime() === ts + 7 * 24 * 3600 * 1000,
    "recurrence: accepts epoch millis",
  );
}

console.log(`\nAll ${count} assertions passed.`);
