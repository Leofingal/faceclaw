#!/usr/bin/env node
// End to end: the phone's upload core against the REAL cc-web server, over HTTP.
//
//   node notes/log-upload-e2e/run.cjs <cc-web dir> [compiled core js]
//
// <cc-web dir> is apps/claude-code-web from the TLC repo (with its
// node_modules reachable, e.g. NODE_PATH). The core defaults to
// .test-build/app/util/log-upload-core.js, which `npm test` builds.
//
// The phone side is real files in a temp dir read through node's fs at byte
// offsets, the same three operations util/log-upload.ts does with Java
// (list, positional read, state/receipt files). The server is cc-web's own
// ClaudeCodeWebServer with --auth, on a random port, with HOME pointed at a
// temp dir so nothing touches the real ~/phone-logs. Every comparison is md5
// of the phone file against the box file.
//
// Prints one line per check and exits non-zero on the first failure.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ccweb = path.resolve(process.argv[2] || "");
const corePath = path.resolve(process.argv[3] || path.join(__dirname, "../../.test-build/app/util/log-upload-core.js"));
if (!fs.existsSync(path.join(ccweb, "src/server.js"))) {
  console.error("usage: run.cjs <cc-web dir> [core js]");
  process.exit(2);
}
const core = require(corePath);

const TOKEN = "e2e-token";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "log-upload-e2e-"));
const home = path.join(tmp, "home");
const phoneRoot = path.join(tmp, "phone");
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
delete process.env.PHONE_LOGS_DIR;
assert.equal(os.homedir(), home, "HOME redirect did not take");
const box = path.join(home, "phone-logs");

const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
let checks = 0;
function check(label, fn) {
  fn();
  checks++;
  console.log(`PASS ${label}`);
}

// ---------------------------------------------------------------------------
// Phone side

const dirs = {
  health: path.join(phoneRoot, "files/health"),
  voice: path.join(phoneRoot, "files/voice"),
  tl: path.join(phoneRoot, "sdcard/Download/Faceclaw/translation-log"),
  own: path.join(phoneRoot, "files/log-upload"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const jsonlOnly = (n) => n.endsWith(".jsonl");
const SOURCES = [
  { prefix: "health", dir: dirs.health },
  { prefix: "voice", dir: dirs.voice, include: jsonlOnly },
  { prefix: "translation-log", dir: dirs.tl, include: jsonlOnly },
  { prefix: "log-upload", dir: dirs.own, include: jsonlOnly },
];

/** A fresh io each call: what an app restart looks like (only files persist). */
function nodeIo() {
  const statePath = path.join(dirs.own, "state.json");
  const receiptPath = path.join(dirs.own, "upload-receipts.jsonl");
  return {
    list(dir) {
      if (!fs.existsSync(dir)) return null;
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, size: fs.statSync(path.join(dir, e.name)).size }));
    },
    read(p, offset, length) {
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(length);
        const n = fs.readSync(fd, buf, 0, length, offset);
        return new Uint8Array(buf.subarray(0, n));
      } finally {
        fs.closeSync(fd);
      }
    },
    loadState: () => (fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null),
    saveState: (text) => {
      fs.writeFileSync(`${statePath}.tmp`, text);
      fs.renameSync(`${statePath}.tmp`, statePath);
    },
    receiptSize: () => (fs.existsSync(receiptPath) ? fs.statSync(receiptPath).size : 0),
    appendReceipt: (line) => fs.appendFileSync(receiptPath, `${line}\n`),
    now: () => Date.now(),
  };
}

function jsonl(n, from = 0, tag = "x") {
  let out = "";
  for (let i = from; i < from + n; i++) {
    out += JSON.stringify({ n: i, t: 1758700000000 + i * 60000, ja: "今日は良い天気ですね", tag, hr: 60 + (i % 40) }) + "\n";
  }
  return Buffer.from(out, "utf8");
}

// ---------------------------------------------------------------------------
// The box

let port = 0;
let token = TOKEN;
let listener = null;
let app = null;

async function boxUp() {
  if (!app) {
    const { ClaudeCodeWebServer } = require(path.join(ccweb, "src/server.js"));
    const server = new ClaudeCodeWebServer({ auth: TOKEN });
    clearInterval(server.autoSaveInterval);
    app = server.app;
  }
  listener = http.createServer(app);
  await new Promise((r) => listener.listen(port, "127.0.0.1", r));
  port = listener.address().port;
}
async function boxDown() {
  await new Promise((r) => listener.close(r));
  listener = null;
}

let requests = 0;
let wireBytes = 0;
/**
 * One POST, a fresh connection each time (agent: false). With a pooled
 * keep-alive socket, closing the box between ticks makes the next request
 * die on a socket the old server closed, which reads as "offline" for a
 * reason that has nothing to do with the phone.
 */
function post(payload) {
  requests++;
  wireBytes += Buffer.byteLength(payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/phone/logs",
        method: "POST",
        agent: false,
        timeout: 20000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = { error: text.slice(0, 160) };
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, body: { error: String(error.message || error) } }));
    req.end(payload);
  });
}

const run = (trigger = "tick") => core.runLogUpload(nodeIo(), post, SOURCES, trigger);
const phoneFile = (d, n) => fs.readFileSync(path.join(d, n));
const boxFile = (n) => fs.readFileSync(path.join(box, n));
const same = (d, name, boxName) => md5(phoneFile(d, name)) === md5(boxFile(boxName));

// ---------------------------------------------------------------------------

(async () => {
  await boxUp();

  // 1. First contact: a phone with a month of data.
  fs.writeFileSync(path.join(dirs.health, "samples-2026-09.jsonl"), jsonl(32000));
  fs.writeFileSync(path.join(dirs.health, "sleep.jsonl"), jsonl(40, 0, "sleep"));
  fs.writeFileSync(path.join(dirs.health, "ring-pages.jsonl"), jsonl(300, 0, "page"));
  fs.writeFileSync(path.join(dirs.health, "ring-pages.committed"), "299\n");
  fs.writeFileSync(path.join(dirs.health, "ring-sleep-receipts.jsonl"), jsonl(120, 0, "rsr"));
  fs.writeFileSync(path.join(dirs.health, "resume-receipts.jsonl"), jsonl(60, 0, "resume"));
  fs.writeFileSync(path.join(dirs.health, "rollups.json"), JSON.stringify({ version: 3, days: { "2026-09-24": { hr: { min: 50, max: 120, avg: 71.5, sum: 1716, count: 24 } } } }));
  fs.writeFileSync(path.join(dirs.health, "steps-ledger.json"), JSON.stringify({ day: "2026-09-24", steps: 8123 }));
  fs.writeFileSync(path.join(dirs.health, "ring-pages.jsonl.tmp"), "half a compaction\n");
  fs.writeFileSync(path.join(dirs.voice, "capture-receipts.jsonl"), jsonl(15, 0, "voice"));
  fs.writeFileSync(path.join(dirs.tl, "translation-log-2026-09-26.jsonl"), jsonl(25, 0, "tl"));

  const first = await run("start");
  check(`first contact: result ok, ${first.bytes} bytes in ${first.requests} requests`, () => assert.equal(first.result, "ok"));
  check("first contact: samples-2026-09.jsonl (2.4 MB) byte-identical", () => {
    assert.ok(phoneFile(dirs.health, "samples-2026-09.jsonl").length > 2_400_000);
    assert.ok(same(dirs.health, "samples-2026-09.jsonl", "health/samples-2026-09.jsonl"));
  });
  check("first contact: every other file byte-identical, the .tmp not sent", () => {
    for (const n of ["sleep.jsonl", "ring-pages.jsonl", "ring-pages.committed", "ring-sleep-receipts.jsonl", "resume-receipts.jsonl", "rollups.json", "steps-ledger.json"]) {
      assert.ok(same(dirs.health, n, `health/${n}`), n);
    }
    assert.ok(same(dirs.voice, "capture-receipts.jsonl", "voice/capture-receipts.jsonl"));
    assert.ok(same(dirs.tl, "translation-log-2026-09-26.jsonl", "translation-log/translation-log-2026-09-26.jsonl"));
    assert.ok(!fs.existsSync(path.join(box, "health/ring-pages.jsonl.tmp")));
  });
  check("the box folder is 0700", () => assert.equal(fs.statSync(box).mode & 0o777, 0o700));

  // 2. Three deltas.
  for (let k = 1; k <= 3; k++) {
    const d1 = jsonl(3, 1000 * k, "sleep");
    const d2 = jsonl(4, 1000 * k, "tl");
    fs.appendFileSync(path.join(dirs.health, "sleep.jsonl"), d1);
    fs.appendFileSync(path.join(dirs.tl, "translation-log-2026-09-26.jsonl"), d2);
    const r = await run();
    const sleepSent = r.files.find((f) => f.f === "health/sleep.jsonl").sent;
    const tlSent = r.files.find((f) => f.f === "translation-log/translation-log-2026-09-26.jsonl").sent;
    check(`delta ${k}: only the new bytes went (sleep ${sleepSent}/${d1.length}, translation ${tlSent}/${d2.length}) and both copies are byte-identical`, () => {
      assert.equal(sleepSent, d1.length);
      assert.equal(tlSent, d2.length);
      assert.ok(same(dirs.health, "sleep.jsonl", "health/sleep.jsonl"));
      assert.ok(same(dirs.tl, "translation-log-2026-09-26.jsonl", "translation-log/translation-log-2026-09-26.jsonl"));
    });
  }

  // 3. The box unreachable for three ticks, then back.
  await boxDown();
  const stateBefore = fs.readFileSync(path.join(dirs.own, "state.json"), "utf8");
  for (let k = 0; k < 3; k++) {
    fs.appendFileSync(path.join(dirs.health, "ring-sleep-receipts.jsonl"), jsonl(2, 5000 + k * 10, "rsr"));
    fs.appendFileSync(path.join(dirs.health, "samples-2026-09.jsonl"), jsonl(20, 50000 + k * 100));
    fs.appendFileSync(path.join(dirs.tl, "translation-log-2026-09-26.jsonl"), jsonl(3, 7000 + k * 10, "tl"));
    const r = await run();
    check(`offline tick ${k + 1}: result ${r.result}, offsets unchanged`, () => {
      assert.equal(r.result, "offline");
      assert.equal(fs.readFileSync(path.join(dirs.own, "state.json"), "utf8"), stateBefore);
    });
  }
  await boxUp();
  const back = await run();
  check(`back online: one tick catches up exactly (${back.bytes} bytes)`, () => {
    assert.equal(back.result, "ok");
    for (const n of ["ring-sleep-receipts.jsonl", "samples-2026-09.jsonl"]) assert.ok(same(dirs.health, n, `health/${n}`), n);
    assert.ok(same(dirs.tl, "translation-log-2026-09-26.jsonl", "translation-log/translation-log-2026-09-26.jsonl"));
  });

  // 4. Restart: nothing in memory, only the state file. (Every run above
  // already used a fresh io; this checks the offset itself.)
  const delta = jsonl(5, 90000);
  fs.appendFileSync(path.join(dirs.health, "samples-2026-09.jsonl"), delta);
  const before = requests;
  const afterRestart = await run("start");
  const samplesSent = afterRestart.files.find((f) => f.f === "health/samples-2026-09.jsonl").sent;
  check(`after a restart only the new ${delta.length} bytes of samples went (${samplesSent})`, () => {
    assert.equal(samplesSent, delta.length);
    assert.ok(same(dirs.health, "samples-2026-09.jsonl", "health/samples-2026-09.jsonl"));
    assert.ok(requests - before <= 3, `${requests - before} requests`);
  });

  // 5. The ring page journal compacts and regrows past the old offset.
  const oldPages = phoneFile(dirs.health, "ring-pages.jsonl");
  const compacted = Buffer.concat([jsonl(100, 200, "page"), jsonl(400, 2000, "page")]);
  assert.ok(compacted.length > oldPages.length);
  fs.writeFileSync(path.join(dirs.health, "ring-pages.jsonl.tmp"), compacted);
  fs.renameSync(path.join(dirs.health, "ring-pages.jsonl.tmp"), path.join(dirs.health, "ring-pages.jsonl"));
  const compact = await run();
  check("journal compaction: caught by the head check, box copy byte-identical, old copy archived", () => {
    assert.equal(compact.files.find((f) => f.f === "health/ring-pages.jsonl").reset, "head changed");
    assert.ok(same(dirs.health, "ring-pages.jsonl", "health/ring-pages.jsonl"));
    const archived = fs.readdirSync(path.join(box, ".archive/health")).filter((n) => n.startsWith("ring-pages.jsonl."));
    assert.equal(archived.length, 1);
    assert.equal(md5(fs.readFileSync(path.join(box, ".archive/health", archived[0]))), md5(oldPages));
  });

  // 6. A wrong token, then an old cc-web without the route.
  fs.appendFileSync(path.join(dirs.health, "sleep.jsonl"), jsonl(1, 9999, "sleep"));
  token = "wrong";
  const stateBeforeAuth = fs.readFileSync(path.join(dirs.own, "state.json"), "utf8");
  const unauth = await run();
  token = TOKEN;
  check(`wrong token: result ${unauth.result}, offsets unchanged`, () => {
    assert.equal(unauth.result, "unauthorized");
    assert.equal(fs.readFileSync(path.join(dirs.own, "state.json"), "utf8"), stateBeforeAuth);
  });
  await boxDown();
  const old = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end("Cannot POST /api/phone/logs");
  });
  await new Promise((r) => old.listen(port, "127.0.0.1", r));
  const r404 = await run();
  await new Promise((r) => old.close(r));
  check(`old cc-web: result ${r404.result}, offsets unchanged`, () => {
    assert.equal(r404.result, "http-404");
    assert.equal(fs.readFileSync(path.join(dirs.own, "state.json"), "utf8"), stateBeforeAuth);
  });
  await boxUp();
  const healed = await run();
  check("after both, one tick heals: sleep.jsonl byte-identical", () => {
    assert.equal(healed.result, "ok");
    assert.ok(same(dirs.health, "sleep.jsonl", "health/sleep.jsonl"));
  });

  // 7. The receipt travels too, one tick behind.
  check("the upload receipt reached the box (all but the latest line)", () => {
    const phoneReceipt = phoneFile(dirs.own, "upload-receipts.jsonl").toString();
    const boxReceipt = boxFile("log-upload/upload-receipts.jsonl").toString();
    const lines = phoneReceipt.trimEnd().split("\n");
    assert.equal(boxReceipt, lines.slice(0, -1).join("\n") + "\n");
    const results = lines.map((l) => JSON.parse(l).result);
    console.log(`     receipt results: ${results.join(", ")}`);
  });

  // 8. A realistic half-hour tick, measured: what one ring pull and one
  // store sync append (sizes from the code's own comments; see the return doc).
  const typical = {
    "samples-2026-09.jsonl": jsonl(8, 200000), // hourly HR/HRV/SpO2 + 10-min steps: a handful of lines
    "ring-pages.jsonl": Buffer.from(`${JSON.stringify({ n: 99999, rxMs: 1758700000000, cmd: "06:01", pageSeq: 1, rawHex: "ab".repeat(240) })}\n`.repeat(6)),
    "ring-sleep-receipts.jsonl": Buffer.from(`${JSON.stringify({ at: 1758700000000, pull: "tick", link: "new", types: 5, answered: 5, ms: 18000 })}\n`),
    "resume-receipts.jsonl": jsonl(2, 300000, "resume"),
  };
  for (const [n, b] of Object.entries(typical)) fs.appendFileSync(path.join(dirs.health, n), b);
  const rollups = JSON.parse(fs.readFileSync(path.join(dirs.health, "rollups.json"), "utf8"));
  for (let d = 1; d <= 13; d++) {
    const day = `2026-09-${String(11 + d).padStart(2, "0")}`;
    rollups.days[day] = {};
    for (const m of ["heartRate", "hrv", "spo2", "steps", "temperature", "stress"]) {
      rollups.days[day][m] = { min: 50 + d, max: 120 + d, avg: 71.43478260869566 + d, sum: 1716 + d, count: 23 };
    }
  }
  fs.writeFileSync(path.join(dirs.health, "rollups.json"), JSON.stringify(rollups));
  const wireBefore = wireBytes;
  const typ = await run();
  const rollupBytes = typ.files.find((f) => f.f === "health/rollups.json")?.sent ?? 0;
  check(`a typical tick: ${typ.bytes} bytes of file in ${typ.requests} requests, ${wireBytes - wireBefore} bytes on the wire (rollups.json whole: ${rollupBytes})`, () => {
    assert.equal(typ.result, "ok");
    for (const n of Object.keys(typical)) assert.ok(same(dirs.health, n, `health/${n}`), n);
  });
  const idle = await run();
  check(`a tick with nothing new: ${idle.requests} requests (the previous run's receipt line only)`, () => assert.ok(idle.requests <= 1));

  console.log(`\nALL ${checks} CHECKS PASS (box trail: ${fs.readFileSync(path.join(box, ".uploads.log"), "utf8").trim().split("\n").length} requests logged)`);
  await boxDown();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  console.error(`FAIL ${error && error.stack ? error.stack : error}`);
  console.error(`(left for inspection: ${tmp})`);
  process.exit(1);
});
