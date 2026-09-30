// Unit tests for P6 pure helpers (encryptToken / decryptToken,
// obfuscate / deobfuscate, buildGoogleAuthUrl).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");
const nodeCrypto = require("crypto");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P6 HELPERS START =====";
const endMarker = "// ===== P6 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from.
// `crypto` is injected as a parameter so the block uses Node's crypto module
// (not the WebCrypto global) during extraction.
const factory = new Function(
  "crypto",
  helpers +
    "\nreturn { encryptToken, decryptToken, obfuscate, deobfuscate, buildGoogleAuthUrl };"
);
const { encryptToken, decryptToken, obfuscate, deobfuscate, buildGoogleAuthUrl } =
  factory(nodeCrypto);

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// Fixed 64-hex test key (32 bytes of 0x01.. pattern, deterministic).
const TEST_KEY =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const OTHER_KEY =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
assert.strictEqual(TEST_KEY.length, 64);
assert.strictEqual(OTHER_KEY.length, 64);

// --- encryptToken / decryptToken ---
t("encrypt/decrypt round-trip with a fixed 64-hex test key", () => {
  const payload = encryptToken("secret-access-token-123", TEST_KEY);
  assert.strictEqual(decryptToken(payload, TEST_KEY), "secret-access-token-123");
});

t("round-trip preserves unicode and empty strings", () => {
  assert.strictEqual(decryptToken(encryptToken("", TEST_KEY), TEST_KEY), "");
  assert.strictEqual(
    decryptToken(encryptToken("héllo wörld 🚀", TEST_KEY), TEST_KEY),
    "héllo wörld 🚀"
  );
});

t("payload format is ivHex:cipherHex:authTagHex", () => {
  const payload = encryptToken("abc", TEST_KEY);
  const parts = payload.split(":");
  assert.strictEqual(parts.length, 3);
  assert.ok(parts.every((p) => /^[0-9a-f]+$/.test(p)));
  assert.strictEqual(parts[0].length, 24); // 12-byte IV in hex
  assert.strictEqual(parts[2].length, 32); // 16-byte GCM tag in hex
});

t("encrypting twice yields different ciphertexts (random IV)", () => {
  assert.notStrictEqual(
    encryptToken("same-secret", TEST_KEY),
    encryptToken("same-secret", TEST_KEY)
  );
});

t("wrong-key decrypt throws", () => {
  const payload = encryptToken("secret", TEST_KEY);
  assert.throws(() => decryptToken(payload, OTHER_KEY));
});

t("tampered ciphertext throws (auth tag check)", () => {
  const payload = encryptToken("secret", TEST_KEY);
  const parts = payload.split(":");
  const last = parts[1].slice(-1);
  parts[1] = parts[1].slice(0, -1) + (last === "0" ? "1" : "0");
  assert.throws(() => decryptToken(parts.join(":"), TEST_KEY));
});

t("encryptToken throws on bad input", () => {
  assert.throws(() => encryptToken(123, TEST_KEY));
  assert.throws(() => encryptToken(null, TEST_KEY));
  assert.throws(() => encryptToken("x", "too-short"));
  assert.throws(() => encryptToken("x", "zz" + TEST_KEY.slice(2))); // non-hex
  assert.throws(() => encryptToken("x", null));
  assert.throws(() => encryptToken("x"));
});

t("decryptToken throws on bad input", () => {
  assert.throws(() => decryptToken("not-a-payload", TEST_KEY));
  assert.throws(() => decryptToken("a:b", TEST_KEY));
  assert.throws(() => decryptToken("a:b:c:d", TEST_KEY));
  assert.throws(() => decryptToken(123, TEST_KEY));
  assert.throws(() => decryptToken("aa:bb:cc", "badkey"));
});

// --- obfuscate / deobfuscate ---
t("obfuscate/deobfuscate round-trip", () => {
  assert.strictEqual(deobfuscate(obfuscate("plain-secret")), "plain-secret");
});

t("obfuscate/deobfuscate throw on bad input", () => {
  assert.throws(() => obfuscate(42));
  assert.throws(() => deobfuscate(""));
  assert.throws(() => deobfuscate(null));
});

// --- buildGoogleAuthUrl ---
t("buildGoogleAuthUrl contains client_id/redirect_uri/scope/access_type=offline/state", () => {
  const url = buildGoogleAuthUrl({
    clientId: "my-client-id",
    redirectUri: "http://localhost:5000/api/integrations/google/callback",
    state: "test-state-123",
  });
  assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get("client_id"), "my-client-id");
  assert.strictEqual(
    u.searchParams.get("redirect_uri"),
    "http://localhost:5000/api/integrations/google/callback"
  );
  assert.strictEqual(u.searchParams.get("response_type"), "code");
  assert.strictEqual(u.searchParams.get("access_type"), "offline");
  assert.strictEqual(u.searchParams.get("prompt"), "consent");
  assert.strictEqual(u.searchParams.get("state"), "test-state-123");
  const scope = u.searchParams.get("scope");
  assert.ok(scope.includes("openid"), "scope has openid");
  assert.ok(scope.includes("email"), "scope has email");
  assert.ok(scope.includes("profile"), "scope has profile");
  assert.ok(
    scope.includes("https://www.googleapis.com/auth/calendar.readonly"),
    "scope has calendar.readonly"
  );
  assert.ok(
    scope.includes("https://www.googleapis.com/auth/gmail.compose"),
    "scope has gmail.compose"
  );
});

t("buildGoogleAuthUrl throws on missing inputs", () => {
  assert.throws(() => buildGoogleAuthUrl({}));
  assert.throws(() =>
    buildGoogleAuthUrl({ clientId: "x", redirectUri: "y" })
  );
  assert.throws(() =>
    buildGoogleAuthUrl({ clientId: "", redirectUri: "y", state: "z" })
  );
});

console.log(`\n${passed} tests passed`);
