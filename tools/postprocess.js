#!/usr/bin/env node
/**
 * Luna playable HTML → WeChat 小游戏目录 后处理脚本
 *
 * 输入: Luna 输出的单 HTML (e.g. applovinChannel.html)
 * 输出: 微信小游戏工程目录 (game.js / 主包 / 分包)
 *
 * 设计原则 (Phase 1):
 *   - 每段 <script> 按出现顺序保存为独立文件 (NN_<kind>.js)
 *   - 不修改语义,只做"位置位移":compressed_asset 移到分包,base122_dom_bind 改写
 *   - game.js 按原顺序 require,保证执行序与 HTML 等价
 *   - 内联媒体 (img/video data:URL, data-src122) 落盘到 assets/inline/
 */

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) {
  console.error('usage: node tools/postprocess.js <channel.html> <out-dir>');
  process.exit(1);
}
// 模板 = luna2wechat repo root（脚本所在 tools/ 的父目录），仅复制 TPL_INCLUDE 子集
const REPO_ROOT = path.resolve(__dirname, '..');
const TPL_INCLUDE = ['first-screen.js', 'game.js', 'game.json', 'project.config.json', 'luna-to-wx'];

const html = fs.readFileSync(SRC, 'utf8');

// 哪些类别属于"分包资源",哪些是"主包代码",哪些"重写 / 跳过"
const PLACEMENT = {
  // 主包代码 (按原序 require)
  lang_config:        'main',
  helper_buffer:      'main',
  package_config:     'main',
  brotli:             'main',
  environment:        'main',
  bundles_placeholder:'main',
  pi_runtime:         'main',
  unbrotli:           'main',
  debug_flags:        'main',
  pi_invoker:         'main',
  base122_decode:     'main',
  ready_glue:         'main',
  bootstrap:          'main',
  audio_toggle:       'main',

  // 分包: 大块资源
  compressed_asset:   'subpackage',

  // 必须改写 (DOM 扫描在微信下行不通; mraid 在微信下不存在)
  base122_dom_bind:   'rewrite',
  ad_bridge:          'rewrite',

  // 微信下不需要
  analytics:          'skip',
  loading_image_call: 'skip',  // 已交给 first-screen.js
  i18n_analytics:     'skip',  // luna 7.x 把 base64 编码的 i18n 上报路径当 <script> 内容输出, wx 解析抛 ReferenceError

  unknown:            'main',  // 默认放主包,后续人工核对
};

function classify(attrs, body) {
  if (attrs.includes('LUNA_PLAYGROUND_BUNDLES')) return 'bundles_placeholder';
  if (body.includes('module.exports') && body.includes('unbrotli')) return 'unbrotli';
  if (/^\s*\(\(\)\s*=>\s*\{\s*var\s+e\s*=\s*\{\s*477:/.test(body)) return 'brotli';
  if (body.includes('_decode122Promises')) return 'base122_dom_bind';
  if (body.includes('_base122ToArrayBuffer') && body.length < 5000) return 'base122_decode';
  if (body.includes('_compressedAssets.push') &&
      (body.includes('decompressArrayBuffer') || body.includes('decompressString')))
    return 'compressed_asset';
  if (body.includes('LunaUnity.Application') && body.includes('startGame')) return 'bootstrap';
  // MRAID 是 IAB 广告网络规范, 微信下走 wx.onShow/onHide + wx.navigateToMiniProgram
  if (body.includes('mraid') && (body.includes('Bridge.ready') || body.includes('Luna.Unity.Playable')))
    return 'ad_bridge';
  if (body.includes('LUNA_PI_SETTINGS') && body.includes('window.pi.apply')) return 'pi_invoker';
  if (body.includes('window.LUNA_PLAYGROUND_PACKAGE_CONFIG')) return 'package_config';
  if (body.includes('window.$environment')) return 'environment';
  if (body.includes('languageSettings')) return 'lang_config';
  if (body.includes('SET_LOADING_IMAGE')) return 'loading_image_call';
  if (body.includes('window._bridgeReady') || body.includes('window._domReady')) return 'ready_glue';
  if (body.includes('window.DEBUG') && body.includes('window.TRACE')) return 'debug_flags';
  if (body.includes('createPlayableAnalytics')) return 'analytics';
  if (body.includes('audioVolumeToggle')) return 'audio_toggle';
  if (body.includes('window.pi') || /pc\.TextGenerator/.test(body)) return 'pi_runtime';
  // 行 51 那个 "function t(t,e){...charCodeAt..." 是字符串/buffer 工具
  if (body.length < 6000 && /charCodeAt|String\.fromCharCode/.test(body)) return 'helper_buffer';
  // luna 7.x i18n analytics chunk: 整个 <script> body 只有一行 base64 字符串字面量 (上报路径编码后的产物),
  // 浏览器吞掉 ReferenceError 静默, 但 wx 试玩 runtime 解析 → "X is not defined" → 启动期 [E] 噪音.
  // 特征: 短 body (40-300 字节), 全 base64 字符 (含 = 填充), 无任何 JS 语法/标点.
  if (/^\s*[A-Za-z0-9+/=]{40,300}\s*$/.test(body)) return 'i18n_analytics';
  return 'unknown';
}

// ---------- 1. parse ----------
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const scripts = [];
let m;
while ((m = re.exec(html))) {
  const attrs = m[1].trim();
  const body = m[2];
  const startLine = html.slice(0, m.index).split('\n').length;
  scripts.push({
    idx: scripts.length,
    startLine,
    attrs,
    body,
    kind: classify(attrs, body),
    len: body.length,
  });
}

// ---------- 2. prepare output dirs ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'luna-runtime'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'luna-to-wx'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'subpackage-bundle'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'assets', 'inline'), { recursive: true });

const manifest = { src: SRC, scripts: [], assets: [], main: [], subpackage: [], rewrite: [], skip: [] };

// ---------- 3. emit scripts (preserve order) ----------
function pad(n) { return String(n).padStart(2, '0'); }
const banner = (s) => `// auto-extracted: idx=${s.idx} kind=${s.kind} origLine=${s.startLine}\n`;

for (const s of scripts) {
  const place = PLACEMENT[s.kind] ?? 'main';
  const fname = `${pad(s.idx)}_${s.kind}.js`;
  let dir;
  if (place === 'subpackage') dir = 'subpackage-bundle';
  else if (place === 'rewrite') dir = 'luna-runtime/_to_rewrite';
  else if (place === 'skip')    dir = 'luna-runtime/_skipped';
  else                          dir = 'luna-runtime';

  fs.mkdirSync(path.join(OUT, dir), { recursive: true });
  const rel = path.join(dir, fname);
  fs.writeFileSync(path.join(OUT, rel), banner(s) + s.body + '\n');
  const size = fs.statSync(path.join(OUT, rel)).size;

  manifest[place === 'subpackage' ? 'subpackage'
       : place === 'rewrite' ? 'rewrite'
       : place === 'skip' ? 'skip'
       : 'main'].push({ rel, size, kind: s.kind, idx: s.idx, line: s.startLine });
}

// ---------- 4. extract <img>/<video>/<audio> media ----------
function extractMedia() {
  const reTag = /<(img|video|audio)\b([^>]*)>/gi;
  let i = 0, m;
  while ((m = reTag.exec(html))) {
    const tag = m[1];
    const attrs = m[2];
    const idMatch  = /\bid="([^"]+)"/.exec(attrs);
    const mimeAttr = /\bmime="([^"]+)"/.exec(attrs);
    const src122   = /\bdata-src122="([^"]+)"/.exec(attrs);
    const dataSrc  = /\bsrc="data:([^;]+);base64,([^"]+)"/.exec(attrs);

    const id = idMatch ? idMatch[1] : `${tag}_${i++}`;
    if (src122) {
      const mime = mimeAttr ? mimeAttr[1] : 'application/octet-stream';
      const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
      const rel = `assets/inline/src122/${id}.${ext}.b122`;
      fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
      fs.writeFileSync(path.join(OUT, rel), src122[1]);
      manifest.assets.push({ kind: 'src122', tag, id, mime, rel, encodedLen: src122[1].length });
    } else if (dataSrc) {
      const mime = dataSrc[1];
      const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
      const rel = `assets/inline/data/${id}.${ext}`;
      fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
      fs.writeFileSync(path.join(OUT, rel), Buffer.from(dataSrc[2], 'base64'));
      manifest.assets.push({
        kind: 'data', tag, id, mime, rel,
        decodedSize: fs.statSync(path.join(OUT, rel)).size,
      });
    }
  }
}
extractMedia();

// ---------- 5. copy templates ----------
function copyTree(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const sp = path.join(srcDir, e.name);
    const dp = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      copyTree(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}
for (const name of TPL_INCLUDE) {
  const sp = path.join(REPO_ROOT, name);
  if (!fs.existsSync(sp)) continue;
  const dp = path.join(OUT, name);
  if (fs.statSync(sp).isDirectory()) {
    fs.mkdirSync(dp, { recursive: true });
    copyTree(sp, dp);
  } else {
    fs.copyFileSync(sp, dp);
  }
}

// ---------- 5b. auto-patch bootstrap chunk: startGame → 全局 ----------
// function startGame() {} 在试玩 require 模块作用域不会自动挂全局,必须显式 attach,
// 否则 luna 内部调 window.startGame() 报 TypeError → 黑屏.
// 不同 luna 版本 bootstrap chunk 的 idx 不同 (17 / 18 ...), 必须按 kind 找实际路径,
// 不能写死文件名.
const bootstrapEntry = manifest.main.find(x => x.kind === 'bootstrap');
if (bootstrapEntry) {
  const bootstrapPath = path.join(OUT, bootstrapEntry.rel);
  const PATCH = `;(typeof GameGlobal!=='undefined'?GameGlobal:globalThis).startGame=startGame;`;
  const cur = fs.readFileSync(bootstrapPath, 'utf8');
  if (!cur.includes('startGame=startGame')) {
    fs.writeFileSync(bootstrapPath, cur.replace(/\s*$/, '\n' + PATCH + '\n'));
  }
} else {
  console.warn('postprocess: no chunk classified as bootstrap — startGame patch skipped');
}

// ---------- 6. generate require lists (read by game.js at runtime) ----------
const requireList = manifest.main
  .sort((a, b) => a.idx - b.idx)
  .map(x => `./${x.rel.replace(/\\/g, '/')}`);
// 同时输出 .json (留作 manifest 参考) + .js (game.js require 用 — 试玩 runtime 不接 .json)
fs.writeFileSync(
  path.join(OUT, 'main-require-order.json'),
  JSON.stringify(requireList, null, 2),
);
fs.writeFileSync(
  path.join(OUT, 'main-require-order.js'),
  'module.exports = ' + JSON.stringify(requireList, null, 2) + ';\n',
);

// 分包列表 (game.js 用 require 直接引入主包) — 不同 luna 版本 chunk 序号不同 (12/13/14 vs 11/12/13),
// 必须按实际 manifest.subpackage 动态生成, 不能写死.
const subpkgList = manifest.subpackage
  .sort((a, b) => a.idx - b.idx)
  .map(x => `./${x.rel.replace(/\\/g, '/')}`);
fs.writeFileSync(
  path.join(OUT, 'subpackage-list.js'),
  'module.exports = ' + JSON.stringify(subpkgList, null, 2) + ';\n',
);

manifest.scripts = scripts.map(s => ({ idx: s.idx, line: s.startLine, kind: s.kind, len: s.len }));
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---------- 6b. auto-extract WASM (Box2D / Mecanim) ----------
// luna 内部 box2d/mecanim emscripten WASM 必须落成 .wasm.br 静态文件,
// 否则 dom-shim 的 redirect 表 lookup 成功但 instantiate(file) 找不到文件 → load wasm failed → 黑屏.
// 单独 spawn 子进程跑 (extract-wasm.cjs 是异步, 与 postprocess 主流程耦合复杂),
// 失败 (不存在 brotli runtime / 没找到 WASM) 视为 warning 不阻断.
try {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'extract-wasm.cjs'), OUT], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.warn(`postprocess: extract-wasm exited with status=${r.status} — WASM 可能未抠出, 真机会 [WASM] load wasm failed`);
  }
} catch (e) {
  console.warn('postprocess: extract-wasm step skipped:', e && e.message);
}

// ---------- 7. summary ----------
const fmt = n => (n < 100 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(2)}MB`);
const sumSize = arr => arr.reduce((a, b) => a + b.size, 0);

console.log('\n=== Postprocess Summary ===');
console.log(`Source: ${SRC}  (${fmt(fs.statSync(SRC).size)})`);
console.log(`Output: ${OUT}\n`);

const sections = [
  ['主包 (按原序加载)', manifest.main],
  ['分包 (subpackage-bundle/)', manifest.subpackage],
  ['待改写 (luna-runtime/_to_rewrite)', manifest.rewrite],
  ['已跳过 (luna-runtime/_skipped)', manifest.skip],
];
for (const [label, arr] of sections) {
  console.log(`-- ${label} --`);
  for (const r of arr.sort((a, b) => a.idx - b.idx))
    console.log(`  [${pad(r.idx)}] ${r.rel.padEnd(60)} ${fmt(r.size).padStart(8)}`);
  console.log(`  ${'TOTAL'.padEnd(63)} ${fmt(sumSize(arr)).padStart(8)}\n`);
}

console.log('-- 内联媒体 --');
const grouped = {};
let mediaTotal = 0;
for (const a of manifest.assets) {
  const key = `${a.kind}/${a.tag}/${a.mime}`;
  grouped[key] = (grouped[key] || { n: 0, bytes: 0 });
  grouped[key].n++;
  grouped[key].bytes += a.decodedSize || a.encodedLen || 0;
  mediaTotal += a.decodedSize || a.encodedLen || 0;
}
for (const [k, v] of Object.entries(grouped))
  console.log(`  ${k.padEnd(40)} ×${String(v.n).padStart(2)}  ${fmt(v.bytes).padStart(8)}`);
console.log(`  ${'TOTAL'.padEnd(43)}  ${fmt(mediaTotal).padStart(8)}\n`);

const mainTotal = sumSize(manifest.main);
const subTotal  = sumSize(manifest.subpackage);
console.log('-- 微信小游戏配额预估 --');
console.log(`  主包 JS 合计  ${fmt(mainTotal)}    (限 4MB)  ${mainTotal < 4*1024*1024 ? '✓' : '✗ 超额'}`);
console.log(`  分包 JS 合计  ${fmt(subTotal)}    (单分包限 4MB)  ${subTotal < 4*1024*1024 ? '✓' : '✗ 需再切分'}`);
console.log(`  内联媒体     ${fmt(mediaTotal)}\n`);
