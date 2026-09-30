// Unit tests for Phase 4 pure helpers (getWorkspaceRole, canReadMeeting).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P4 HELPERS START =====";
const endMarker = "// ===== P4 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers + "\nreturn { getWorkspaceRole, canReadMeeting };"
);
const { getWorkspaceRole, canReadMeeting } = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// Fake id objects whose String() yields the given value (like ObjectIds).
const oid = (s) => ({ toString: () => s });

const OWNER = oid("owner1");
const ADMIN = oid("admin1");
const MANAGER = oid("mgr1");
const MEMBER = oid("member1");
const STRANGER = oid("stranger1");

// --- getWorkspaceRole: raw ObjectIds ---
const rawWs = {
  owner: OWNER,
  members: [
    { user: ADMIN, role: "admin", joinedAt: new Date() },
    { user: MANAGER, role: "manager", joinedAt: new Date() },
    { user: MEMBER, role: "member", joinedAt: new Date() },
  ],
};

t("getWorkspaceRole: owner (raw ObjectId)", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, OWNER), "owner");
});
t("getWorkspaceRole: admin (raw ObjectId)", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, ADMIN), "admin");
});
t("getWorkspaceRole: manager (raw ObjectId)", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, MANAGER), "manager");
});
t("getWorkspaceRole: member (raw ObjectId)", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, MEMBER), "member");
});
t("getWorkspaceRole: stranger -> null", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, STRANGER), null);
});
t("getWorkspaceRole: string userId compares equal to ObjectId", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, "member1"), "member");
});

// --- getWorkspaceRole: populated docs ---
const populatedWs = {
  owner: { _id: oid("owner1"), name: "Owner" },
  members: [
    { user: { _id: oid("admin1"), name: "Admin" }, role: "admin" },
    { user: { _id: oid("member1"), name: "Member" }, role: "member" },
  ],
};

t("getWorkspaceRole: populated owner doc -> owner", () => {
  assert.strictEqual(getWorkspaceRole(populatedWs, "owner1"), "owner");
});
t("getWorkspaceRole: populated member doc -> member role", () => {
  assert.strictEqual(getWorkspaceRole(populatedWs, "member1"), "member");
  assert.strictEqual(getWorkspaceRole(populatedWs, "admin1"), "admin");
});
t("getWorkspaceRole: populated doc, stranger -> null", () => {
  assert.strictEqual(getWorkspaceRole(populatedWs, "stranger1"), null);
});

// --- getWorkspaceRole: defensive inputs ---
t("getWorkspaceRole: null workspace -> null", () => {
  assert.strictEqual(getWorkspaceRole(null, "owner1"), null);
});
t("getWorkspaceRole: null userId -> null", () => {
  assert.strictEqual(getWorkspaceRole(rawWs, null), null);
});
t("getWorkspaceRole: missing members array -> stranger null", () => {
  assert.strictEqual(
    getWorkspaceRole({ owner: OWNER }, STRANGER),
    null
  );
  assert.strictEqual(getWorkspaceRole({ owner: OWNER }, OWNER), "owner");
});

// --- canReadMeeting ---
const ownMeeting = { _id: oid("m1"), user: OWNER, visibility: "private" };
const sharedMeeting = {
  _id: oid("m2"),
  user: OWNER,
  visibility: "workspace",
  workspace: oid("ws1"),
};
const unsharedMeeting = {
  _id: oid("m3"),
  user: OWNER,
  visibility: "workspace", // no workspace attached
};

t("canReadMeeting: owner always reads (private)", () => {
  assert.strictEqual(canReadMeeting(ownMeeting, null, OWNER), true);
});
t("canReadMeeting: owner reads shared meeting", () => {
  assert.strictEqual(canReadMeeting(sharedMeeting, rawWs, OWNER), true);
});
t("canReadMeeting: member reads workspace-shared meeting", () => {
  assert.strictEqual(canReadMeeting(sharedMeeting, rawWs, MEMBER), true);
  assert.strictEqual(canReadMeeting(sharedMeeting, rawWs, ADMIN), true);
});
t("canReadMeeting: stranger cannot read workspace-shared meeting", () => {
  assert.strictEqual(canReadMeeting(sharedMeeting, rawWs, STRANGER), false);
});
t("canReadMeeting: shared meeting without workspace doc -> false", () => {
  assert.strictEqual(canReadMeeting(sharedMeeting, null, MEMBER), false);
});
t("canReadMeeting: shared flag but no workspace on meeting -> false", () => {
  // The caller resolves the meeting's workspace doc; with no workspace
  // attached to the meeting it passes null (see findReadableMeeting).
  assert.strictEqual(canReadMeeting(unsharedMeeting, null, MEMBER), false);
});
t("canReadMeeting: private + non-owner -> false even in workspace", () => {
  assert.strictEqual(canReadMeeting(ownMeeting, rawWs, MEMBER), false);
});
t("canReadMeeting: null meeting / null user -> false", () => {
  assert.strictEqual(canReadMeeting(null, rawWs, MEMBER), false);
  assert.strictEqual(canReadMeeting(sharedMeeting, rawWs, null), false);
});

console.log(`\n${passed} tests passed`);
