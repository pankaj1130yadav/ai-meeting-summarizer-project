// Phase 9 API integration tests (supertest).
//
// SELF-SKIP: these tests need a real MongoDB and a Groq API key, neither of
// which exists in CI / this sandbox. When the env is missing we print the
// skip notice and exit 0 so `npm test` stays green. The real (non-skipped)
// run is documented in MANUAL_QA.md and is intentionally NOT executed here.
if (!process.env.MONGO_URI || !process.env.GROQ_API_KEY) {
  console.log("SKIPPED: requires local MongoDB + GROQ_API_KEY (not run)");
  process.exit(0);
}

// JWT_SECRET is needed to sign/verify tokens; use an obviously fake,
// test-only value when the developer hasn't set one locally.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "integration-test-only-not-a-real-secret";
}

const assert = require("assert");
const request = require("supertest");
// Requiring server.js must NOT open a port (require.main guard) and does
// attempt mongoose.connect(process.env.MONGO_URI) — see waitForDb below.
const { app, mongoose, User, Meeting } = require("./server");

const waitForDb = async (timeoutMs = 15000) => {
  const start = Date.now();
  while (mongoose.connection.readyState !== 1) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for MongoDB connection");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
};

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log("ok -", name);
};

(async () => {
  try {
    await waitForDb();

    const stamp = Date.now();
    const emailA = `p9-int-a-${stamp}@example.com`;
    const emailB = `p9-int-b-${stamp}@example.com`;
    const password = "testpass123";

    const register = (email) =>
      request(app)
        .post("/api/auth/register")
        .send({ name: "P9 Test", email, password });

    const login = (email) =>
      request(app).post("/api/auth/login").send({ email, password });

    await t("register user A", async () => {
      const res = await register(emailA);
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    });

    let tokenA, userIdA;
    await t("login user A returns a token", async () => {
      const res = await login(emailA);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.token, "expected a token in the login response");
      tokenA = res.body.token;
      userIdA = res.body.user.id;
    });

    let tokenB;
    await t("register + login user B", async () => {
      const r1 = await register(emailB);
      assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
      const r2 = await login(emailB);
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
      assert.ok(r2.body.token);
      tokenB = r2.body.token;
    });

    let meetingId;
    await t("create meeting (via model — avoids Groq call in /summarize)", async () => {
      const m = await Meeting.create({
        user: userIdA,
        title: "P9 integration meeting",
        category: "General",
        transcript: "We decided to ship the integration tests.",
      });
      meetingId = String(m._id);
      assert.ok(meetingId);
    });

    await t("owner can GET their meeting", async () => {
      const res = await request(app)
        .get(`/api/meetings/${meetingId}`)
        .set("Authorization", `Bearer ${tokenA}`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(String(res.body._id), meetingId);
    });

    await t("another user gets 404 for the same meeting (auth scoping)", async () => {
      const res = await request(app)
        .get(`/api/meetings/${meetingId}`)
        .set("Authorization", `Bearer ${tokenB}`);
      assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    });

    await t("missing token -> 401", async () => {
      const res = await request(app).get(`/api/meetings/${meetingId}`);
      assert.strictEqual(res.status, 401, JSON.stringify(res.body));
    });

    await t("login with wrong password -> 400 (no user enumeration)", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: emailA, password: "wrong-password" });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    });

    // Cleanup test data.
    await Meeting.deleteOne({ _id: meetingId });
    await User.deleteMany({ email: { $in: [emailA, emailB] } });

    await mongoose.disconnect();
    console.log(`\n${passed} integration tests passed`);
    process.exit(0);
  } catch (err) {
    console.error("Integration test failure:", err && err.message);
    try {
      await mongoose.disconnect();
    } catch (_) {
      /* ignore */
    }
    process.exit(1);
  }
})();
