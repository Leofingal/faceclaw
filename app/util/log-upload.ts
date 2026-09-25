/**
 * The phone's log files, mirrored to the Ghost box: the platform half.
 *
 * All the decisions (what to send, from where, what a reply means) are in
 * `log-upload-core.ts`, which is tested under node. This file only supplies
 * what the core cannot have there: the folder list, byte reads, the state and
 * receipt files, and the POST to cc-web with the Ghost app's host and token.
 *
 * Runs on the shared :01/:31 tick (`aligned-tick.ts`), independent of the
 * ring pull (it keeps running while ring pulls are refused for charging), and
 * once shortly after start. On Wi-Fi and cellular alike: a typical tick is a
 * few kilobytes.
 */
import { Utils } from "@nativescript/core";

import { ghostHostSetting, ghostTokenSetting, logUploadSetting } from "../ui/dashboard-settings";
import { onAlignedTick, startAlignedTick } from "./aligned-tick";
import { fetchWithUserAgent } from "./http";
import {
  CHUNK_BYTES,
  crc32,
  runLogUpload,
  type FileEntry,
  type LogUploadIo,
  type PostResult,
  type UploadReceipt,
  type UploadSource,
} from "./log-upload-core";

declare const java: any;
declare const com: any;

/** A request that has not answered in this long counts as offline. */
const REQUEST_TIMEOUT_MS = 90_000;
/** The start-up run waits this long, so it does not compete with boot. */
const START_DELAY_MS = 20_000;
/** This module's own folder under files/: state.json and the receipt. */
const OWN_DIR = "log-upload";
const RECEIPT_FILE = "upload-receipts.jsonl";
const STATE_FILE = "state.json";

const jsonlOnly = (name: string): boolean => name.endsWith(".jsonl");

function filesDir(): string {
  return String(Utils.android.getApplicationContext().getFilesDir().getAbsolutePath());
}

/**
 * What goes, and where it lands on the box (`~/phone-logs/<prefix>/`).
 *
 * - health: everything the health store, the ring page journal and the
 *   communicator's receipts write (ring-sleep-receipts, ring-pages,
 *   resume-receipts, sleep, samples-*, steps-ledger, rollups, markers).
 * - voice: the capture receipts (FaceclawVoiceCaptureReceipt), the one other
 *   device log the app writes to a file.
 * - translation-log: Download/Faceclaw/translation-log/, and the two fallback
 *   folders FaceclawCaptionLog uses when that one cannot be written.
 * - log-upload: this module's own receipt.
 *
 * The communicator's running log (logLine: BLE, ring, glasses) goes only to
 * logcat, not to a file, so it is not here.
 */
function uploadSources(): UploadSource[] {
  const context = Utils.android.getApplicationContext();
  const files = filesDir();
  const sources: UploadSource[] = [
    { prefix: "health", dir: `${files}/health` },
    { prefix: "voice", dir: `${files}/voice`, include: jsonlOnly },
  ];
  try {
    sources.push({
      prefix: "translation-log",
      dir: String(com.faceclaw.app.FaceclawCaptionLog.publicDir()),
      include: jsonlOnly,
    });
  } catch (error) {
    console.warn(`log upload: no public translation-log dir: ${error}`);
  }
  try {
    const external = context.getExternalFilesDir(null);
    if (external) {
      sources.push({
        prefix: "translation-log-app",
        dir: `${String(external.getAbsolutePath())}/translation-log`,
        include: jsonlOnly,
      });
    }
  } catch (error) {
    console.warn(`log upload: no external files dir: ${error}`);
  }
  sources.push({ prefix: "translation-log-internal", dir: `${files}/translation-log`, include: jsonlOnly });
  sources.push({ prefix: "log-upload", dir: `${files}/${OWN_DIR}`, include: jsonlOnly });
  return sources;
}

// ---------------------------------------------------------------------------
// Byte reads
//
// One direct ByteBuffer, allocated once and reused, with one Uint8Array view
// over it: the same pattern as java-direct-buffer.ts, which exists because
// handing a JS typed array to a Java ByteBuffer parameter leaks a global ref
// per call in NativeScript 9 (see that file). Here the Java side fills a
// Java-owned buffer and JS copies out of the view, so nothing JS-owned ever
// crosses into Java.

let readBuffer: any = null;
let readView: Uint8Array | null = null;

function readRange(path: string, offset: number, length: number): Uint8Array {
  if (length <= 0) return new Uint8Array(0);
  if (length > CHUNK_BYTES * 4) throw new Error(`read of ${length} bytes is over the reader's bound`);
  if (!readBuffer || !readView || readView.length < length) {
    const capacity = Math.max(length, CHUNK_BYTES);
    readBuffer = java.nio.ByteBuffer.allocateDirect(capacity);
    readView = new Uint8Array((ArrayBuffer as any).from(readBuffer));
  }
  const stream = new java.io.FileInputStream(new java.io.File(path));
  try {
    const channel = stream.getChannel();
    readBuffer.clear();
    readBuffer.limit(length);
    let position = offset;
    while (readBuffer.hasRemaining()) {
      const n = Number(channel.read(readBuffer, position));
      if (n <= 0) break;
      position += n;
    }
    const got = Number(readBuffer.position());
    const copy = readView.slice(0, got);
    // Check the copy against Java's own CRC of the same buffer. The view is
    // shared memory (the frame path proves it in the other direction); if it
    // ever were not, this turns silent zeros on the box into a read error in
    // the receipt.
    readBuffer.flip();
    const javaCrc = new java.util.zip.CRC32();
    javaCrc.update(readBuffer);
    const expected = Number(javaCrc.getValue());
    if (crc32(copy) !== expected) throw new Error(`read check failed at ${offset}+${got}`);
    return copy;
  } finally {
    stream.close();
  }
}

function listDir(dir: string): FileEntry[] | null {
  const folder = new java.io.File(dir);
  if (!folder.isDirectory()) return null;
  const children = folder.listFiles();
  if (!children) return null;
  const out: FileEntry[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child.isFile()) continue;
    out.push({ name: String(child.getName()), size: Number(child.length()) });
  }
  return out;
}

function ownPath(name: string): string {
  return `${filesDir()}/${OWN_DIR}/${name}`;
}

function writeUtf8(path: string, text: string, append: boolean): void {
  const file = new java.io.File(path);
  const parent = file.getParentFile();
  if (parent && !parent.isDirectory()) parent.mkdirs();
  const bytes = new java.lang.String(text).getBytes("UTF-8");
  const stream = new java.io.FileOutputStream(file, append);
  try {
    stream.write(bytes);
  } finally {
    stream.close();
  }
}

const nativeIo: LogUploadIo = {
  list: listDir,
  read: readRange,
  loadState(): string | null {
    const file = new java.io.File(ownPath(STATE_FILE));
    if (!file.isFile()) return null;
    const bytes = java.nio.file.Files.readAllBytes(file.toPath());
    return String(new java.lang.String(bytes, "UTF-8"));
  },
  saveState(text: string): void {
    // Write-then-rename, so a kill mid-write leaves the previous offsets
    // rather than half a file (which would read as "no state" and cost a
    // full re-send, not data, but still).
    const tmp = ownPath(`${STATE_FILE}.tmp`);
    writeUtf8(tmp, text, false);
    if (!new java.io.File(tmp).renameTo(new java.io.File(ownPath(STATE_FILE)))) {
      throw new Error("state rename failed");
    }
  },
  receiptSize(): number {
    return Number(new java.io.File(ownPath(RECEIPT_FILE)).length());
  },
  appendReceipt(line: string): void {
    writeUtf8(ownPath(RECEIPT_FILE), `${line}\n`, true);
  },
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// The POST

function authHeaders(): Record<string, string> {
  const token = ghostTokenSetting.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function postToBox(payload: string): Promise<PostResult> {
  const url = `${ghostHostSetting.get()}/api/phone/logs`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<PostResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 0, body: { error: `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` } }), REQUEST_TIMEOUT_MS);
  });
  const request = (async (): Promise<PostResult> => {
    try {
      const response = await fetchWithUserAgent(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...authHeaders() },
        body: payload,
      });
      const text = await response.text().catch(() => "");
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { error: text.slice(0, 160) };
      }
      return { status: response.status, body };
    } catch (error) {
      return { status: 0, body: { error: String((error as Error)?.message ?? error).slice(0, 160) } };
    }
  })();
  try {
    // A request that outlives its timeout is harmless: the box writes only
    // past its own end, so the next run neither loses nor repeats its bytes.
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Scheduling

let running = false;
let lastReceipt: UploadReceipt | null = null;

/** The last run's receipt, for anything that wants to show it. */
export function lastLogUploadReceipt(): UploadReceipt | null {
  return lastReceipt;
}

/** One upload run now, unless one is already running or the switch is off. */
export async function runLogUploadNow(trigger: string): Promise<UploadReceipt | null> {
  if (!logUploadSetting.get()) return null;
  if (running) {
    console.log(`log upload: ${trigger} skipped, a run is in flight`);
    return null;
  }
  running = true;
  try {
    const receipt = await runLogUpload(nativeIo, postToBox, uploadSources(), trigger);
    lastReceipt = receipt;
    console.log(
      `log upload: ${trigger} ${receipt.result} ${receipt.bytes} B in ${receipt.requests} requests, ${receipt.ms} ms` +
        (receipt.detail ? ` (${receipt.detail})` : ""),
    );
    return receipt;
  } catch (error) {
    // runLogUpload does not throw; this is for the sources list itself.
    console.warn(`log upload: ${trigger} failed before it started: ${error}`);
    return null;
  } finally {
    running = false;
  }
}

let started = false;

/** Ride the :01/:31 tick, and run once shortly after start. Idempotent. */
export function startLogUpload(): void {
  if (started) return;
  started = true;
  startAlignedTick();
  onAlignedTick(() => {
    void runLogUploadNow("tick");
  });
  setTimeout(() => {
    void runLogUploadNow("start");
  }, START_DELAY_MS);
}
