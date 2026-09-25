// Caption language handling for the Microphones app (app/apps/microphones/caption-lang.ts):
// the language decision from the caption model's tag and the text's script, SenseVoice
// spacing cleanup, what the glasses show (English only), and the translation log format.
// Sample sentences are SenseVoice's own outputs on FLEURS dev clips (desktop benchmark,
// 2026-09-24) where noted.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  captionModelKind,
  captionLanguageLabel,
  CAPTION_LANGUAGES,
  TRANSLATION_PACK_LANGS,
  resolveCaptionLang,
  compactCjkSpaces,
  glassesCaptionText,
  localDateStamp,
  localIsoTime,
  translationLogFileName,
  translationLogRecord,
  translationLogEvent,
  chooseCaptionModel,
} = require("../.test-build/app/apps/microphones/caption-lang.js");

test("caption language setting maps to the engine's model kinds", () => {
  assert.deepEqual([...CAPTION_LANGUAGES], ["english", "asian"]);
  assert.equal(captionModelKind("english"), "moonshine");
  assert.equal(captionModelKind("asian"), "sensevoice");
  assert.equal(captionModelKind(""), "moonshine");
  assert.equal(captionModelKind("junk"), "moonshine");
  assert.equal(captionLanguageLabel("asian"), "Japanese, Korean, Chinese (+ English)");
  assert.equal(captionLanguageLabel("english"), "English");
  assert.deepEqual([...TRANSLATION_PACK_LANGS], ["ja", "ko", "zh"]);
});

test("the model tag decides when the script doesn't", () => {
  // SenseVoice, FLEURS ja-1519 (kana present: script decides, agrees with the tag).
  assert.deepEqual(
    resolveCaptionLang("ja", "多くの場合、海外のギャップイヤーコースに入学することで、企画後に実際に大学に進学しやすくなります。"),
    { lang: "ja", source: "script" },
  );
  // Han only: the tag decides between Chinese and Japanese.
  assert.deepEqual(resolveCaptionLang("zh", "报告警告称，没有人能保证目前在伊拉克采取的任何行动能够阻止宗派战争。"), {
    lang: "zh",
    source: "model",
  });
  assert.deepEqual(resolveCaptionLang("ja", "東京駅。"), { lang: "ja", source: "model" });
  assert.deepEqual(resolveCaptionLang("ko", "이제 과학적 데이터가"), { lang: "ko", source: "script" });
  assert.deepEqual(resolveCaptionLang("en", "Where is the station?"), { lang: "en", source: "model" });
});

test("the script overrides a wrong tag", () => {
  // A 5 s crop of FLEURS ja-1608 that began in near-silence came back tagged en.
  assert.equal(resolveCaptionLang("en", "私は妹やその友人と").lang, "ja");
  assert.equal(resolveCaptionLang("zh", "すみません").lang, "ja");
  assert.equal(resolveCaptionLang("ja", "감사합니다").lang, "ko");
  assert.equal(resolveCaptionLang("en", "谢谢").lang, "zh");
  // A CJK tag on Latin-only text is English.
  assert.deepEqual(resolveCaptionLang("ja", "OK."), { lang: "en", source: "script" });
});

test("Cantonese translates through Chinese; no tag and no script leaves it to ML Kit", () => {
  assert.deepEqual(resolveCaptionLang("yue", "你好"), { lang: "zh", source: "model" });
  assert.deepEqual(resolveCaptionLang("", "Where is the station?"), { lang: "", source: "" });
  assert.deepEqual(resolveCaptionLang("", ""), { lang: "", source: "" });
  // Moonshine gives no tag, but kana still settles it.
  assert.deepEqual(resolveCaptionLang("", "ありがとう"), { lang: "ja", source: "script" });
});

test("spaces between CJK characters are dropped; Korean and English spacing stays", () => {
  // SenseVoice, 5 s crop of FLEURS ja-1607.
  assert.equal(compactCjkSpaces("興味 を そそ られる 村 を 30 分 ほど 散策 する の 。"), "興味をそそられる村を30分ほど散策するの。");
  assert.equal(compactCjkSpaces("이제 과학적 데이터가"), "이제 과학적 데이터가");
  assert.equal(compactCjkSpaces("Where is the station?"), "Where is the station?");
  assert.equal(compactCjkSpaces("  東京 駅  "), "東京駅");
  assert.equal(compactCjkSpaces("1 2 3"), "1 2 3");
  assert.equal(compactCjkSpaces("第 3 章"), "第3章");
});

test("the glasses show English only", () => {
  const base = { text: "駅はどこですか", lang: "ja", translation: "", translationState: "none" };
  assert.deepEqual(glassesCaptionText({ ...base, translation: "Where is the station?", translationState: "done" }), {
    text: "Where is the station?",
    dim: false,
  });
  assert.deepEqual(glassesCaptionText({ ...base, translationState: "pending" }), { text: "[ja] ...", dim: true });
  const failed = glassesCaptionText({ ...base, translationState: "failed" });
  assert.equal(failed.dim, true);
  assert.match(failed.text, /^\[ja\] \(not translated/);
  assert.ok(!failed.text.includes("駅"), "never the original script");
  assert.deepEqual(glassesCaptionText({ text: "Hello there", lang: "en", translation: "", translationState: "none" }), {
    text: "Hello there",
    dim: false,
  });
});

test("log file name and timestamps are local time with the offset", () => {
  const d = new Date(2026, 8, 27, 14, 3, 22, 123);
  assert.equal(localDateStamp(d), "2026-09-27");
  assert.equal(translationLogFileName(d), "translation-log-2026-09-27.jsonl");
  const iso = localIsoTime(d);
  assert.match(iso, /^2026-09-27T14:03:22\.123[+-]\d\d:\d\d$/);
  // Same instant as the Date, whatever zone the test runs in.
  assert.equal(new Date(iso).getTime(), d.getTime());
});

test("a log record keeps timestamp, language, original and English on one JSON line", () => {
  const atMs = new Date(2026, 8, 27, 9, 0, 0, 0).getTime();
  const line = translationLogRecord({
    atMs,
    lang: "ja",
    langSource: "script",
    text: "駅はどこですか。",
    english: "Where is the station?",
    translationState: "done",
    speaker: "Speaker 2",
    model: "sensevoice",
    audioMs: 1840.4,
    decodeMs: 212.6,
    sessionId: 17,
  });
  assert.ok(!line.includes("\n"));
  const parsed = JSON.parse(line);
  assert.equal(parsed.ms, atMs);
  assert.equal(new Date(parsed.t).getTime(), atMs);
  assert.equal(parsed.lang, "ja");
  assert.equal(parsed.langFrom, "script");
  assert.equal(parsed.text, "駅はどこですか。");
  assert.equal(parsed.en, "Where is the station?");
  assert.equal(parsed.enState, "done");
  assert.equal(parsed.speaker, "Speaker 2");
  assert.equal(parsed.model, "sensevoice");
  assert.equal(parsed.audioMs, 1840);
  assert.equal(parsed.decodeMs, 213);
  assert.equal(parsed.session, 17);
  assert.equal(JSON.parse(translationLogRecord({ ...JSON.parse(JSON.stringify({})), atMs, lang: "", langSource: "", text: "x", english: "", translationState: "failed", speaker: "", model: "m", audioMs: 0, decodeMs: 0, sessionId: -1 })).lang, "und");
  const start = JSON.parse(translationLogEvent("start", atMs, { model: "sensevoice", loadMs: 900, nativeHeapMb: [40, 300] }));
  assert.equal(start.type, "start");
  assert.equal(start.model, "sensevoice");
  assert.deepEqual(start.nativeHeapMb, [40, 300]);
});

// 2026-09-25: English mode with Moonshine missing ran the engine with no
// recognizer and produced nothing, silently. The choice must fall back to
// SenseVoice (which also hears English) and say so when nothing is usable.
test("caption model choice falls back and says when no model is on the phone", () => {
  assert.deepEqual(chooseCaptionModel("english", true, true), { kind: "moonshine", ready: true, note: "" });
  assert.deepEqual(chooseCaptionModel("asian", true, true), { kind: "sensevoice", ready: true, note: "" });
  // The phone on 2026-09-25: setting unset (English), only SenseVoice downloaded.
  const fallback = chooseCaptionModel("english", false, true);
  assert.equal(fallback.kind, "sensevoice");
  assert.equal(fallback.ready, true);
  assert.match(fallback.note, /English model not downloaded/);
  const englishOnly = chooseCaptionModel("asian", true, false);
  assert.equal(englishOnly.kind, "moonshine");
  assert.equal(englishOnly.ready, true);
  assert.match(englishOnly.note, /English captions only/);
  for (const lang of ["english", "asian", ""]) {
    const none = chooseCaptionModel(lang, false, false);
    assert.equal(none.ready, false);
    assert.match(none.note, /No caption model downloaded/);
  }
});
