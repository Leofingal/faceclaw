// Standalone EHPK unpacker, ported from faceclaw's app/apps/evenhub/ehpk.ts
// Usage: node unpack-ehpk.mjs <input.ehpk> <output-dir>
import { decompress } from "fzstd";
import fs from "node:fs";
import path from "node:path";

const XOR_KEY = "EVEN REALITIES";
const RECORD_FILE = 0xe4;
const RECORD_DIR = 0xe5;
const RECORD_FOOTER = 0xe3;

function unxor(data, start, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = data[start + i] ^ XOR_KEY.charCodeAt(i % XOR_KEY.length);
  }
  return out;
}

function utf8Decode(bytes) {
  return Buffer.from(bytes).toString("utf8");
}

function parseEhpk(data) {
  if (data.length < 20 || data[0] !== 0x45 || data[1] !== 0x48 || data[2] !== 0x50 || data[3] !== 0x4b) {
    throw new Error("not an EHPK file");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const firstRecord = view.getUint32(8, true);
  const files = new Map();
  let p = firstRecord;
  while (p < data.length) {
    const type = data[p];
    if (data[p + 1] !== 0xba || data[p + 2] !== 0xa9 || data[p + 3] !== 0xba) {
      throw new Error(`ehpk: bad record magic at ${p}`);
    }
    if (type === RECORD_FILE) {
      const compressedLength = view.getUint32(p + 4, true);
      const uncompressedLength = view.getUint32(p + 8, true);
      const nameLength = view.getUint16(p + 14, true);
      const name = utf8Decode(unxor(data, p + 16, nameLength));
      const blob = unxor(data, p + 16 + nameLength, compressedLength);
      const content = decompress(blob, new Uint8Array(uncompressedLength));
      if (content.length !== uncompressedLength) {
        throw new Error(`ehpk: ${name}: expected ${uncompressedLength} bytes, got ${content.length}`);
      }
      files.set(name, content);
      p += 16 + nameLength + compressedLength;
    } else if (type === RECORD_DIR) {
      const nameLength = view.getUint16(p + 6, true);
      p += 8 + nameLength;
    } else if (type === RECORD_FOOTER) {
      break;
    } else {
      throw new Error(`ehpk: unknown record type 0x${type.toString(16)} at ${p}`);
    }
  }
  return { files };
}

const [, , inputPath, outputDir] = process.argv;
if (!inputPath || !outputDir) {
  console.error("Usage: node unpack-ehpk.mjs <input.ehpk> <output-dir>");
  process.exit(1);
}

const data = new Uint8Array(fs.readFileSync(inputPath));
const { files } = parseEhpk(data);
console.log(`Parsed ${files.size} files from ${inputPath}`);
for (const [name, content] of files) {
  const outPath = path.join(outputDir, name);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(content));
  console.log(`  ${name}  (${content.length} bytes)`);
}
