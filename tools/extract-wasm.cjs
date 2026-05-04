#!/usr/bin/env node
// (Local validation copy — final lives in /root/.claude/skills/luna2wechat/extract-wasm.cjs)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function die(m,c=1){console.error('extract-wasm:',m);process.exit(c);}

const projectDir = process.argv[2];
if (!projectDir) die('usage: node extract-wasm.cjs <project-dir> [out-dir]');
const outDir = process.argv[3] || projectDir;

const brotliRuntime = path.join(projectDir, 'luna-runtime', '04_brotli.js');
const asset14 = path.join(projectDir, 'subpackage-bundle', '14_compressed_asset.js');
for (const p of [brotliRuntime, asset14]) {
  if (!fs.existsSync(p)) die(`missing required file: ${p}`);
}
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

global.window = global;
require(path.resolve(brotliRuntime));
if (typeof global.decompress !== 'function') {
  die('04_brotli.js did not attach window.decompress');
}

const src = fs.readFileSync(asset14, 'utf8');
const m = src.match(/decompress(?:String|ArrayBuffer)\(\s*"([^"]+)"/);
if (!m) die('no decompress payload in 14_compressed_asset.js');
const bytes = global.decompress(m[1]);
const text = Buffer.from(bytes).toString('latin1');
console.error(`14_compressed_asset decompressed: ${bytes.length} bytes`);

const re = /"data:application\/octet-stream;base64,([A-Za-z0-9+/=]{100,})"/g;
const modules = [];
let mm;
while ((mm = re.exec(text))) {
  const buf = Buffer.from(mm[1], 'base64');
  if (buf[0]===0x00 && buf[1]===0x61 && buf[2]===0x73 && buf[3]===0x6d) modules.push(buf);
}
if (!modules.length) die('no WASM data: URIs');
console.error(`found ${modules.length} WASM module(s)`);

function classify(buf) {
  const s = buf.toString('latin1');
  if (/b2(?:Body|Joint|Contact|Polygon|Circle|Shape|Fixture)/.test(s)) return 'box2d';
  if (/Animator|Mecanim/.test(s)) return 'mecanim';
  return null;
}

const manifest = {};
for (const buf of modules) {
  const kind = classify(buf);
  if (!kind) {
    const name = `luna-wasm-unknown-${buf.length}`;
    fs.writeFileSync(path.join(outDir, `${name}.wasm`), buf);
    console.error('unidentified WASM, wrote', name + '.wasm');
    continue;
  }
  if (manifest[kind]) { console.error(`duplicate ${kind}, dropping size=${buf.length}`); continue; }
  fs.writeFileSync(path.join(outDir, `${kind}.wasm`), buf);
  const br = zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  fs.writeFileSync(path.join(outDir, `${kind}.wasm.br`), br);
  manifest[kind] = { raw_size: buf.length, br_size: br.length };
  console.error(`  ${kind}: ${buf.length} -> ${br.length} bytes`);
}

fs.writeFileSync(path.join(outDir, 'luna-wasm.json'), JSON.stringify(manifest, null, 2) + '\n');
console.error('done.');
