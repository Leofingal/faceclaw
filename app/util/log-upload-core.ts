/**
 * The phone's log files, mirrored to the Ghost box: the pure half.
 *
 * Chris, 2026-09-24: *"can you have the Exocortex put the bluetooth log
 * file(s) and the health log files on ghostbox through tailscale?"* Until
 * this, the only way to read them was adb over the desktop's USB cable, and
 * the phone is not on that cable at work or abroad.
 *
 * ## What it does
 *
 * On each :01/:31 tick (and once at start) it walks a few folders, and for
 * each file sends the box whatever the box does not have yet, through cc-web's
 * `POST /api/phone/logs` with the Ghost token. The box keeps the copies in
 * `~/phone-logs/<source>/<name>`.
 *
 * - **`.jsonl` files are append-only**, so only the bytes after the last
 *   acknowledged offset go, and only whole lines (up to the last newline), so
 *   the box's copy always ends on a line boundary. The first upload of a big
 *   file goes in `CHUNK_BYTES` pieces.
 * - **A file that shrank or was rewritten starts over.** Shrinking is visible
 *   in the size. Rewriting is not always: the ring page journal compacts
 *   itself past 128 KB (RingPageJournal.compact), dropping its oldest lines,
 *   and could in principle grow past the old offset again before the next
 *   tick. So each file's first `HEAD_BYTES` are fingerprinted at every ack
 *   and re-checked before the next delta; a different head means a rewrite.
 *   A start-over is sent with `reset`, and the box ARCHIVES its old copy
 *   rather than deleting it, so a compaction here never erases history there.
 * - **Anything else is small state** (`rollups.json`, `steps-ledger.json`),
 *   rewritten in place by the app, so it goes whole when its fingerprint
 *   changes.
 *
 * ## Offline
 *
 * Offsets live on the phone (`state.json`) and move only when the box says
 * how long its copy now is. A network error, a timeout, a 401, a 404 from a
 * cc-web without the endpoint, or a 5xx ends the run with nothing changed;
 * the next tick starts from the same offsets and catches up. Every retry is
 * safe because the box writes only bytes past its own end: a resend of a
 * delta it already has writes nothing (the reply was lost, not the data), and
 * a delta starting past its end gets a 409 with its real size, which this
 * rewinds to.
 *
 * Nothing on the phone is ever changed or deleted by this, apart from its own
 * state file and receipt.
 *
 * ## Receipt
 *
 * One JSONL line per attempt (`RECEIPT` below): trigger, result, per-file
 * bytes, and errors. The receipt itself is one of the uploaded files, so a
 * failure shows up on the box at the next good tick.
 *
 * Pure: no NativeScript, no timers, no fetch. The platform half
 * (`log-upload.ts`) supplies the file reads and the POST, and
 * `tests/log-upload.test.cjs` drives this against an in-memory phone and a
 * model of the server.
 */

/** Largest delta sent in one request. Base64 makes the request ~4/3 of this. */
export const CHUNK_BYTES = 256 * 1024;
/** Stop a run after this many bytes; the next tick carries on. */
export const MAX_BYTES_PER_RUN = 16 * 1024 * 1024;
/** How much of each append-only file is fingerprinted to catch a rewrite. */
export const HEAD_BYTES = 4096;
/** Non-JSONL files bigger than this are not mirrored (they are not logs). */
export const REPLACE_MAX_BYTES = 1024 * 1024;
/** The receipt stops growing here, like the app's other receipts. */
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

/** A file name the box will accept: one plain name, no leading dot. */
export const UPLOAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type FileEntry = { name: string; size: number };

/** One folder on the phone and the folder name it lands under on the box. */
export type UploadSource = {
  /** The box's folder: `health`, `voice`, `translation-log`, ... */
  prefix: string;
  /** Absolute folder on the phone. */
  dir: string;
  /** Which files in it to send; default everything with an acceptable name. */
  include?: (name: string) => boolean;
};

/** What the platform supplies. Each call may throw; the run survives it. */
export interface LogUploadIo {
  /** Regular files directly in `dir`, or null when it is missing or unreadable. */
  list(dir: string): FileEntry[] | null;
  /** Bytes `[offset, offset + length)` of the file; fewer at end of file. */
  read(path: string, offset: number, length: number): Uint8Array;
  loadState(): string | null;
  saveState(text: string): void;
  /** Size of the receipt file, for its cap. */
  receiptSize(): number;
  appendReceipt(line: string): void;
  now(): number;
}

/** status 0 = never reached the box (network error or timeout). */
export type PostResult = { status: number; body: any };
export type Poster = (payload: string) => Promise<PostResult>;

type AppendState = { mode: "append"; off: number; headLen: number; head: string; reset?: boolean };
type ReplaceState = { mode: "replace"; size: number; hash: string };
type FileState = AppendState | ReplaceState;
export type UploadState = { v: 1; files: Record<string, FileState> };

export type FileOutcome = {
  f: string;
  /** Bytes the box wrote for this file this run. */
  sent: number;
  /** The acknowledged offset (append) or size (replace) after the run. */
  off: number;
  reset?: string;
  error?: string;
};

export type UploadReceipt = {
  atMs: number;
  trigger: string;
  /** "ok" | "offline" | "unauthorized" | "http-<status>" | "budget" | "error" */
  result: string;
  detail?: string;
  bytes: number;
  requests: number;
  files: FileOutcome[];
  skippedNames?: number;
  ms: number;
};

// ---------------------------------------------------------------------------
// Bytes

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chunk += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    chunk += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    chunk += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

/**
 * A 64-bit fingerprint as 16 hex digits: two independent 32-bit FNV-1a
 * passes (different offset bases). Not cryptographic; it only has to notice
 * that a file's first bytes changed.
 */
export function fingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i]!;
    a = Math.imul(a ^ x, 0x01000193) >>> 0;
    b = Math.imul(b ^ x ^ 0x5a, 0x01000193) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

let crcTable: Uint32Array | null = null;

/**
 * CRC-32 (IEEE, the zlib/java.util.zip one) as an unsigned number. Sent with
 * every delta so the box can check what it decoded, and used by the platform
 * reader to check its copy out of the Java buffer against Java's own CRC.
 */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Length of `bytes` up to and including its last newline; 0 when it has none. */
export function wholeLinesLength(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) return i + 1;
  }
  return 0;
}

export function isAppendOnly(name: string): boolean {
  return name.endsWith(".jsonl");
}

/** Files the app writes as a temporary step before a rename; never sent. */
function isScratch(name: string): boolean {
  return name.endsWith(".tmp") || name.endsWith(".upload-tmp");
}

// ---------------------------------------------------------------------------
// State

export function parseState(text: string | null): UploadState {
  if (!text) return { v: 1, files: {} };
  try {
    const parsed = JSON.parse(text) as UploadState;
    if (parsed && parsed.v === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // A corrupt state file costs a re-send, not data: the box writes only
    // past its end, so re-sending from 0 duplicates nothing.
  }
  return { v: 1, files: {} };
}

// ---------------------------------------------------------------------------
// The run

class RunAbort {
  constructor(
    readonly result: string,
    readonly detail: string,
  ) {}
}

type RunContext = {
  io: LogUploadIo;
  post: Poster;
  state: UploadState;
  receipt: UploadReceipt;
};

function classifyFailure(res: PostResult): RunAbort {
  if (res.status === 0) return new RunAbort("offline", String(res.body?.error ?? "no response"));
  if (res.status === 401) return new RunAbort("unauthorized", "401");
  return new RunAbort(`http-${res.status}`, String(res.body?.error ?? "").slice(0, 160));
}

/** Per-file refusals: the next file may still go. Everything else ends the run. */
function isPerFileRefusal(status: number): boolean {
  return status === 400 || status === 413;
}

async function send(ctx: RunContext, body: Record<string, unknown>, rawBytes: number): Promise<PostResult> {
  if (ctx.receipt.bytes + rawBytes > MAX_BYTES_PER_RUN && ctx.receipt.bytes > 0) {
    throw new RunAbort("budget", `stopped at ${ctx.receipt.bytes} bytes; the next tick carries on`);
  }
  ctx.receipt.requests++;
  return ctx.post(JSON.stringify(body));
}

function saveState(ctx: RunContext): void {
  ctx.io.saveState(JSON.stringify(ctx.state));
}

function headOf(io: LogUploadIo, path: string, off: number): { headLen: number; head: string } {
  const headLen = Math.min(off, HEAD_BYTES);
  return { headLen, head: fingerprint(io.read(path, 0, headLen)) };
}

/**
 * The file's first min(offset + chunk, HEAD_BYTES) bytes as they will stand
 * once `chunk` (read at `offset`) is on the box: the part before the chunk
 * read from the file, the rest taken from the chunk itself.
 */
function headAfter(io: LogUploadIo, path: string, offset: number, chunk: Uint8Array): { bytes: Uint8Array } {
  const len = Math.min(offset + chunk.length, HEAD_BYTES);
  if (len <= offset) return { bytes: io.read(path, 0, len) };
  const before = offset > 0 ? io.read(path, 0, offset) : new Uint8Array(0);
  const out = new Uint8Array(before.length + (len - offset));
  out.set(before, 0);
  out.set(chunk.subarray(0, len - offset), before.length);
  return { bytes: out };
}

function freshAppendState(): AppendState {
  // `reset` stays set until the box has acknowledged a delta that carried it,
  // so a start-over that could not be sent yet (offline, or the file is empty
  // or mid-line right now) is still sent as one later, and the box still
  // archives its old copy instead of treating it as this file's beginning.
  return { mode: "append", off: 0, headLen: 0, head: "", reset: true };
}

async function syncAppendFile(ctx: RunContext, key: string, path: string, size: number, out: FileOutcome): Promise<void> {
  const prior = ctx.state.files[key];
  let st: AppendState = prior && prior.mode === "append" ? { ...prior } : { mode: "append", off: 0, headLen: 0, head: "" };

  const restart = (why: string): void => {
    out.reset = out.reset ? `${out.reset}; ${why}` : why;
    st = freshAppendState();
    ctx.state.files[key] = st;
    saveState(ctx);
  };

  if (st.off > size) {
    restart(`shrank ${st.off} -> ${size}`);
  } else if (st.off > 0 && st.headLen > 0) {
    const head = ctx.io.read(path, 0, st.headLen);
    if (head.length < st.headLen || fingerprint(head) !== st.head) restart("head changed");
  }

  let rewound = false;
  let mismatched = false;
  let rewritten = 0;
  while (st.off < size) {
    const want = Math.min(CHUNK_BYTES, size - st.off);
    let bytes = ctx.io.read(path, st.off, want);
    if (bytes.length === 0) break;
    const whole = wholeLinesLength(bytes);
    if (whole > 0) {
      bytes = bytes.subarray(0, whole);
    } else if (st.off + bytes.length >= size) {
      // The file ends mid-line: a write in flight. It goes next tick, whole.
      break;
    }
    // (A chunk with no newline that is not at the end is one line longer than
    // CHUNK_BYTES; it goes as it is rather than never.)

    // Re-check the head AFTER reading the chunk. A rewrite (the journal's
    // compaction is a rename) between the check above and this read would
    // otherwise put the new file's bytes at the old file's offset. Checked
    // after, a rewrite before the read shows here, and one after it means the
    // chunk is still the old file's, which is right. The head this chunk
    // leaves behind is taken from the same bytes, never re-read after the
    // reply, for the same reason.
    const next = headAfter(ctx.io, path, st.off, bytes);
    if (st.headLen > 0 && (next.bytes.length < st.headLen || fingerprint(next.bytes.subarray(0, st.headLen)) !== st.head)) {
      if (++rewritten > 2) {
        out.error = "file keeps being rewritten; next tick";
        break;
      }
      restart("head changed");
      continue;
    }

    const res = await send(
      ctx,
      {
        file: key,
        mode: "append",
        offset: st.off,
        ...(st.reset ? { reset: true } : {}),
        crc32: crc32(bytes),
        data: base64Encode(bytes),
      },
      bytes.length,
    );
    if (res.status === 200 && typeof res.body?.size === "number") {
      const wrote = typeof res.body.wrote === "number" ? res.body.wrote : 0;
      // The box can be ahead of this file only if the file shrank since it was
      // sent; the next run then sees off > size and starts over.
      st =
        res.body.size === st.off + bytes.length
          ? { mode: "append", off: res.body.size, headLen: next.bytes.length, head: fingerprint(next.bytes) }
          : { mode: "append", off: res.body.size, ...headOf(ctx.io, path, Math.min(res.body.size, size)) };
      ctx.state.files[key] = st;
      saveState(ctx);
      out.sent += wrote;
      ctx.receipt.bytes += wrote;
      continue;
    }
    if (res.status === 409 && res.body?.mismatch === true && !mismatched) {
      // The box holds different bytes at this offset: its copy is of some
      // other file of this name (app data wiped, state lost). Start over; the
      // box archives what it had.
      mismatched = true;
      restart("box copy differs");
      continue;
    }
    if (res.status === 409 && typeof res.body?.size === "number" && res.body.size < st.off && !rewound) {
      // The box's copy is shorter than what it once acknowledged (it lost
      // bytes, or the copy was moved). Rewind to its end and carry on.
      out.reset = `box behind ${st.off} -> ${res.body.size}`;
      rewound = true;
      st = { mode: "append", off: res.body.size, ...headOf(ctx.io, path, res.body.size) };
      ctx.state.files[key] = st;
      saveState(ctx);
      continue;
    }
    if (isPerFileRefusal(res.status) || res.status === 409) {
      out.error = `${res.status} ${String(res.body?.error ?? "").slice(0, 120)}`;
      break;
    }
    throw classifyFailure(res);
  }
  out.off = st.off;
}

async function syncReplaceFile(ctx: RunContext, key: string, path: string, size: number, out: FileOutcome): Promise<void> {
  const prior = ctx.state.files[key];
  out.off = prior && prior.mode === "replace" ? prior.size : 0;
  if (size > REPLACE_MAX_BYTES) {
    out.error = `not a log and over ${REPLACE_MAX_BYTES} bytes; not sent`;
    return;
  }
  const bytes = ctx.io.read(path, 0, size);
  const hash = fingerprint(bytes);
  if (prior && prior.mode === "replace" && prior.hash === hash && prior.size === bytes.length) return;

  const res = await send(
    ctx,
    { file: key, mode: "replace", crc32: crc32(bytes), data: base64Encode(bytes) },
    bytes.length,
  );
  if (res.status === 200) {
    ctx.state.files[key] = { mode: "replace", size: bytes.length, hash };
    saveState(ctx);
    out.sent = bytes.length;
    out.off = bytes.length;
    ctx.receipt.bytes += bytes.length;
    return;
  }
  if (isPerFileRefusal(res.status)) {
    out.error = `${res.status} ${String(res.body?.error ?? "").slice(0, 120)}`;
    return;
  }
  throw classifyFailure(res);
}

/**
 * One upload run over every source. Never throws: every outcome, including a
 * crash in a file read, ends up in the returned receipt, which is also
 * appended to the receipt file.
 */
export async function runLogUpload(
  io: LogUploadIo,
  post: Poster,
  sources: UploadSource[],
  trigger: string,
): Promise<UploadReceipt> {
  const startedMs = io.now();
  const receipt: UploadReceipt = { atMs: startedMs, trigger, result: "ok", bytes: 0, requests: 0, files: [], ms: 0 };
  let skippedNames = 0;
  try {
    const ctx: RunContext = { io, post, state: parseState(io.loadState()), receipt };
    for (const source of sources) {
      let entries: FileEntry[] | null = null;
      try {
        entries = io.list(source.dir);
      } catch (error) {
        receipt.files.push({ f: `${source.prefix}/`, sent: 0, off: 0, error: `list: ${String(error).slice(0, 120)}` });
      }
      if (!entries) continue;
      const names = entries.slice().sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      for (const entry of names) {
        if (isScratch(entry.name)) continue;
        if (source.include && !source.include(entry.name)) continue;
        if (!UPLOAD_NAME_PATTERN.test(entry.name)) {
          skippedNames++;
          continue;
        }
        const key = `${source.prefix}/${entry.name}`;
        const path = `${source.dir}/${entry.name}`;
        const out: FileOutcome = { f: key, sent: 0, off: 0 };
        try {
          if (isAppendOnly(entry.name)) await syncAppendFile(ctx, key, path, entry.size, out);
          else await syncReplaceFile(ctx, key, path, entry.size, out);
        } catch (error) {
          if (error instanceof RunAbort) {
            if (out.sent || out.reset || out.error) receipt.files.push(out);
            throw error;
          }
          out.error = `read: ${String(error).slice(0, 120)}`;
        }
        if (out.sent || out.reset || out.error) receipt.files.push(out);
      }
    }
  } catch (error) {
    if (error instanceof RunAbort) {
      receipt.result = error.result;
      if (error.detail) receipt.detail = error.detail;
    } else {
      receipt.result = "error";
      receipt.detail = String(error).slice(0, 200);
    }
  }
  if (skippedNames) receipt.skippedNames = skippedNames;
  receipt.ms = io.now() - startedMs;
  try {
    if (io.receiptSize() <= RECEIPT_MAX_BYTES) io.appendReceipt(JSON.stringify(receipt));
  } catch (error) {
    console.warn(`log upload: receipt write failed: ${error}`);
  }
  return receipt;
}
