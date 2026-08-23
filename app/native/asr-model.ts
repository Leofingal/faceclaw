import { Utils } from "@nativescript/core";

declare const com: any;
declare const java: any;

/**
 * Download management for the on-device transcription model (Moonshine, via
 * sherpa-onnx). The model is no longer bundled in the APK; it is fetched on
 * demand into the same filesDir location that earlier releases copied the
 * bundled files to, so upgraded installs that already used on-device
 * transcription need no download. FaceclawVoiceController reads the files
 * from this directory.
 *
 * Mirrors the on-phone assistant model flow in llama.ts, except the model is
 * three files rather than one; they download sequentially through
 * FaceclawModelDownloader (resume + pinned sha256 per file).
 */

type AsrModelFile = {
  name: string;
  sha256: string;
  sizeBytes: number;
};

export const ASR_MODEL = {
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
  ] as AsrModelFile[],
  totalBytes: 141300566,
};

export type AsrModelState = {
  status: "absent" | "downloading" | "ready";
  bytesDownloaded: number;
  totalBytes: number;
};

let downloader: any = null;
// Bytes of files already fully downloaded in this run, plus progress within
// the file currently downloading; drives the aggregate percentage.
let completedBytes = 0;
let currentFileBytes = 0;
const stateListeners = new Set<(state: AsrModelState) => void>();

function modelDirPath(): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/${ASR_MODEL.dirName}`;
}

function filePath(file: AsrModelFile): string {
  return `${modelDirPath()}/${file.name}`;
}

function isFilePresent(file: AsrModelFile): boolean {
  try {
    const javaFile = new java.io.File(filePath(file));
    return javaFile.exists() && javaFile.length() > 0;
  } catch {
    return false;
  }
}

export function isAsrModelReady(): boolean {
  if (!global.isAndroid) return false;
  return ASR_MODEL.files.every(isFilePresent);
}

export function asrModelState(): AsrModelState {
  if (downloader) {
    return {
      status: "downloading",
      bytesDownloaded: completedBytes + currentFileBytes,
      totalBytes: ASR_MODEL.totalBytes,
    };
  }
  return {
    status: isAsrModelReady() ? "ready" : "absent",
    bytesDownloaded: 0,
    totalBytes: ASR_MODEL.totalBytes,
  };
}

export function onAsrModelStateChanged(listener: (state: AsrModelState) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function notifyStateChanged(): void {
  const state = asrModelState();
  stateListeners.forEach((listener) => listener(state));
}

export function startAsrModelDownload(): void {
  if (!global.isAndroid || downloader || isAsrModelReady()) return;
  completedBytes = ASR_MODEL.files.filter(isFilePresent).reduce((sum, f) => sum + f.sizeBytes, 0);
  downloadNextFile();
  notifyStateChanged();
}

function downloadNextFile(): void {
  const nextFile = ASR_MODEL.files.find((file) => !isFilePresent(file));
  if (!nextFile) {
    downloader = null;
    notifyStateChanged();
    return;
  }
  currentFileBytes = 0;
  const listener = new com.faceclaw.app.FaceclawModelDownloaderListener({
    onProgress: (bytes: number, _total: number) => {
      currentFileBytes = Number(bytes);
      notifyStateChanged();
    },
    onDone: () => {
      completedBytes += nextFile.sizeBytes;
      currentFileBytes = 0;
      downloadNextFile();
    },
    onError: (message: string) => {
      console.error(`Voice model download failed (${nextFile.name}): ${message}`);
      downloader = null;
      notifyStateChanged();
    },
  });
  downloader = new com.faceclaw.app.FaceclawModelDownloader(
    `${ASR_MODEL.baseUrl}${nextFile.name}`,
    filePath(nextFile),
    nextFile.sha256,
    nextFile.sizeBytes,
    listener,
  );
  downloader.start();
}

/** Stops the download; already-fetched bytes are kept and resumed next time. */
export function cancelAsrModelDownload(): void {
  if (!downloader) return;
  downloader.cancel();
  downloader = null;
  notifyStateChanged();
}

export function deleteAsrModel(): void {
  if (!global.isAndroid) return;
  cancelAsrModelDownload();
  try {
    for (const file of ASR_MODEL.files) {
      new java.io.File(filePath(file)).delete();
      new java.io.File(`${filePath(file)}.part`).delete();
    }
    new java.io.File(modelDirPath()).delete();
  } catch (error) {
    console.error(`Voice model delete failed: ${String(error)}`);
  }
  notifyStateChanged();
}
