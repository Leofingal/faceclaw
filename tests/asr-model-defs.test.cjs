// The on-device transcription model registry (app/native/asr-model-defs.ts):
// pinned download entries, the provider-to-model mapping, and the idle-unload
// choices. The Java side (FaceclawOnboardAsr.java) names the same directories
// and files; the last test reads that source to keep the two in step.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ASR_MODELS,
  ASR_MODEL_IDS,
  CAPTION_ONLY_MODEL_IDS,
  ONBOARD_PROVIDERS,
  onboardModelKindForProvider,
  IDLE_UNLOAD_CHOICES,
  DEFAULT_IDLE_UNLOAD_CHOICE,
  idleUnloadMinutes,
  formatIdleUnloadChoice,
} = require("../.test-build/app/native/asr-model-defs.js");

test("every registry id has an entry and every entry is listed", () => {
  assert.deepEqual([...ASR_MODEL_IDS].sort(), Object.keys(ASR_MODELS).sort());
});

test("each model's totalBytes is the sum of its files, and each file is pinned", () => {
  for (const id of ASR_MODEL_IDS) {
    const def = ASR_MODELS[id];
    const sum = def.files.reduce((total, file) => total + file.sizeBytes, 0);
    assert.equal(def.totalBytes, sum, `${id} totalBytes`);
    for (const file of def.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${id}/${file.name} sha256`);
      assert.ok(Number.isInteger(file.sizeBytes) && file.sizeBytes > 0, `${id}/${file.name} size`);
    }
    assert.ok(def.baseUrl.startsWith("https://huggingface.co/") && def.baseUrl.endsWith("/"), `${id} baseUrl`);
  }
});

test("Parakeet v2 is the sherpa-onnx export, 661 MB, pinned to a commit", () => {
  const def = ASR_MODELS["parakeet-v2"];
  assert.equal(def.label, "Parakeet v2 (0.6B)");
  assert.equal(def.dirName, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
  assert.equal(def.totalBytes, 661190513);
  assert.match(def.baseUrl, /\/csukuangfj\/sherpa-onnx-nemo-parakeet-tdt-0\.6b-v2-int8\/resolve\/[0-9a-f]{40}\/$/);
  assert.deepEqual(
    def.files.map((f) => [f.name, f.sizeBytes, f.sha256.slice(0, 8)]),
    [
      ["encoder.int8.onnx", 652184296, "a32b12d1"],
      ["decoder.int8.onnx", 7257753, "b6bb6496"],
      ["joiner.int8.onnx", 1739080, "79461643"],
      ["tokens.txt", 9384, "ec182b70"],
    ],
  );
});

test("Parakeet 110M carries the hashes of sherpa-onnx's own tarball files, pinned to a commit", () => {
  const def = ASR_MODELS["parakeet-110m"];
  assert.equal(def.label, "Parakeet (110M)");
  assert.equal(def.dirName, "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8");
  assert.equal(def.totalBytes, 136490421);
  assert.match(def.baseUrl, /\/resolve\/[0-9a-f]{40}\/$/);
  assert.deepEqual(
    def.files.map((f) => [f.name, f.sizeBytes, f.sha256.slice(0, 8)]),
    [
      ["encoder.int8.onnx", 131113202, "0f35509d"],
      ["decoder.int8.onnx", 3955863, "f7c331c5"],
      ["joiner.int8.onnx", 1411403, "bf7dff69"],
      ["tokens.txt", 9953, "450e56bd"],
    ],
  );
});

test("the two existing models are unchanged", () => {
  assert.equal(ASR_MODELS.moonshine.totalBytes, 141300566);
  assert.equal(ASR_MODELS["whisper-base-en"].totalBytes, 160626066);
  assert.equal(ASR_MODELS["whisper-base-en"].dirName, "sherpa-onnx-whisper-base-en-int8");
});

test("provider values map to on-device models; cloud and box providers do not", () => {
  assert.equal(onboardModelKindForProvider("onboard"), "moonshine");
  assert.equal(onboardModelKindForProvider("onboard-whisper"), "whisper");
  assert.equal(onboardModelKindForProvider("onboard-parakeet-v2"), "parakeet-v2");
  assert.equal(onboardModelKindForProvider("onboard-parakeet-110m"), "parakeet-110m");
  for (const cloud of ["whisper", "elevenlabs", "soniox", "ghost", "", "toString", "__proto__"]) {
    assert.equal(onboardModelKindForProvider(cloud), null, cloud);
  }
  for (const [provider, def] of Object.entries(ONBOARD_PROVIDERS)) {
    assert.ok(ASR_MODELS[def.model], `${provider} names a registry model`);
  }
});

test("idle unload: default never, never = 0, junk falls back to the default", () => {
  assert.equal(DEFAULT_IDLE_UNLOAD_CHOICE, "never");
  assert.ok(IDLE_UNLOAD_CHOICES.includes(DEFAULT_IDLE_UNLOAD_CHOICE));
  assert.equal(idleUnloadMinutes("5"), 5);
  assert.equal(idleUnloadMinutes("1"), 1);
  assert.equal(idleUnloadMinutes("30"), 30);
  assert.equal(idleUnloadMinutes("never"), 0);
  assert.equal(idleUnloadMinutes("7"), 0);
  assert.equal(idleUnloadMinutes("-1"), 0);
  assert.equal(idleUnloadMinutes(""), 0);
  assert.ok(Number.isFinite(idleUnloadMinutes("junk")), "the default never becomes NaN");
  assert.equal(formatIdleUnloadChoice("1"), "After 1 minute");
  assert.equal(formatIdleUnloadChoice("5"), "After 5 minutes");
  assert.equal(formatIdleUnloadChoice("never"), "Never");
});

test("SenseVoice is the sherpa-onnx 2024-07-17 export, caption-only, pinned to a commit", () => {
  const def = ASR_MODELS.sensevoice;
  assert.deepEqual([...CAPTION_ONLY_MODEL_IDS], ["sensevoice"]);
  assert.equal(def.dirName, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17");
  assert.equal(def.totalBytes, 239549735);
  assert.match(def.baseUrl, /\/csukuangfj\/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17\/resolve\/[0-9a-f]{40}\/$/);
  assert.deepEqual(
    def.files.map((f) => [f.name, f.sizeBytes, f.sha256.slice(0, 8)]),
    [
      ["model.int8.onnx", 239233841, "c71f0ce0"],
      ["tokens.txt", 315894, "f449eb28"],
    ],
  );
  for (const def of Object.values(ONBOARD_PROVIDERS)) {
    assert.ok(!CAPTION_ONLY_MODEL_IDS.includes(def.model), `no Voice provider runs ${def.model}`);
  }
});

test("the caption engine names SenseVoice's files", () => {
  const javaPath = path.join(__dirname, "..", "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawCaptionEngine.java");
  const java = fs.readFileSync(javaPath, "utf8");
  for (const file of ASR_MODELS.sensevoice.files) {
    assert.ok(java.includes(`"${file.name}"`), `${file.name} in FaceclawCaptionEngine.java`);
  }
  assert.ok(java.includes('MODEL_SENSEVOICE = "sensevoice"'));
});

test("the Java model policy names the same directories and files", () => {
  const javaPath = path.join(__dirname, "..", "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawOnboardAsr.java");
  const java = fs.readFileSync(javaPath, "utf8");
  const javaIds = { moonshine: "moonshine", "whisper-base-en": "whisper", "parakeet-v2": "parakeet-v2", "parakeet-110m": "parakeet-110m" };
  for (const id of ASR_MODEL_IDS.filter((id) => !CAPTION_ONLY_MODEL_IDS.includes(id))) {
    const def = ASR_MODELS[id];
    // The enum constant's block: from its id string to the closing "Gate." of its constructor call.
    const start = java.indexOf(`("${javaIds[id]}", `);
    assert.ok(start >= 0, `Java enum entry for ${id}`);
    const block = java.slice(start, java.indexOf("Gate.", start));
    assert.ok(block.includes(`"${def.dirName}"`), `${id} dirName in Java`);
    for (const file of def.files) {
      assert.ok(block.includes(`"${file.name}"`), `${id}/${file.name} in Java`);
    }
    assert.equal((block.match(/"[^"]+\.(onnx|ort|txt)"/g) || []).length, def.files.length, `${id} file count in Java`);
  }
});
