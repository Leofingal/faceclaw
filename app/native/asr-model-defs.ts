/**
 * The on-device transcription models: what to download, and which Voice
 * provider setting runs which model. No NativeScript imports, so the node
 * tests can pin the registry (tests/asr-model-defs.test.cjs).
 *
 * The download machinery lives in asr-model.ts; the Java side
 * (FaceclawOnboardAsr.Model) names the same directories and files and must
 * stay in step with this file.
 *
 * Models:
 *  - "moonshine": the original on-device option (three files). The model is
 *    no longer bundled in the APK; it is fetched into the same filesDir
 *    location that earlier releases copied the bundled files to, so
 *    upgraded installs that already used on-device transcription need no
 *    download.
 *  - "whisper-base-en": sherpa-onnx's offline Whisper backend, base.en,
 *    int8-quantized. Picked over tiny.en for materially better accuracy
 *    (Whisper's own tiny/base WER gap is real and well documented) on the
 *    reasoning that FaceclawVoiceController no longer re-decodes a Whisper
 *    segment on every live-partial tick, so base.en's extra compute is a
 *    one-time cost per utterance. Files are csukuangfj's own (the sherpa-onnx
 *    maintainer's) HF mirror of the upstream sherpa-onnx release asset.
 *  - "parakeet-v2": NVIDIA Parakeet TDT 0.6B v2, int8, as exported by
 *    sherpa-onnx (csukuangfj's HF repo). On Chris's scripted recordings it
 *    made about a third of Whisper base.en's errors (1.9% / 3.4% WER against
 *    6.9% / 6.1%, hearing aids / G2 mic). Holds ~1 GB resident once loaded.
 *  - "parakeet-110m": NVIDIA Parakeet TDT_CTC 110M, transducer head, int8,
 *    sherpa-onnx's export. sherpa-onnx publishes the int8 files only inside a
 *    GitHub tar.bz2, which the phone can't unpack; this entry fetches the
 *    extracted files from a third-party HF repo (punitd), pinned to a commit.
 *    Every file's sha256 and size match the files extracted from sherpa-onnx's
 *    own tarball (sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8,
 *    asr-models release), so a changed mirror fails the hash check closed.
 *
 * Both Parakeet models are CC-BY-4.0 (credit in ACKNOWLEDGEMENTS.md). Hashes
 * for the LFS files were re-checked on 2026-09-16 against Hugging Face's
 * x-linked-etag/x-linked-size headers; tokens.txt files were downloaded and
 * hashed.
 */

export type AsrModelId = "moonshine" | "whisper-base-en" | "parakeet-v2" | "parakeet-110m";

export type AsrModelFile = {
  name: string;
  sha256: string;
  sizeBytes: number;
};

export type AsrModelDef = {
  label: string;
  dirName: string;
  baseUrl: string;
  files: AsrModelFile[];
  totalBytes: number;
};

export const ASR_MODEL_IDS: readonly AsrModelId[] = ["moonshine", "whisper-base-en", "parakeet-v2", "parakeet-110m"];

export const ASR_MODELS: Record<AsrModelId, AsrModelDef> = {
  moonshine: {
    label: "Moonshine (English)",
    dirName: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
    // Hugging Face mirror of the sherpa-onnx release asset of the same name.
    // The GitHub release only offers a tar.bz2, which the phone can't unpack;
    // this mirror serves the same files (sha256-verified) individually.
    baseUrl:
      "https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/resolve/main/",
    files: [
      {
        name: "decoder_model_merged.ort",
        sha256: "d9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d",
        sizeBytes: 109424400,
      },
      {
        name: "encoder_model.ort",
        sha256: "7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf",
        sizeBytes: 31326816,
      },
      {
        name: "tokens.txt",
        sha256: "2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049",
        sizeBytes: 549350,
      },
    ],
    totalBytes: 141300566,
  },
  "whisper-base-en": {
    label: "Whisper (English, base)",
    dirName: "sherpa-onnx-whisper-base-en-int8",
    // csukuangfj/sherpa-onnx-whisper-base.en on Hugging Face: the sherpa-onnx
    // maintainer's own mirror of the project's whisper export, individual
    // files (no tar.bz2-unpack problem to begin with, but kept as the same
    // per-file-with-pinned-hash shape as Moonshine above for consistency).
    baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base.en/resolve/main/",
    files: [
      {
        name: "base.en-encoder.int8.onnx",
        sha256: "ef6b936f4c9b1d90a3b68634b60c4ed8576b26172b33c2535ec0e933c9edb823",
        sizeBytes: 29120534,
      },
      {
        name: "base.en-decoder.int8.onnx",
        sha256: "f7162ad6db2dbef16cfaeaa7f945b9d7dd9c1b8d472f6aca82f2273d185e4d41",
        sizeBytes: 130669978,
      },
      {
        name: "base.en-tokens.txt",
        sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
        sizeBytes: 835554,
      },
    ],
    totalBytes: 160626066,
  },
  "parakeet-v2": {
    label: "Parakeet v2 (0.6B)",
    dirName: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    // Pinned to the repo's commit rather than main: the hash check would fail
    // closed on a change either way, but a pinned revision keeps working.
    baseUrl:
      "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/",
    files: [
      {
        name: "encoder.int8.onnx",
        sha256: "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
        sizeBytes: 652184296,
      },
      {
        name: "decoder.int8.onnx",
        sha256: "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
        sizeBytes: 7257753,
      },
      {
        name: "joiner.int8.onnx",
        sha256: "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
        sizeBytes: 1739080,
      },
      {
        name: "tokens.txt",
        sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
        sizeBytes: 9384,
      },
    ],
    totalBytes: 661190513,
  },
  "parakeet-110m": {
    label: "Parakeet (110M)",
    dirName: "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8",
    baseUrl:
      "https://huggingface.co/punitd/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8/resolve/66a4fa70643dc7ce25c9b38b2f87e1b35ddad33d/",
    files: [
      {
        name: "encoder.int8.onnx",
        sha256: "0f35509ddeb9b39002fb077d979a9fe74f06eb0bc4dd5c34f512f82e5111d657",
        sizeBytes: 131113202,
      },
      {
        name: "decoder.int8.onnx",
        sha256: "f7c331c5504c2e593c76ed22b728e3f554af6c4a383dde862e719ced08b1da19",
        sizeBytes: 3955863,
      },
      {
        name: "joiner.int8.onnx",
        sha256: "bf7dff69e9f2cdbe9943d70da358f38b361c115ba0105bae7e908e0d6ec782f6",
        sizeBytes: 1411403,
      },
      {
        name: "tokens.txt",
        sha256: "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
        sizeBytes: 9953,
      },
    ],
    totalBytes: 136490421,
  },
};

/**
 * The model id FaceclawVoiceController.setOnboardModelKind() takes
 * (FaceclawOnboardAsr.Model.id on the Java side).
 */
export type OnboardModelKind = "moonshine" | "whisper" | "parakeet-v2" | "parakeet-110m";

type OnboardProviderDef = { kind: OnboardModelKind; model: AsrModelId };

/**
 * Voice provider setting values that transcribe on the phone, and what each
 * one runs. "onboard" and "onboard-whisper" are persisted values on real
 * installs; keep them. Note "whisper" (no prefix) is OpenAI's cloud provider,
 * not listed here.
 */
export const ONBOARD_PROVIDERS: Readonly<Record<string, OnboardProviderDef>> = {
  onboard: { kind: "moonshine", model: "moonshine" },
  "onboard-whisper": { kind: "whisper", model: "whisper-base-en" },
  "onboard-parakeet-v2": { kind: "parakeet-v2", model: "parakeet-v2" },
  "onboard-parakeet-110m": { kind: "parakeet-110m", model: "parakeet-110m" },
};

/** The on-device model a provider setting runs, or null for a cloud/box provider. */
export function onboardModelKindForProvider(provider: string): OnboardModelKind | null {
  return Object.prototype.hasOwnProperty.call(ONBOARD_PROVIDERS, provider) ? ONBOARD_PROVIDERS[provider]!.kind : null;
}

/** Settings > Voice > "Unload idle voice model" choices, in minutes ("never" keeps it loaded). */
export type IdleUnloadChoice = "1" | "2" | "5" | "10" | "30" | "never";

export const IDLE_UNLOAD_CHOICES: readonly IdleUnloadChoice[] = ["1", "2", "5", "10", "30", "never"];

export const DEFAULT_IDLE_UNLOAD_CHOICE: IdleUnloadChoice = "5";

/** Minutes for FaceclawVoiceController.setIdleUnloadMinutes(); 0 means never unload. */
export function idleUnloadMinutes(choice: string): number {
  if (choice === "never") return 0;
  const minutes = Number(choice);
  return (IDLE_UNLOAD_CHOICES as readonly string[]).includes(choice) && minutes > 0 ? minutes : Number(DEFAULT_IDLE_UNLOAD_CHOICE);
}

export function formatIdleUnloadChoice(choice: IdleUnloadChoice): string {
  if (choice === "never") return "Never";
  return choice === "1" ? "After 1 minute" : `After ${choice} minutes`;
}
