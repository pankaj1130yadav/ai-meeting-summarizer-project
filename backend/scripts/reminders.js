// ===== P5: Reminder job =====
// Standalone cron job: scans action-item deadlines and creates in-app
// Notification documents. Idempotent via dedupeKey — re-running the job
// never creates a duplicate notification for the same
// (type, meeting, item, day); duplicate-key inserts are caught and skipped.
//
//   0 * * * * cd ~/workspace/meeting-platform/backend && node scripts/reminders.js
//
// EMAIL IS STUBBED — there is NO SMTP in this project and this job never
// sends real email. When EMAIL_ENABLED=true AND the user opted in via their
// emailEnabled preference, sendStubEmail() only logs "[EMAIL STUB] ...";
// real delivery requires wiring an actual SMTP provider (not implemented).
//
// Requires MONGO_URI (exits 1 with a clear message when missing).
// JWT_SECRET must also be present in the environment because server.js
// validates it at require time (it is required to run the API server too).

require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error(
    "reminders.js: MONGO_URI is not set — cannot connect to MongoDB. Exiting."
  );
  process.exit(1);
}

// Requiring server.js is safe: it only calls app.listen() when run as the
// main module (guarded by `if (require.main === module)` at the bottom of
// server.js), so requiring it here opens no port. We pull the compiled
// models + pure helpers from its exports — no schema duplication.
const {
  mongoose,
  User,
  Meeting,
  Notification,
  Preference,
  parseDueDate,
  isOverdueActionItem,
  buildDedupeKey,
  isReminderDue,
} = require("../server.js");

// ---- Stub mailer: LOGS ONLY, never sends. There is no SMTP transport in
// this project; real sending is intentionally unimplemented. ----
const sendStubEmail = (to, subject, body) => {
  console.log(
    `[EMAIL STUB] To: ${to} | Subject: ${subject} | Body: ${String(body).slice(0, 200)}`
  );
};

const DEFAULT_REMINDER_HOURS = 24;

// parseDueDate returns local-midnight dates; taking .toISOString() on those
// directly would shift the calendar day for timezones ahead of UTC (e.g.
// Asia/Kolkata). Rebuild the same calendar day at UTC midnight so the
// dedupeKey's YYYY-MM-DD component always equals the deadline's day.
const toUtcDay = (d) =>
  new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

const main = async () => {
  // server.js already kicked off mongoose.connect(); calling it again with
  // the same URI waits on the in-flight connection without opening a second.
  await mongoose.connect(MONGO_URI);

  const now = new Date();
  let checked = 0; // candidate action items evaluated (pending + parseable deadline)
  let created = 0; // notifications created
  let skipped = 0; // dedupe hits (already notified) + unusable keys

  const meetings = await Meeting.find({
    "actionItems.status": { $in: ["Pending", "In Progress"] },
  }).select("user title actionItems");

  const prefCache = new Map(); // userId -> Preference doc (or null)
  const userCache = new Map(); // userId -> user doc (or null)

  const prefFor = async (userId) => {
    const key = String(userId);
    if (!prefCache.has(key)) {
      prefCache.set(key, await Preference.findOne({ user: userId }).lean());
    }
    return prefCache.get(key);
  };

  const userFor = async (userId) => {
    const key = String(userId);
    if (!userCache.has(key)) {
      userCache.set(
        key,
        await User.findById(userId).select("email name").lean()
      );
    }
    return userCache.get(key);
  };

  for (const meeting of meetings) {
    const items = Array.isArray(meeting.actionItems) ? meeting.actionItems : [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (!item || !["Pending", "In Progress"].includes(item.status)) continue;

      const due = parseDueDate(item.deadline, now); // local-midnight Date or null
      if (!due) continue; // unparseable / "Not specified" deadlines are skipped
      checked++;

      // Per-user reminder window; falls back to 24h when the user never
      // saved preferences.
      const pref = await prefFor(meeting.user);
      const hoursBefore =
        typeof pref?.reminderHoursBefore === "number"
          ? pref.reminderHoursBefore
          : DEFAULT_REMINDER_HOURS;

      let type;
      let keyDate;
      let title;
      let body;
      if (isOverdueActionItem(item, now)) {
        type = "overdue";
        // Overdue notifications dedupe per calendar day (UTC), so the job
        // re-notifies daily until the item is completed/cancelled.
        keyDate = toUtcDay(now);
        title = `Overdue: ${item.task}`;
        body = `"${item.task}" from "${meeting.title}" is past its deadline (${item.deadline}).`;
      } else if (isReminderDue(due, now, hoursBefore)) {
        type = "deadline_reminder";
        keyDate = toUtcDay(due);
        title = `Deadline approaching: ${item.task}`;
        body = `"${item.task}" from "${meeting.title}" is due ${item.deadline}.`;
      } else {
        continue;
      }

      const dedupeKey = buildDedupeKey(type, meeting._id, idx, keyDate);
      if (!dedupeKey) {
        skipped++;
        continue;
      }

      try {
        await Notification.create({
          user: meeting.user,
          type,
          title,
          body,
          meeting: meeting._id,
          dedupeKey,
        });
        created++;
      } catch (err) {
        if (err && err.code === 11000) {
          skipped++; // already notified for this key — idempotent re-run
          continue;
        }
        throw err; // real DB errors fail the run loudly (caught below)
      }

      // ---- Email: STUB ONLY. Real SMTP is not configured in this project,
      // so this branch can only ever log. It requires BOTH the global
      // EMAIL_ENABLED flag AND the user's own emailEnabled preference. ----
      try {
        if (process.env.EMAIL_ENABLED === "true" && pref?.emailEnabled) {
          const user = await userFor(meeting.user);
          if (user?.email) {
            sendStubEmail(user.email, title, body);
          }
        }
      } catch (err) {
        console.error(
          "reminders.js: stub-email lookup failed:",
          err && err.message ? err.message : err
        );
      }
    }
  }

  console.log(JSON.stringify({ checked, created, skipped }));
};

// Never throw unhandled: report the failure and exit non-zero.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      "reminders.js failed:",
      err && err.message ? err.message : err
    );
    process.exit(1);
  });
