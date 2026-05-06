#!/usr/bin/env node
// 抠 luna 工程内的 box2d / mecanim emscripten WASM,落成 .wasm.br 静态文件.
//
// 历史教训 (2026-05-06 打怪升武器_unity.html 调试出根因):
//   - 老脚本写死 luna-runtime/04_brotli.js + subpackage-bundle/14_compressed_asset.js,
//     新 luna 7.x chunk 序号是 02 / 13, 文件不存在直接 die.
//   - 老脚本只 grep 直接 data:application/octet-stream;base64,AGFzbQ... URI,
//     新 luna 7.x WASM 仍是 base64 但被 brotli + base122 包了一层
//     (藏在 decompressString("...") 调用 payload 里), 直接 grep 0 命中.
//   - 老脚本同步处理 decompress, 新 luna decompressArrayBuffer 返回 Promise → TypeError.
//
// 重构原则:
//   1. 不写死 chunk 序号: 扫 luna-runtime/ 找 brotli runtime, 扫 subpackage-bundle/ 找含 WASM 的 chunk
//   2. 兼容同步 + async (Promise) decompress
//   3. 双层套娃: 直接 data URI WASM (老 luna) 或 decompressString 输出里嵌 data URI (新 luna 7.x)
//   4. 失败 (无 brotli runtime / 无 WASM) 退出 status=2 不阻断 postprocess

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function warn(m) { console.error('extract-wasm:', m); }
function die(m, c = 2) { warn(m); process.exit(c); }

const projectDir = process.argv[2];
if (!projectDir) die('usage: node extract-wasm.cjs <project-dir> [out-dir]', 1);
const outDir = process.argv[3] || projectDir;
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ---------- 1. find brotli runtime chunk ----------
// brotli runtime chunk 体里会定义 window.decompress / decompressString / decompressArrayBuffer.
// 命名约定: postprocess.js 把 kind=='brotli' 的 chunk 写为 NN_brotli.js, 但保险起见 + 兼容老工程,
// 走 grep 实际内容找 (`module.exports={...,477:...}` brotli decoder 模式 + decompress 函数).
function findBrotliRuntime(rtDir) {
  if (!fs.existsSync(rtDir)) return null;
  for (const name of fs.readdirSync(rtDir)) {
    if (!name.endsWith('.js')) continue;
    const p = path.join(rtDir, name);
    const txt = fs.readFileSync(p, 'utf8');
    // brotli runtime 特征: 内含 decompressArrayBuffer/decompressString 函数定义 + 477 大表
    if (/decompressArrayBuffer\s*=/.test(txt) || /decompressString\s*=/.test(txt)) return p;
  }
  return null;
}

// ---------- 2. main ----------
(async () => {
  const brotliPath = findBrotliRuntime(path.join(projectDir, 'luna-runtime'));
  if (!brotliPath) {
    warn(`brotli runtime not found in ${projectDir}/luna-runtime — 工程可能不含 luna 内嵌 WASM`);
    process.exit(2);
  }
  console.error(`brotli runtime: ${path.relative(projectDir, brotliPath)}`);

  global.window = global;
  // 用 fs+eval 而非 require: 中文路径 require 在某些 node 版本会 ENOENT
  const brotliSrc = fs.readFileSync(brotliPath, 'utf8');
  eval.call(global, brotliSrc);
  const decAB = global.decompressArrayBuffer || global.decompress;
  const decStr = global.decompressString || global.decompress;
  if (typeof decAB !== 'function' && typeof decStr !== 'function') {
    warn('brotli runtime did not attach decompress* on window');
    process.exit(2);
  }

  // ---------- 3. scan all subpackage chunks for WASM ----------
  const subDir = path.join(projectDir, 'subpackage-bundle');
  if (!fs.existsSync(subDir)) {
    warn(`no subpackage-bundle/ in ${projectDir}`);
    process.exit(2);
  }
  const chunks = fs.readdirSync(subDir).filter(n => n.endsWith('.js')).sort();
  console.error(`scanning ${chunks.length} subpackage chunks for WASM data URIs`);

  const wasmModules = []; // Buffer[]

  function scanTextForWasm(text) {
    const re = /"data:application\/octet-stream;base64,([A-Za-z0-9+/=]{100,})"/g;
    let mm;
    while ((mm = re.exec(text))) {
      const buf = Buffer.from(mm[1], 'base64');
      if (buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d) {
        wasmModules.push(buf);
      }
    }
  }

  for (const name of chunks) {
    const src = fs.readFileSync(path.join(subDir, name), 'utf8');

    // 路径 A (老 luna): chunk body 直接含 data URI WASM
    scanTextForWasm(src);

    // 路径 B (新 luna 7.x): WASM 藏在 decompressString("...") 的 base122 payload 里
    // 注: decompressArrayBuffer 输出是二进制资源 (jsons / image bytes), 不会嵌 data URI WASM, 跳过.
    const re = /decompressString\(\s*"([^"]+)"/g;
    let pm;
    while ((pm = re.exec(src))) {
      try {
        let raw = decStr.call(global, pm[1]);
        if (raw && typeof raw.then === 'function') raw = await raw;
        if (typeof raw !== 'string') raw = Buffer.from(raw).toString('latin1');
        scanTextForWasm(raw);
      } catch (e) {
        // 单个 payload 解码失败不致命, 继续扫
      }
    }
  }

  if (!wasmModules.length) {
    warn('no WASM modules found — 工程可能不含 box2d/mecanim, 这是正常的纯 2D playable');
    process.exit(2);
  }
  console.error(`found ${wasmModules.length} WASM module(s)`);

  // ---------- 4. classify + write .wasm.br ----------
  function classify(buf) {
    const s = buf.toString('latin1');
    if (/b2(?:Body|Joint|Contact|Polygon|Circle|Shape|Fixture)/.test(s)) return 'box2d';
    if (/Animator|Mecanim|MotionField/.test(s)) return 'mecanim';
    return null;
  }

  const manifest = {};
  for (const buf of wasmModules) {
    const kind = classify(buf);
    if (!kind) {
      const name = `luna-wasm-unknown-${buf.length}`;
      fs.writeFileSync(path.join(outDir, `${name}.wasm`), buf);
      console.error(`  unidentified WASM, wrote ${name}.wasm (len=${buf.length})`);
      continue;
    }
    if (manifest[kind]) {
      console.error(`  duplicate ${kind}, dropping size=${buf.length}`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${kind}.wasm`), buf);
    const br = zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
    fs.writeFileSync(path.join(outDir, `${kind}.wasm.br`), br);
    manifest[kind] = { raw_size: buf.length, br_size: br.length };
    console.error(`  ${kind}: raw=${buf.length} → br=${br.length}`);
  }

  fs.writeFileSync(path.join(outDir, 'luna-wasm.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.error('extract-wasm: done');
})().catch(e => {
  warn('fatal: ' + (e && e.stack || e));
  process.exit(2);
});
