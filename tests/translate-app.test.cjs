// The Translate app's lifecycle (app/apps/microphones/mic-session-owners.ts;
// built as "Captions" and renamed 2026-09-25): opening Translate starts the
// caption session in Japanese/Korean/Chinese (+ English) mode whatever the
// "Languages I'll hear" setting says; leaving it stops captions, hands the
// language back to the setting and releases the mic; a Microphones window
// open alongside keeps the mic.
// The fake session mirrors MicSession's contract: start() starts captions only
// when the Captions setting is on; setCaptionsEnabled persists the setting and,
// while running, starts or stops captions immediately; the engine's language
// is the override when set, else the setting.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMicSessionOwners,
  openTranslateApp,
  closeTranslateApp,
  TRANSLATE_CAPTION_LANGUAGE,
} = require("../.test-build/app/apps/microphones/mic-session-owners.js");

function fakeSession(captionsSetting = false, languageSetting = "english") {
  const s = {
    setting: captionsSetting,
    languageSetting,
    override: null,
    running: false,
    captionsActive: false,
    engineLanguage: null,
    engineStarts: 0,
    starts: 0,
    stops: 0,
    language() {
      return s.override ?? s.languageSetting;
    },
    startEngine() {
      s.captionsActive = true;
      s.engineLanguage = s.language();
      s.engineStarts++;
    },
    stopEngine() {
      s.captionsActive = false;
      s.engineLanguage = null;
    },
    start() {
      if (s.running) return;
      s.running = true;
      s.starts++;
      if (s.setting) s.startEngine();
    },
    stop() {
      if (!s.running) return;
      s.running = false;
      s.stops++;
      s.stopEngine();
    },
    setCaptionsEnabled(enabled) {
      s.setting = enabled;
      if (!s.running) return;
      if (enabled && !s.captionsActive) s.startEngine();
      if (!enabled && s.captionsActive) s.stopEngine();
    },
    setCaptionLanguageOverride(language) {
      s.override = language;
      if (s.captionsActive && s.engineLanguage !== s.language()) {
        s.stopEngine();
        s.startEngine();
      }
    },
  };
  return s;
}

test("opening Translate starts the caption session in the Asian mode; leaving stops it and releases the mic", () => {
  const session = fakeSession(false, "english");
  const owners = createMicSessionOwners(session);
  openTranslateApp(session, owners);
  assert.equal(TRANSLATE_CAPTION_LANGUAGE, "asian");
  assert.equal(session.running, true);
  assert.equal(session.captionsActive, true);
  assert.equal(session.engineLanguage, "asian", "Translate ignores Languages I'll hear = English");
  assert.equal(session.engineStarts, 1, "started straight on the Asian model, no restart");
  assert.deepEqual(owners.held(), ["translate"]);
  closeTranslateApp(session, owners);
  assert.equal(session.running, false, "mic released");
  assert.equal(session.captionsActive, false);
  assert.equal(session.setting, false, "captions off after leaving");
  assert.equal(session.override, null, "the setting decides again");
  assert.equal(session.languageSetting, "english", "the setting itself is untouched");
  assert.deepEqual(owners.held(), []);
});

test("Translate opened over Microphones running English captions switches them to Asian; leaving keeps the mic for Microphones", () => {
  const session = fakeSession(true, "english");
  const owners = createMicSessionOwners(session);
  owners.acquire("microphones");
  assert.equal(session.engineLanguage, "english");
  openTranslateApp(session, owners);
  assert.equal(session.engineLanguage, "asian");
  assert.equal(session.starts, 1, "no second session start");
  closeTranslateApp(session, owners);
  assert.equal(session.running, true, "Microphones still holds the mic");
  assert.equal(session.captionsActive, false);
  assert.equal(session.engineStarts, 2, "no restart back to English on the way out");
  owners.release("microphones");
  assert.equal(session.running, false);
  assert.equal(session.stops, 1);
});

test("closing Microphones while Translate is open keeps captions running", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  openTranslateApp(session, owners);
  owners.acquire("microphones");
  owners.release("microphones");
  assert.equal(session.running, true);
  assert.equal(session.captionsActive, true);
  closeTranslateApp(session, owners);
  assert.equal(session.running, false);
});

test("a release by an owner that never acquired does not stop the session", () => {
  const session = fakeSession(false);
  const owners = createMicSessionOwners(session);
  openTranslateApp(session, owners);
  owners.release("microphones");
  assert.equal(session.running, true);
  closeTranslateApp(session, owners);
  closeTranslateApp(session, owners);
  assert.equal(session.stops, 1);
});
