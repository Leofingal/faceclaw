import { Utils } from "@nativescript/core";

declare const com: any;
declare const java: any;

import { ASR_MODELS, ASR_MODEL_IDS } from "./asr-model-defs";
import type { AsrModelFile, AsrModelId } from "./asr-model-defs";

export { ASR_MODELS } from "./asr-model-defs";
export type { AsrModelId } from "./asr-model-defs";

/**
 * Download management for the on-device transcription models (sherpa-onnx
 * offline recognizers). Models are fetched on demand into filesDir rather
 * than bundled in the APK; FaceclawVoiceController reads the files from the
 * directory each model's `dirName` names. The registry itself (URLs, pinned
 * hashes, and why each model is there) is in asr-model-defs.ts.
 *
 * Mirrors the on-phone assistant model flow in llama.ts, except each model
 * here is multiple files rather than one; they download sequentially through
 * FaceclawModelDownloader (resume + pinned sha256 per file).
 */

export type AsrModelState = {
  status: "absent" | "downloading" | "ready";
  bytesDownloaded: number;
  totalBytes: number;
};

type ModelRuntime = {
  downloader: any;
  // Bytes of files already fully downloaded in this run, plus progress within
  // the file currently downloading; drives the aggregate percentage.
  completedBytes: number;
  currentFileBytes: number;
  stateListeners: Set<(state: AsrModelState) => void>;
};

function freshRuntime(): ModelRuntime {
  return { downloader: null, completedBytes: 0, currentFileBytes: 0, stateListeners: new Set() };
}

const runtimes = {} as Record<AsrModelId, ModelRuntime>;
for (const id of ASR_MODEL_IDS) {
  runtimes[id] = freshRuntime();
}

function modelDirPath(id: AsrModelId): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/${ASR_MODELS[id].dirName}`;
}

function filePath(id: AsrModelId, file: AsrModelFile): string {
  return `${modelDirPath(id)}/${file.name}`;
}

function isFilePresent(id: AsrModelId, file: AsrModelFile): boolean {
  try {
    const javaFile = new java.io.File(filePath(id, file));
    return javaFile.exists() && javaFile.length() > 0;
  } catch {
    return false;
  }
}

export function isAsrModelReady(id: AsrModelId): boolean {
  if (!global.isAndroid) return false;
  return ASR_MODELS[id].files.every((file) => isFilePresent(id, file));
}

export function asrModelState(id: AsrModelId): AsrModelState {
  const runtime = runtimes[id];
  const totalBytes = ASR_MODELS[id].totalBytes;
  if (runtime.downloader) {
    return {
      status: "downloading",
      bytesDownloaded: runtime.completedBytes + runtime.currentFileBytes,
      totalBytes,
    };
  }
  return {
    status: isAsrModelReady(id) ? "ready" : "absent",
    bytesDownloaded: 0,
    totalBytes,
  };
}

export function onAsrModelStateChanged(id: AsrModelId, listener: (state: AsrModelState) => void): () => void {
  const runtime = runtimes[id];
  runtime.stateListeners.add(listener);
  return () => runtime.stateListeners.delete(listener);
}

function notifyStateChanged(id: AsrModelId): void {
  const state = asrModelState(id);
  runtimes[id].stateListeners.forEach((listener) => listener(state));
}

export function startAsrModelDownload(id: AsrModelId): void {
  const runtime = runtimes[id];
  if (!global.isAndroid || runtime.downloader || isAsrModelReady(id)) return;
  runtime.completedBytes = ASR_MODELS[id].files
    .filter((file) => isFilePresent(id, file))
    .reduce((sum, f) => sum + f.sizeBytes, 0);
  downloadNextFile(id);
  notifyStateChanged(id);
}

function downloadNextFile(id: AsrModelId): void {
  const runtime = runtimes[id];
  const def = ASR_MODELS[id];
  const nextFile = def.files.find((file) => !isFilePresent(id, file));
  if (!nextFile) {
    runtime.downloader = null;
    notifyStateChanged(id);
    return;
  }
  runtime.currentFileBytes = 0;
  const listener = new com.faceclaw.app.FaceclawModelDownloaderListener({
    onProgress: (bytes: number, _total: number) => {
      runtime.currentFileBytes = Number(bytes);
      notifyStateChanged(id);
    },
    onDone: () => {
      runtime.completedBytes += nextFile.sizeBytes;
      runtime.currentFileBytes = 0;
      downloadNextFile(id);
    },
    onError: (message: string) => {
      console.error(`Voice model download failed (${id}/${nextFile.name}): ${message}`);
      runtime.downloader = null;
      notifyStateChanged(id);
    },
  });
  runtime.downloader = new com.faceclaw.app.FaceclawModelDownloader(
    `${def.baseUrl}${nextFile.name}`,
    filePath(id, nextFile),
    nextFile.sha256,
    nextFile.sizeBytes,
    listener,
  );
  runtime.downloader.start();
}

/** Stops the download; already-fetched bytes are kept and resumed next time. */
export function cancelAsrModelDownload(id: AsrModelId): void {
  const runtime = runtimes[id];
  if (!runtime.downloader) return;
  runtime.downloader.cancel();
  runtime.downloader = null;
  notifyStateChanged(id);
}

export function deleteAsrModel(id: AsrModelId): void {
  if (!global.isAndroid) return;
  cancelAsrModelDownload(id);
  try {
    for (const file of ASR_MODELS[id].files) {
      new java.io.File(filePath(id, file)).delete();
      new java.io.File(`${filePath(id, file)}.part`).delete();
    }
    new java.io.File(modelDirPath(id)).delete();
  } catch (error) {
    console.error(`Voice model delete failed (${id}): ${String(error)}`);
  }
  notifyStateChanged(id);
}
