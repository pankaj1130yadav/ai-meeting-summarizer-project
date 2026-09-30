// Unit tests for P1-fix-B1 pure helpers (isAllowedAudioFile).
// Extracts the helper block from server.js so the tests run against the real code.
const fs = require("fs");
const assert = require("assert");

const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const startMarker = "// ===== P1-FIX-B1 HELPERS START =====";
const endMarker = "// ===== P1-FIX-B1 HELPERS END =====";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
assert.ok(start !== -1 && end !== -1 && end > start, "helper markers not found");
const helpers = src.slice(start, end);
// new Function gives the const-declared helpers a scope we can return from
const factory = new Function(
  helpers + "\nreturn { AUDIO_MIME_TYPES, AUDIO_EXTENSIONS, isAllowedAudioFile };"
);
const { AUDIO_MIME_TYPES, AUDIO_EXTENSIONS, isAllowedAudioFile } = factory();

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok -", name);
};

// --- allow lists ---
t("MIME allow list has all 9 required types", () => {
  assert.deepStrictEqual(AUDIO_MIME_TYPES, [
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "audio/aac",
    "audio/x-m4a",
  ]);
});
t("extension allow list has all 8 required extensions", () => {
  assert.deepStrictEqual(AUDIO_EXTENSIONS, [
    ".mp3",
    ".wav",
    ".m4a",
    ".ogg",
    ".webm",
    ".flac",
    ".aac",
    ".mp4",
  ]);
});

// --- isAllowedAudioFile ---
t("mp3 with audio/mpeg -> allowed", () => {
  assert.strictEqual(isAllowedAudioFile("audio/mpeg", "voice.mp3"), true);
});
t("m4a with audio/x-m4a -> allowed (case-insensitive name)", () => {
  assert.strictEqual(
    isAllowedAudioFile("audio/x-m4a", "Recording.M4A"),
    true
  );
});
t("wav with audio/wav -> allowed", () => {
  assert.strictEqual(isAllowedAudioFile("audio/wav", "notes.wav"), true);
});
t("webm with audio/webm -> allowed", () => {
  assert.strictEqual(
    isAllowedAudioFile("audio/webm", "meeting.webm"),
    true
  );
});
t("good mime but bad extension (.txt) -> rejected", () => {
  assert.strictEqual(isAllowedAudioFile("audio/mpeg", "note.txt"), false);
});
t("good extension but bad mime (video/mp4) -> rejected", () => {
  assert.strictEqual(isAllowedAudioFile("video/mp4", "clip.mp4"), false);
});
t("no extension -> rejected", () => {
  assert.strictEqual(isAllowedAudioFile("audio/mpeg", "noextension"), false);
});
t("non-string inputs -> rejected", () => {
  assert.strictEqual(isAllowedAudioFile(null, "voice.mp3"), false);
  assert.strictEqual(isAllowedAudioFile("audio/mpeg", null), false);
  assert.strictEqual(isAllowedAudioFile(undefined, undefined), false);
});

console.log(`\n${passed} tests passed`);
