// The phone's logs mirrored to the Ghost box (app/util/log-upload-core.ts).
//
// Drives the real upload core against an in-memory phone and a server. The
// server is a model of cc-web's POST /api/phone/logs (the rules are short and
// written out below); set LOG_UPLOAD_SERVER to the path of cc-web's
// src/utils/phone-logs.js and the same tests run against the REAL server code
// instead, which is how the pairing was checked (see the return doc).
//
// Pinned: a file sent in pieces lands byte-identical; three offline ticks and
// then one good one catch up exactly; offsets survive a restart; a lost reply
// never duplicates; a truncated or rewritten file starts over and the box
// keeps the old copy; a half-written last line waits; small JSON goes whole
// and only when it changed; names the box would refuse are never sent.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../.test-build/app/util/log-upload-core.js");
const { runLogUpload, CHUNK_BYTES, MAX_BYTES_PER_RUN, base64Encode, crc32, fingerprint, wholeLinesLength } = core;

// ---------------------------------------------------------------------------
// The server

/** A model of cc-web's utils/phone-logs.js applyUpload, in memory. */
function modelServer() {
  const files = new Map();
  const archive = [];
  return {
    files,
    archive,
    apply(body) {
      const m = /^(health|voice|translation-log|translation-log-app|translation-log-internal|log-upload)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(body.file || "");
      if (!m || body.file.includes("..")) return { status: 400, body: { error: "bad name" } };
      const bytes = Buffer.from(body.data, "base64");
      if (body.crc32 !== undefined && crc32(bytes) !== body.crc32) return { status: 400, body: { error: "crc32 mismatch" } };
      if ((body.mode || "append") === "replace") {
        files.set(body.file, bytes);
        return { status: 200, body: { ok: true, size: bytes.length, wrote: bytes.length } };
      }
      if (body.reset) {
        if (body.offset !== 0) return { status: 400, body: { error: "reset must start at 0" } };
        const had = files.get(body.file);
        if (had && had.length) archive.push({ file: body.file, bytes: had });
        files.delete(body.file);
      }
      const have = files.get(body.file) || Buffer.alloc(0);
      if (body.offset > have.length) return { status: 409, body: { error: "gap", size: have.length } };
      const skip = have.length - body.offset;
      const overlap = Math.min(skip, bytes.length);
      if (overlap > 0 && !have.subarray(body.offset, body.offset + overlap).equals(bytes.subarray(0, overlap))) {
        return { status: 409, body: { error: "mismatch", size: have.length, mismatch: true } };
      }
      const tail = skip >= bytes.length ? Buffer.alloc(0) : bytes.subarray(skip);
      const next = Buffer.concat([have, tail]);
      files.set(body.file, next);
      return { status: 200, body: { ok: true, size: next.length, wrote: tail.length } };
    },
    get(name) {
      return files.get(name);
    },
    archived(name) {
      return archive.filter((a) => a.file === name).map((a) => a.bytes);
    },
  };
}

/** The real cc-web module, over a temp directory, behind the same interface. */
function realServer(modulePath) {
  const { applyUpload } = require(modulePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "log-upload-real-"));
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    apply: (body) => applyUpload(body, { root }),
    get(name) {
      const p = path.join(root, name);
      return fs.existsSync(p) ? fs.readFileSync(p) : undefined;
    },
    archived(name) {
      const [source, base] = name.split("/");
      const dir = path.join(root, ".archive", source);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`))
        .sort()
        .map((f) => fs.readFileSync(path.join(dir, f)));
    },
  };
}

function makeServer() {
  return process.env.LOG_UPLOAD_SERVER ? realServer(process.env.LOG_UPLOAD_SERVER) : modelServer();
}

// ---------------------------------------------------------------------------
// The phone

function makePhone() {
  const dirs = new Map(); // dir -> Map(name -> Buffer)
  const disk = { state: null, receipt: [] };
  const phone = {
    disk,
    dirs,
    put(dir, name, buf) {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir).set(name, Buffer.from(buf));
    },
    append(dir, name, buf) {
      const had = (dirs.get(dir) && dirs.get(dir).get(name)) || Buffer.alloc(0);
      phone.put(dir, name, Buffer.concat([had, Buffer.from(buf)]));
    },
    file(dir, name) {
      return dirs.get(dir).get(name);
    },
    reads: 0,
    /** A fresh io over the same "disk" - what an app restart looks like. */
    io() {
      let clock = 1_000_000;
      return {
        list(dir) {
          const d = dirs.get(dir);
          if (!d) return null;
          return Array.from(d.entries()).map(([name, buf]) => ({ name, size: buf.length }));
        },
        read(p, offset, length) {
          phone.reads++;
          const slash = p.lastIndexOf("/");
          const buf = dirs.get(p.slice(0, slash)).get(p.slice(slash + 1));
          return new Uint8Array(buf.subarray(offset, offset + length));
        },
        loadState: () => disk.state,
        saveState: (text) => {
          disk.state = text;
        },
        receiptSize: () => disk.receipt.reduce((n, l) => n + l.length + 1, 0),
        appendReceipt: (line) => {
          disk.receipt.push(line);
        },
        now: () => (clock += 7),
      };
    },
  };
  return phone;
}

const HEALTH = "/data/files/health";
const TL = "/sdcard/Download/Faceclaw/translation-log";
const SOURCES = [
  { prefix: "health", dir: HEALTH },
  { prefix: "translation-log", dir: TL, include: (n) => n.endsWith(".jsonl") },
];

/** A poster that talks to `server`, with switches for the failure modes. */
function link(server) {
  const l = {
    down: false,
    status404: false,
    loseReplies: false,
    bodies: [],
    async post(payload) {
      const body = JSON.parse(payload);
      l.bodies.push(body);
      if (l.down) return { status: 0, body: { error: "ECONNREFUSED" } };
      if (l.status404) return { status: 404, body: { error: "Cannot POST /api/phone/logs" } };
      const res = server.apply(body);
      if (l.loseReplies) return { status: 0, body: { error: "timeout" } };
      return res;
    },
  };
  return l;
}

function jsonl(n, from = 0, tag = "x") {
  let out = "";
  for (let i = from; i < from + n; i++) {
    out += JSON.stringify({ n: i, t: 1758700000000 + i * 60000, ja: "こんにちは世界", tag, hr: 60 + (i % 40) }) + "\n";
  }
  return Buffer.from(out, "utf8");
}

const run = (phone, l, trigger = "tick") => runLogUpload(phone.io(), l.post, SOURCES, trigger);
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

// ---------------------------------------------------------------------------
// Pure helpers

test("base64 matches node's, including the 1- and 2-byte tails", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 1000, 65537]) {
    const buf = crypto.randomBytes(len);
    assert.equal(base64Encode(new Uint8Array(buf)), buf.toString("base64"), `len ${len}`);
  }
});

test("crc32 is the standard one (zlib, java.util.zip)", () => {
  assert.equal(crc32(new Uint8Array(Buffer.from("123456789"))), 0xcbf43926);
  const zlib = require("node:zlib");
  if (typeof zlib.crc32 === "function") {
    const buf = crypto.randomBytes(50000);
    assert.equal(crc32(new Uint8Array(buf)), zlib.crc32(buf));
  }
});

test("wholeLinesLength cuts after the last newline", () => {
  assert.equal(wholeLinesLength(new Uint8Array(Buffer.from("a\nbc\nde"))), 5);
  assert.equal(wholeLinesLength(new Uint8Array(Buffer.from("abc"))), 0);
  assert.equal(wholeLinesLength(new Uint8Array(Buffer.from("abc\n"))), 4);
});

test("fingerprint changes when one byte does", () => {
  const a = new Uint8Array(Buffer.from("hello world\n"));
  const b = new Uint8Array(Buffer.from("hello world!"));
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), fingerprint(new Uint8Array(a)));
});

// ---------------------------------------------------------------------------
// Runs

test("a 2.4 MB file goes up in CHUNK_BYTES pieces and lands byte-identical", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  const big = jsonl(32000);
  assert.ok(big.length > 2_400_000, `fixture is ${big.length} bytes`);
  phone.put(HEALTH, "samples-2026-09.jsonl", big);
  const r = await run(phone, l, "start");
  assert.equal(r.result, "ok");
  assert.equal(md5(server.get("health/samples-2026-09.jsonl")), md5(big));
  const pieces = l.bodies.filter((b) => b.file === "health/samples-2026-09.jsonl");
  // Whole-line cuts lose under one line per piece, so at most one extra piece.
  const least = Math.ceil(big.length / CHUNK_BYTES);
  assert.ok(pieces.length >= least && pieces.length <= least + 1, `${pieces.length} pieces`);
  assert.ok(pieces.every((b) => Buffer.from(b.data, "base64").length <= CHUNK_BYTES));
  // Every piece ends on a line boundary.
  assert.ok(pieces.every((b) => Buffer.from(b.data, "base64").at(-1) === 0x0a));
});

test("three deltas over three ticks: each sends only what is new, and the copy is byte-identical", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "sleep.jsonl", jsonl(50));
  await run(phone, l);
  for (let k = 1; k <= 3; k++) {
    const delta = jsonl(7 * k, 1000 * k);
    phone.append(HEALTH, "sleep.jsonl", delta);
    l.bodies.length = 0;
    const r = await run(phone, l);
    assert.equal(r.result, "ok");
    assert.equal(r.bytes, delta.length, `tick ${k} sent ${r.bytes}, delta was ${delta.length}`);
    assert.equal(l.bodies.length, 1);
    assert.ok(server.get("health/sleep.jsonl").equals(phone.file(HEALTH, "sleep.jsonl")));
  }
  // A tick with nothing new sends nothing.
  l.bodies.length = 0;
  const idle = await run(phone, l);
  assert.equal(l.bodies.length, 0);
  assert.equal(idle.bytes, 0);
});

test("unreachable for 3 ticks, then back: offsets hold, and the next tick catches up exactly", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "ring-sleep-receipts.jsonl", jsonl(30));
  phone.put(TL, "translation-log-2026-09-26.jsonl", jsonl(5, 0, "tl"));
  await run(phone, l);
  const stateBefore = phone.disk.state;

  l.down = true;
  for (let k = 0; k < 3; k++) {
    phone.append(HEALTH, "ring-sleep-receipts.jsonl", jsonl(4, 100 + k * 10));
    phone.append(TL, "translation-log-2026-09-26.jsonl", jsonl(3, 100 + k * 10, "tl"));
    const r = await run(phone, l);
    assert.equal(r.result, "offline");
    assert.equal(r.bytes, 0);
    assert.equal(phone.disk.state, stateBefore, "an offline tick must not move any offset");
  }
  l.down = false;
  const back = await run(phone, l);
  assert.equal(back.result, "ok");
  assert.ok(server.get("health/ring-sleep-receipts.jsonl").equals(phone.file(HEALTH, "ring-sleep-receipts.jsonl")));
  assert.ok(server.get("translation-log/translation-log-2026-09-26.jsonl").equals(phone.file(TL, "translation-log-2026-09-26.jsonl")));

  // One receipt line per attempt, and the three failures say so.
  const results = phone.disk.receipt.map((line) => JSON.parse(line).result);
  assert.deepEqual(results, ["ok", "offline", "offline", "offline", "ok"]);
});

test("a cc-web without the endpoint (404) keeps the offsets, and a later one catches up", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "resume-receipts.jsonl", jsonl(10));
  l.status404 = true;
  const r = await run(phone, l);
  assert.equal(r.result, "http-404");
  assert.equal(server.get("health/resume-receipts.jsonl"), undefined);
  l.status404 = false;
  await run(phone, l);
  assert.ok(server.get("health/resume-receipts.jsonl").equals(phone.file(HEALTH, "resume-receipts.jsonl")));
});

test("offsets survive a restart: a new process sends only the new bytes", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "samples-2026-09.jsonl", jsonl(3000));
  await run(phone, l);
  // "Restart": everything in memory is gone; only the state text on disk remains.
  const persisted = phone.disk.state;
  assert.ok(persisted && JSON.parse(persisted).files["health/samples-2026-09.jsonl"].off > 0);
  const delta = jsonl(12, 5000);
  phone.append(HEALTH, "samples-2026-09.jsonl", delta);
  l.bodies.length = 0;
  const r = await runLogUpload(phone.io(), l.post, SOURCES, "start");
  assert.equal(r.bytes, delta.length);
  assert.equal(l.bodies.length, 1);
  assert.equal(l.bodies[0].offset, phone.file(HEALTH, "samples-2026-09.jsonl").length - delta.length);
  assert.ok(server.get("health/samples-2026-09.jsonl").equals(phone.file(HEALTH, "samples-2026-09.jsonl")));
});

test("a lost reply (the box wrote it, the phone never heard) does not duplicate lines", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "ring-pages.jsonl", jsonl(20));
  await run(phone, l);
  phone.append(HEALTH, "ring-pages.jsonl", jsonl(5, 50));
  l.loseReplies = true;
  const lost = await run(phone, l);
  assert.equal(lost.result, "offline");
  l.loseReplies = false;
  const again = await run(phone, l);
  assert.equal(again.result, "ok");
  assert.equal(again.bytes, 0, "the resend wrote nothing new");
  assert.ok(server.get("health/ring-pages.jsonl").equals(phone.file(HEALTH, "ring-pages.jsonl")));
});

test("a truncated file starts over; the box's old copy is archived, not lost", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  const old = jsonl(40);
  phone.put(HEALTH, "voice-ish.jsonl", old);
  await run(phone, l);
  const shorter = jsonl(3, 900);
  phone.put(HEALTH, "voice-ish.jsonl", shorter);
  const r = await run(phone, l);
  assert.equal(r.result, "ok");
  assert.match(r.files.find((f) => f.f === "health/voice-ish.jsonl").reset, /shrank/);
  assert.ok(server.get("health/voice-ish.jsonl").equals(shorter));
  assert.ok(server.archived("health/voice-ish.jsonl").some((b) => b.equals(old)));
});

test("a rewrite that grew past the old offset (journal compaction) is caught by the head check", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "ring-pages.jsonl", jsonl(100));
  await run(phone, l);
  const before = phone.file(HEALTH, "ring-pages.jsonl");
  // Compaction drops the first 60 lines, then enough new pages arrive that
  // the file is LONGER than the old offset: size alone cannot see it.
  const compacted = Buffer.concat([jsonl(40, 60), jsonl(90, 1000)]);
  assert.ok(compacted.length > before.length);
  phone.put(HEALTH, "ring-pages.jsonl", compacted);
  const r = await run(phone, l);
  assert.equal(r.files.find((f) => f.f === "health/ring-pages.jsonl").reset, "head changed");
  assert.ok(server.get("health/ring-pages.jsonl").equals(compacted));
  assert.ok(server.archived("health/ring-pages.jsonl").some((b) => b.equals(before)));
});

test("a reset that cannot be sent yet is still sent as one later", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  const old = jsonl(10);
  phone.put(HEALTH, "sleep.jsonl", old);
  await run(phone, l);
  // The file is emptied (a purge) and the box is unreachable when it is noticed.
  phone.put(HEALTH, "sleep.jsonl", Buffer.alloc(0));
  l.down = true;
  await run(phone, l);
  l.down = false;
  await run(phone, l); // nothing to send yet: the file is empty
  phone.put(HEALTH, "sleep.jsonl", jsonl(2, 500, "new"));
  await run(phone, l);
  assert.ok(server.get("health/sleep.jsonl").equals(phone.file(HEALTH, "sleep.jsonl")));
  assert.ok(server.archived("health/sleep.jsonl").some((b) => b.equals(old)));
});

test("lost state, different file on the box: the box refuses the overlap and the phone starts over", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "sleep.jsonl", jsonl(10, 0, "before-wipe"));
  await run(phone, l);
  // App data wiped: new file, no state.
  phone.disk.state = null;
  phone.put(HEALTH, "sleep.jsonl", jsonl(30, 0, "after-wipe"));
  const r = await run(phone, l);
  assert.equal(r.result, "ok");
  assert.match(r.files.find((f) => f.f === "health/sleep.jsonl").reset, /box copy differs/);
  assert.ok(server.get("health/sleep.jsonl").equals(phone.file(HEALTH, "sleep.jsonl")));
});

test("a half-written last line waits for its newline", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "sleep.jsonl", Buffer.concat([jsonl(3), Buffer.from('{"n":99,"partial')]));
  await run(phone, l);
  assert.ok(server.get("health/sleep.jsonl").equals(jsonl(3)));
  phone.append(HEALTH, "sleep.jsonl", Buffer.from('":true}\n'));
  await run(phone, l);
  assert.ok(server.get("health/sleep.jsonl").equals(phone.file(HEALTH, "sleep.jsonl")));
});

test("small JSON goes whole, and only when it changed", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "rollups.json", Buffer.from('{"days":[1,2,3],"long":"' + "y".repeat(500) + '"}'));
  phone.put(HEALTH, "steps-ledger.json", Buffer.from('{"steps":1}'));
  await run(phone, l);
  assert.equal(server.get("health/rollups.json").toString(), phone.file(HEALTH, "rollups.json").toString());
  l.bodies.length = 0;
  await run(phone, l);
  assert.equal(l.bodies.length, 0, "unchanged files are not re-sent");
  phone.put(HEALTH, "rollups.json", Buffer.from('{"days":[1]}'));
  await run(phone, l);
  assert.equal(l.bodies.length, 1);
  assert.equal(server.get("health/rollups.json").toString(), '{"days":[1]}');
});

test("names the box would refuse, temp files and non-jsonl translation files are never sent", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "ring-pages.jsonl.tmp", jsonl(2));
  phone.put(HEALTH, ".hidden.jsonl", jsonl(2));
  phone.put(HEALTH, "has space.jsonl", jsonl(2));
  phone.put(TL, "notes.txt", Buffer.from("x"));
  phone.put(TL, "translation-log-2026-09-27.jsonl", jsonl(1));
  const r = await run(phone, l);
  assert.deepEqual(
    l.bodies.map((b) => b.file),
    ["translation-log/translation-log-2026-09-27.jsonl"],
  );
  assert.equal(r.skippedNames, 2);
});

test("a run stops at its byte budget and the next tick carries on", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  const unit = jsonl(1000);
  const huge = Buffer.concat(new Array(Math.ceil((MAX_BYTES_PER_RUN * 1.3) / unit.length)).fill(unit));
  assert.ok(huge.length > MAX_BYTES_PER_RUN);
  phone.put(HEALTH, "samples-2026-08.jsonl", huge);
  const first = await run(phone, l);
  assert.equal(first.result, "budget");
  assert.ok(first.bytes <= MAX_BYTES_PER_RUN);
  const second = await run(phone, l);
  assert.equal(second.result, "ok");
  assert.equal(first.bytes + second.bytes, huge.length);
  assert.equal(md5(server.get("health/samples-2026-08.jsonl")), md5(huge));
});

test("a read that throws costs that file this tick, not the run", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "a.jsonl", jsonl(2));
  phone.put(HEALTH, "b.jsonl", jsonl(2));
  const io = phone.io();
  const realRead = io.read;
  io.read = (p, o, n) => {
    if (p.endsWith("/a.jsonl")) throw new Error("read check failed at 0+217");
    return realRead(p, o, n);
  };
  const r = await runLogUpload(io, l.post, SOURCES, "tick");
  assert.equal(r.result, "ok");
  assert.match(r.files.find((f) => f.f === "health/a.jsonl").error, /read check failed/);
  assert.ok(server.get("health/b.jsonl").equals(phone.file(HEALTH, "b.jsonl")));
});

test("every request carries a crc32 the box can check", async () => {
  const phone = makePhone();
  const server = makeServer();
  const l = link(server);
  phone.put(HEALTH, "sleep.jsonl", jsonl(5));
  phone.put(HEALTH, "rollups.json", Buffer.from("{}"));
  await run(phone, l);
  for (const b of l.bodies) assert.equal(b.crc32, crc32(new Uint8Array(Buffer.from(b.data, "base64"))));
});

test("a rewrite landing mid-run, at any read, never leaves the box copy wrong", async () => {
  // The journal's compaction is a rename, and it can land between any two of
  // the run's reads: before the chunk read, between the chunk and the head
  // re-check, or during the POST. Whichever, within two more ticks the box
  // copy is the compacted file byte for byte and the old one is archived.
  const A = Buffer.concat([jsonl(100, 0, "page"), jsonl(10, 500, "page")]);
  const C = Buffer.concat([jsonl(60, 40, "page"), jsonl(200, 2000, "page")]);
  assert.ok(C.length > A.length);
  for (let when = 1; when <= 6; when++) {
    const phone = makePhone();
    const server = makeServer();
    const l = link(server);
    phone.put(HEALTH, "ring-pages.jsonl", A.subarray(0, A.length - jsonl(10, 500, "page").length));
    await run(phone, l);
    phone.put(HEALTH, "ring-pages.jsonl", A);
    const io = phone.io();
    const realRead = io.read;
    let calls = 0;
    io.read = (p, o, n) => {
      if (++calls === when) phone.put(HEALTH, "ring-pages.jsonl", C);
      return realRead(p, o, n);
    };
    await runLogUpload(io, l.post, SOURCES, "tick");
    phone.put(HEALTH, "ring-pages.jsonl", C); // in case the rewrite point was never reached
    await run(phone, l);
    await run(phone, l);
    assert.ok(server.get("health/ring-pages.jsonl").equals(C), `rewrite at read ${when}: box copy is not the compacted file`);
  }
});
