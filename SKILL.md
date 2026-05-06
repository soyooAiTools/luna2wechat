---
name: luna2wechat
description: 把 Luna 导出的 playable 跑在微信"试玩广告"runtime（playable-libs 2.0.15）上的标准流程：拆 WASM、写 dom-shim、改 main-require-order、关分包、部署预览。触发: luna2wechat, luna 试玩, luna playable wechat, wxgame-playable-lib, WXWebAssembly, 试玩广告 runtime.
---

# Luna → 微信试玩广告 适配 Skill

把 Unity + Luna 导出的 web playable，搬到微信 **试玩广告 runtime**（vConsole 自报 `[system] playable-libs: 2.0.15`）。这是 wechatChannel 走 Luna+小包路线对标 applovin 的实操路径——见 `project_wechat_channel_scope.md`。

## 前置事实（必读）

试玩广告 runtime ≠ 普通微信小游戏，API 面被严重阉割。完整缺失清单与背后原因见记忆 **`project_wx_playable_runtime_constraints.md`**。**读完那条再开工**——它解释了下面所有"为什么这么改"。

要点摘录：
- 不支持分包（`wx.loadSubpackage` 不存在），主包硬上限 5MB
- 没有可写 FS（`writeFileSync` 抛 not implemented，`USER_DATA_PATH === '/'`）
- `require()` 只接 `.js`，不接 `.json`
- `WXWebAssembly.instantiate` 只吃文件路径，不吃 ArrayBuffer/Module
- 没有 `location` / `URLSearchParams` / `crypto` / `addEventListener`（部分 DOM 子对象上）

## 入口形态：源工程 vs 渠道 HTML

Luna 输出有两种形态，本 skill 都覆盖：

1. **源工程目录**：`luna-runtime/*.js` + `subpackage-bundle/*.js` 分立文件 + 散资源
2. **渠道发布 HTML**：单文件 `unityChannel.html` / `applovinChannel.html` / `tiktokChannel.html` / `mintegralChannel.html` 等（5MB 量级），所有 chunk + 资源 inline 进 `<script>` / `<img>` / `<audio>`

渠道 HTML **互相等价**——chunk 字节比对证明 unity 与 applovin 输出的 14 主包 + 3 分包 + `16_base122_dom_bind` 完全相同；channel 差异 100% 落在 `_skipped/01_analytics`（不同 ad-network SDK，luna2wechat 丢弃）和 `_to_rewrite/21_ad_bridge`（几个 whitespace，luna2wechat 用 wx-ad-bridge.js 重写）。详见 `project_luna_channel_html_interchangeable.md`。

**渠道 HTML → luna2wechat 工程目录**：

```bash
node tools/postprocess.js channelXxx.html out/
```

输出树结构跟源工程一致：`luna-runtime/00..20_*.js` + `subpackage-bundle/12..14_compressed_asset.js` + `manifest.json` + `assets/inline/{data,src122}/*` + `main-require-order.json`。脚本按 chunk 内容结构分类（不依赖 channel 字符串），新 channel 无需写分支。

### postprocess.js 已自动做的六件事（别误清）

postprocess.js 内部已处理六件**漏了就黑屏 / 显著拖慢启动**的事——但 PoC 后人工清理时容易误删，记住别动：

**1. bootstrap chunk 末尾的 startGame 全局挂载**（已自动注入）

原始 `function startGame() {...}` 在试玩 require 模块作用域里**不会**自动挂全局。postprocess.js 自动追加：

```js
;(typeof GameGlobal!=='undefined'?GameGlobal:globalThis).startGame=startGame;
```

注入路径**按 chunk kind 找**（`manifest.main.find(x => x.kind === 'bootstrap')`），不是按文件名硬编码——不同 luna 版本 bootstrap chunk 的 idx 是 17 / 18 / ... 视编排顺序变化。2026-05-06 修这个根因前 postprocess 写死 `18_bootstrap.js`，本工程是 17，patch 静默 skip → game.js 里事后桥接拿不到 globalThis.startGame → 黑屏。

漏 / 误删 patch → luna 内部调 `window.startGame()` 报 `TypeError: window.startGame is not a function` → scene 不加载 → MeshInstance=0 → **黑屏**（probe 看到 `[deep] no MIs (renderers=N/A)`）。

**2. manifest.json + assets/inline/**（postprocess.js 输出，别清）

asset-inject.js 启动时读 `manifest.json`，遍历 `assets[]`，每个 `kind === 'data'` asset 走 `wx.createImage().src = asset.rel` 加载落盘的 `assets/inline/data/*.{png,jpg,mp4}`。

清 PoC 残留时**只能删**：`box2d.wasm` / `mecanim.wasm`（保留 .br）/ `_to_rewrite/`（不会被 require）/ `_skipped/`（不会被 require）。
**绝不能删** `manifest.json` / `assets/inline/` / `subpackage-list.js` / `main-require-order.js` / `luna-wasm.json` / `*.wasm.br`，否则 asset-inject 提前 return → Luna `_loadSimpleAssetsAsync` 拿到 null Image → `Cannot read properties of null (reading 'complete')` → **黑屏**。

**3. 自动 chain extract-wasm.cjs**

postprocess 末尾会 `spawnSync('node', [extract-wasm.cjs, OUT])`，自动从 chunk 里抠出 box2d/mecanim WASM 落成 `.wasm.br`。失败（工程不含内嵌 WASM 等）退出 status=2，warn 不阻断。详见 §双层套娃。

**4. 自动识别 + 跳过 i18n analytics chunk**

luna 7.x 后期版本会把 base64 编码的 i18n 上报路径直接当 `<script>` 内容输出（chunk body 只有一行 base64 字符串字面量）。浏览器吞 ReferenceError 静默，但 wx 试玩 runtime 解析时会抛 → 启动期 `[E] is not defined` 噪音。postprocess 的 classify() 用规则 `/^\s*[A-Za-z0-9+/=]{40,300}\s*$/.test(body)` 识别 → 归入 `kind=='i18n_analytics'` → PLACEMENT='skip' → 不进 main-require-order → 不 require → 无错。

**5. 自动提取 loading logo + 进度条**（luna `<div id="application-preloader">` DOM 在 wx 试玩 runtime 不工作）

postprocess 解析 `lang_config` chunk 里的 `languageSettings` JSON，提取每个 locale 的 `loadingImgBase64` 落到 `assets/inline/loading-logo-<md5>.png`（多 locale 同图自动 md5 dedup, zh-CN/default 通常字节相同共用一份）。pngjs 可选依赖（`npm i -g pngjs`）：> 80KB 的 PNG 自动 resize 到 256×256（实测打怪升武器_unity 175KB → 67KB, -62%）。`manifest.loadingLogos` 写入索引让 first-screen.js 按 `wx.getSystemInfoSync().language` 选 logo。

**6. 自动 strip `lang_config` 里的 loadingImgBase64 冗余**（启动期最大头优化）

logo PNG 已落 `.png` 文件 + first-screen.js 路径加载，但原 `lang_config` chunk 里的 `loadingImgBase64` 字段值仍在（占整个 chunk 99.6% 体积）。base64 PNG 在 wx 试玩 runtime 下完全没用（DOM 不存在，luna 通过 SET_LOADING_IMAGE 调用挂 `<img>` 的逻辑被 _skipped/）。postprocess 提取后立即把字段值 strip 为 ""。

实测打怪升武器_unity:
- `lang_config.js` 564KB → 2.5KB（-99.6%）
- 主包 0.74MB → 0.20MB（-540KB）
- boot 链 JS parse 节省 200-500ms
- `setSource#1` 1.24s → 0.97s（-270ms 实测）

这是当前 skill 工具最大单点提速。

**game.json 不能写 `subpackages` 字段**：试玩 runtime 不支持 wx.loadSubpackage,且预览阶段 IDE 会校验 `subpackages[0].root` 必须有 game.js,我们用 require 直接进主包,所以 game.json 里**不能有 subpackages 字段**(写了 preview fail "未找到 subpackages[0]['root'] 对应的 /subpackage-bundle/game.js 文件")。模板已删,自动化生成时也不要回填.

实证（2026-05-06 打怪升武器_unity.html）：第一版 game.json 留 subpackages → preview 校验 fail；第二版删 subpackages → preview 通过但黑屏（17_bootstrap startGame patch 没注入，因 postprocess 写死 18_）；第三版手工注入 patch → 通过。这一坑后已根因修复，自动化跑无需手工补。

### dom-shim 启动期 UI warmup + resize dispatch（首次扫码首次触屏漂移修复）

**现象**：第一次扫码（wx 缓存全清）进游戏后**第一次**触屏 → 角色行进方向漂移 ~5-10 度，第二次触屏起正常 + 后续扫码全部正常。**unity 渠道（普通 web playable）完全正常 — 仅 wx 试玩广告 runtime 出现**。

**根因**：web 浏览器在 canvas 建立时自动 dispatch `resize` 事件让 luna PC.app 同步 Canvas Scaler viewport。**wx 试玩 runtime 不会自动 dispatch** → luna PC 第一帧用默认 viewport (推测 750×1334)，Canvas Scaler 第一帧 raycast 用错 viewport → 首次 OnPointerDown 路由错位 → 角色走错方向。

**修复**（dom-shim 末尾，commit 522528c）：
1. setInterval 50ms × 100 retry 直到 `UnityEngine.Input` 创建（luna runtime ready）
2. 调 `g.__warmupUIInject()`：装 read hook + 注入 `active=false` idle 状态让 luna 第一帧看到完整 Input 表面
3. 主动 dispatch 三个事件：`resize` / `orientationchange` / `visibilitychange`，传给 `GameGlobal._winBus.emit` + `globalThis.dispatchEvent` 双路径

注：dom-shim 注入坐标本身数学完全正确（CSS 像素 + Y 翻转 cssHeight=862），偏移在 luna scene EventSystem raycast 层。dom-shim 不能改 luna scene 内部，只能外围 dispatch 标准事件让 luna 自身重设状态。

**通用经验**：任何"web 上正常 + wx 试玩 runtime 上首次 bug"的现象，第一直觉先 dispatch 浏览器自动 emit 但 wx 不 emit 的事件（resize / orientationchange / pageshow / focus / blur 等）。

## 适配清单（按依赖顺序）

### 1. 抽 WASM 出来当静态文件
Luna 把 Unity 的两份 emscripten WASM（**Box2D ~168KB** + **Mecanim ~272KB**，具体 byteLength 因 Unity 版本会变）当 `data:` URI 内联在 chunk 里。试玩 runtime 不能从 buffer instantiate，必须落成静态文件。

- 工具：`extract-wasm.cjs`（在 luna 工程里跑，**postprocess.js 末尾会自动 spawn**，无需手工调用）
- 输出：`box2d.wasm.br` / `mecanim.wasm.br` + `luna-wasm.json` manifest
- 命名约定要和 dom-shim 的 `_wasmFiles` 表对得上（按 byteLength 索引；luna 7.x 至今实测 168334 / 271539，跨 channel/工程稳定）
- 主包加这两个文件后包大小通常仍在 5MB 内（Luna 主 JS 被 br 后约 1MB，两份 WASM br 后约 60+85KB）

#### 双层套娃（luna 7.x 之后）

老 luna：WASM 直接以 `data:application/octet-stream;base64,AGFzbQ...` URI 形式塞在 chunk 里，grep 一发命中。

新 luna 7.x：WASM 仍是内层 base64 URI，但**外层多了一层 brotli + base122 包装**——藏在某个 `decompressString("...")` 调用的 base122 字符串字面量里。直接 `grep AGFzbQ` 在原 HTML/chunk 上 0 命中。必须先 `eval(brotli runtime.js)`、再调 `decompressString(payload)` 解出 latin1 文本（典型 6.8MB），**然后**在那段文本里 grep `data:application/octet-stream;base64,AGFzbQ`。

`extract-wasm.cjs` v2 自动覆盖两条路径：
- 路径 A（老 luna）：直接扫 chunk body 找 data URI WASM
- 路径 B（新 luna）：`decompressString` payload 解码 → 再扫内嵌 data URI

并兼容 sync + async（新 luna 的 `decompressArrayBuffer` 返回 Promise）。

不写死 `04_brotli.js` / `14_compressed_asset.js`：扫 `luna-runtime/` 找含 `decompressArrayBuffer=` 的 chunk 当作 brotli runtime；扫 `subpackage-bundle/` 全部 chunks 找 WASM。不同 luna 版本 chunk 序号漂（02/04 brotli + 11..14 compressed_asset 都见过），按内容嗅探不按文件名硬编码.

实证（2026-05-06 打怪升武器_unity.html）：原 HTML grep `AGFzbQ` 0 命中 → 第一版以为不含 WASM 跳过 extract → 真机 dom-shim WASM-SHIM `len=168334/271539` 触发但 redirect 文件不存在 → `load wasm failed` 黑屏。第二版扫 `decompressString` payload 找到 → 抠出 box2d/mecanim → 真机过.

### 2. dom-shim 必备表面
dom-shim.js 必须在 game.js 入口最早 require，至少补齐：

| 类别 | 项 | 备注 |
|---|---|---|
| 全局 | `window`/`self` = `GameGlobal` | |
| 全局 | `location` | 带 `search/hostname/protocol`，Luna 用 `URLSearchParams(location.search)` 读 `?soyoo_lang=...` |
| 全局 | `URLSearchParams` | 自己实现，标准 web API runtime 没有 |
| 全局 | `crypto.getRandomValues` / `randomUUID` | Luna webpack uuidv4 依赖 |
| 全局 | `_compressedAssets = []` | Luna ready_glue 等这数组（无分包时给空） |
| WebAssembly | `RuntimeError` / `CompileError` / `LinkError` | playable runtime 没暴露成构造函数 |
| WebAssembly | `instantiate` 重定向（核心） | 见 §3 |
| document | `addEventListener` / `dispatchEvent` / `querySelectorAll` / `getElementById` / `createElement` | + body / head / documentElement / canvas 都需要 `addEventListener` |
| 其他 | `Event`, `Blob`, `URL.createObjectURL`, `localStorage`, `navigator`, `requestAnimationFrame`, `performance` | 见 dom-shim.js 模板 |

`document.addEventListener` 不够——`document.body` / `documentElement` 等子对象也要补 `addEventListener`，否则 playable-libs 在 `wx.onShow/onHide` "manually adapt" 路径会炸。

### 3. WASM 重定向：`WebAssembly.instantiate(buf, imp)` → `WXWebAssembly.instantiate(path, imp)`

**根因（千万别再走错路）**：试玩 runtime 把全局 `WebAssembly.instantiate` 桥接到 `WXWebAssembly.instantiate`，**且 WXWebAssembly 内部 at-runtime 解析 `globalThis.WebAssembly.instantiate` 回调**。如果 dom-shim 把 `WebAssembly.instantiate` monkey-patch 成自己的 redirect 函数，路径调用会 redirect 回我们 → 重新触发 → **无限递归 → `RangeError: Maximum call stack size exceeded`**。

**正确解法**（dom-shim 里这一段一字不能错）：

```js
const _origInstantiate = g.WebAssembly.instantiate;
const _ourShim = function (arg, imports) {
  if (typeof arg === 'string') return _origInstantiate.apply(this, arguments);
  // buffer 路径：抓 byteLength → 查表
  const bytes = arg instanceof ArrayBuffer ? new Uint8Array(arg)
              : (arg && arg.buffer) ? new Uint8Array(arg.buffer, arg.byteOffset||0, arg.byteLength) : null;
  const file = _wasmFiles[bytes && bytes.length];
  if (!file) return Promise.reject(new Error('unmapped WASM length=' + (bytes && bytes.length)));
  // 关键：临时 unpatch 切断递归，emscripten 一次成功后永不重 patch
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      g.WebAssembly.instantiate = _origInstantiate;
      _origInstantiate.call(g.WebAssembly, file, imports).then(resolve, reject);
    }, 0);
  });
};
g.WebAssembly.instantiate = _ourShim;
```

- 直接传 emscripten 的**原 imports**（unpatch 后）就能成功；不需要 noop 替换或 arity 重构造
- 如果你看到自己在写 `mode === 'noop-arity-strict'` 这种特定模块的 hack，**停**——要么递归没真切断，要么字节没匹配上
- **`setTimeout(0)` 不是装饰**：直接 `_origInstantiate.call(...)` 在同一调用栈里仍可能被 wxgame-playable-lib 的同步重 patch 抢回。setTimeout 把调用推到下一个 microtask 之后，`g.WebAssembly.instantiate = _origInstantiate` 那一行是在新的栈上执行，确保从此以后所有 instantiate 走原版（emscripten 一次成功即终结）。
- **`__WASM_IMPORT_MODE` 排查 escape hatch**：dom-shim 留了 `globalThis.__WASM_IMPORT_MODE` 切换 `pass / clean / noop / noop-arity` 几种 imports 包装策略，仅在调试 imports 不匹配时打开。生产路径走默认 `pass`。

### 4. main-require-order：JSON 转 .js
微信试玩 `require('./x.json')` 抛 `module "x.json.js" is not defined`。所有 Luna manifest/order JSON 包成：

```js
// main-require-order.js
module.exports = [
  './luna-runtime/00_lang_config.js',
  // ...按 Luna chunk 输出顺序
];
```

### 5. 取消分包，全部塞主包
`wx.loadSubpackage` 在试玩 runtime 不存在。把 Luna 的 `subpackage-bundle/12_compressed_asset.js` / `13_*` / `14_*` 直接 `require()` 进主包。如主包超 5MB，先在 cleaner 里去掉冗余：去 PWA service worker、去 source map、去 polyfill 重复加载。

### 6. Canvas 双单位尺寸（CSS 像素 vs 物理像素）

`wx.createCanvas()` 默认返回 2x2 — PlayCanvas 看到无效尺寸不启动渲染循环，黑屏。dom-shim 必须显式设：

- `canvas.width = cssWidth * dpr`、`canvas.height = cssHeight * dpr` —— **物理像素**（backbuffer 真实分辨率）
- `canvas.clientWidth/Height/offsetWidth/Height/getBoundingClientRect` —— 必须返**CSS 像素**

**为什么要双单位**：PlayCanvas 内部 `backbuffer = clientWidth * devicePixelRatio`。如果 clientWidth 也返物理像素，会 `physical * dpr * dpr` → 每帧翻倍 → 爆显存。

dom-shim.js L52-72 一次性从 `wx.getSystemInfoSync()` 取 `pixelRatio/windowWidth/windowHeight`，写到 `g._screen = {cssWidth, cssHeight, dpr}`，下游 `clientWidth/Height` getter 都从这读。同时填好 `g.devicePixelRatio / innerWidth / innerHeight / outerWidth / outerHeight / screen`。

**canvas.addEventListener 必须自己接管 `_bus`**：`wx.createCanvas()` 返回的对象自带 addEventListener，但那是 playable-libs 包装的有 bug 版本（内部 `fi(...).addEventListener` 抛 TypeError）。必须无脑覆盖成自家 bus（`__canvasBus.on/off/emit`），PC `TouchDevice.init` 注册 `touchstart/move/end/cancel` + `webglcontextlost` 等都走 bus 才安全。

### 7. game.js 入口典型流程

```js
try { wx.setEnableDebug({ enableDebug: true }); } catch (e) {}  // 试玩预览菜单没"打开调试"按钮，强开

require('./luna-to-wx/dom-shim.js');         // 必须最先
require('./first-screen.js');                // 占位首屏
const order = require('./main-require-order.js');
for (const rel of order) {
  try { require(rel); } catch (e) { console.error('require fail:', rel, e); }
}
// inline 原本要走分包的资源 chunk
['./subpackage-bundle/12_compressed_asset.js', /* 13,14 */].forEach(r => require(r));

GameGlobal._dispatchReady && GameGlobal._dispatchReady();  // 主包加载完显式 dispatch DOMContentLoaded
require('./luna-to-wx/asset-inject.js');     // 资源喂入
require('./luna-to-wx/wx-ad-bridge.js');     // wx.onShow/onHide → luna lifecycle
GameGlobal.dispatchEvent(new GameGlobal.Event('luna:build'));
```

## 音频桥接（v19c → v19e）

dom-shim 的 `AudioShim` (= HTMLAudioElement) 和 `AudioContextShim` (= WebAudio) 都桥接到 `wx.createInnerAudioContext()`。三个**致命坑**，每一个都让声音消失，而且报错形态完全不一样：

### 坑 1：`wx.arrayBufferToBase64` 是空 stub（v19c 修）

playable-libs 2.0.15 里这个 API 存在但**返回输入 ArrayBuffer 自身**（truthy 非字符串）。直接拼 data URI 会变成 `'data:audio/mpeg;base64,[object ArrayBuffer]'` 之类，喂给 `wx.createInnerAudioContext().src` 后，wxgame-playable-lib 内部 `atob()` 抛 `InvalidCharacterError`，全程**静默无声 + promise rejection**。

**修法**：`AudioContextShim.decodeAudioData` 里用纯 JS 三字节循环编码器（dom-shim L1153-1166）。**不要**用 `btoa(String.fromCharCode.apply(null, u8))` —— 大数组会 RangeError。

```js
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let s='', i=0, n=u8.length;
for (; i+3<=n; i+=3) { const v=(u8[i]<<16)|(u8[i+1]<<8)|u8[i+2];
  s += A[(v>>18)&63]+A[(v>>12)&63]+A[(v>>6)&63]+A[v&63]; }
const r=n-i;
if (r===1){const v=u8[i]<<16; s+=A[(v>>18)&63]+A[(v>>12)&63]+'==';}
else if (r===2){const v=(u8[i]<<16)|(u8[i+1]<<8); s+=A[(v>>18)&63]+A[(v>>12)&63]+A[(v>>6)&63]+'=';}
```

### 坑 2：iOS 默认互斥（v19d 修）

新 `wx.createInnerAudioContext().play()` 默认**中断**已经在播的另一个 InnerAudioContext。BGM 听到第一个 SFX 就死。一次性调：

```js
wx.setInnerAudioOption({ mixWithOther: true, obeyMuteSwitch: false });
```

放在 `AudioContextShim` 构造函数 + `AudioShim.ensure()` 双入口（用 `GameGlobal.__XXAUDIO_sessionInit` guard idempotent）。

### 坑 3：gain 链必须**实时联动** `_inner.volume`（v19e 修）

PlayCanvas SoundManager 的 fade-in/out 通过 `gain.gain.setValueAtTime/linearRampToValueAtTime` 改 gain 链值。BGM 重启时 gain 一度被设为 0（淡入起点），如果只在 `source.start` 时刻读一次 vol → BGM `_inner.volume` 锁死在 0，gain 涨回来音量不跟随 → BGM **可见但不可闻**（vol=0.00 重播日志）。

**修法**：
- `createGain` 维护 `_sources: []` 列表
- `source.connect(targetGain)` 时沿 connect 链 16 hops 把自己 push 进每个下游 gain 的 `_sources`
- `gain.value / setValueAtTime / linearRampToValueAtTime` 任一变更 → 遍历 `_sources` 实时调 `src._inner.volume = src._chainVol()`
- `source.loop` 改成 setter，late-set `source.loop=true` 也推到已起的 `_inner.loop`
- `source.disconnect` 摘除注册

### 调试套路

dom-shim 末尾 `[XXAUDIO]` 探针（instantiate / decode bytes/mime/b64Len / play vol/loop/bytes/mime / ended / error / stop / gain#N old→new）配合 HTTP probe（见下节）拉真机日志。

定位顺序：
1. `decode b64Len=undefined` 或 `b64Len=!str:object` → 坑 1（base64 编码失败）
2. `play loop=true` 但播放时长 < 文件长度 → 坑 2（互斥被打断）或 underlying mp3 被截断
3. `play vol=0.00` 重播 → 坑 3（gain 锁死）
4. `error bytes=X err={...}` → wx InnerAudioContext 实际错误，看 `errCode`

**复用提示**：v19e 的 AudioShim/AudioContextShim 整段直接拷到下个 Luna 试玩。USER_DATA_PATH 落盘那条路（5/3 写过）**不要走**——data URI base64 是已验证唯一路径。

## 视频桥接（v20 — wx.createVideoDecoder + texImage2D wrap）

Luna 的 `VideoTexture` 走 `Network.GetVideoAsync → pc.Texture.setSource(videoElement)`，PC 内部 `gl.texImage2D(target, level, ifmt, fmt, type, source)` 6 参形态。wx 试玩 runtime 的 GL 实现**只认 `wx.createImage` / `wx.createCanvas` 返回的真实对象**，不认 video proxy → `Failed to execute 'texImage2D': invalid pixels`。

**整体策略**：用 `wx.createVideoDecoder().getFrameData()` 拿到 RGBA `ArrayBuffer`，dom-shim wrap GL ctx 的 `texImage2D` / `texSubImage2D`，检测 `_isLunaVideo` 后改走 9 参 byteView 形态调原版。这样 PC 把 video 当普通纹理，无需感知是 video 源；每帧 PC 复用 setSource 触发 upload 时我们顺势 pull 最新帧。

### 坑 1：PC 不会主动 re-upload 视频纹理（v20 修）

PC 的 `Texture.setSource(t)` 只在 `t !== this._levels[0]` 时把 `_levelsUpdated[0]=true`，之后 uploadTexture 一次后清零，**永不再 re-upload**。Luna 的 `VideoTexture` (class `Dn extends Texture`) 没 per-frame upload 钩子（无 `requestVideoFrameCallback`，无 `update()` method）。表现：`setSource(videoProxy)` 后**只 upload 一次** → 视频卡在第一帧。

**修法**：wx-ad-bridge 加 `dirtyTimer` 33ms 反复调 `tex.dirtyAll()`（= `_needsUpload=true` + `_levelsUpdated[0]=true`），PC 下一次 uploadTexture 时走 texImage2D(target, ..., proxy) → GL wrap 拉新帧 → 视频动起来。`startVideoDirtyTimer` 在 setSource hook 里第一次见 `_isLunaVideo` 时启动。

### 坑 2：PC render loop spinup 慢于 video duration（v20 deferred-start 修）

视频常常很短（实测 1066ms / fps 30 / ~32 帧 = 典型 UI intro 动画）。但 luna:build 触发到 PC 第一次调 `_pullFrame` 之间约 **800-1500ms**（PC.Application 构造 + scene init + first render frame）。如果 video decoder 在 setSource 时立即 start，等 PC 第一次 _pullFrame 时 video 已经播完 → ended → paused=true → 用户感知"只看到一帧"。

**dirtyTimer + paused skip 的死循环**：之前的逻辑 `if (src.paused === true) continue;`，video ended → paused=true → dirtyTimer 永远 skip → texture 永远定格。

**修法（双管）**：
1. **deferred-start**：`load()` 不立即 `dec.start()`，只设 `_wantsStart=true`。等 PC 第一次 `_pullFrame` 时（= PC render loop ready 信号）才触发 `dec.start()`。这样 video 1066ms 完整对齐 PC render 窗口。
2. **dirtyTimer 不再 skip paused**：即使 paused 也 dirty，让 PC 持续 upload 当前 latestFrame（视觉上保留最后一帧而不是黑掉）。

```js
// asset-inject 视频 proxy
load() {
  this._ensureDecoder();
  this._wantsStart = true;        // 不立即 dec.start, 等 PC 来要帧
  setTimeout(() => onloadeddata + oncanplay, 0);  // PC 资源加载流水不阻塞
}
_pullFrame() {
  if (this._wantsStart && !this._decoderStarted && !this._startInFlight) {
    this._ensureDecoderStarted();   // 第一次 PC pull → 触发 dec.start
  }
  // ... getFrameData() 即使 paused 也试 (ended 后 wx 仍可能有 buffered frame)
}
```

### 坑 3：abortAudio 决策 — auto-restart loop ↔ 1-shot

试图让画面 loop 起来"持续动"，会让 wx decoder 内嵌音轨也跟着 loop → 用户感知"音频反复播放" + 音画错位。三种模式实测对比：

| 模式 | 画面 | 音频 | 适用场景 |
|---|---|---|---|
| auto-restart loop + abortAudio:false | 循环动 | **反复播放** ✗ | 不可用 |
| auto-restart loop + abortAudio:true | 循环动 | 视频音轨完全消失 | 视频是装饰元素 |
| **1-shot + abortAudio:false** ✓ | 完整播 1 次后定格 | **音轨完整播 1 次** | 通用最优 |

deferred-start 让 1-shot 模式下 PC 也能完整 upload ~30 帧，画面+音轨 1 秒动画完整呈现。

### 坑 4：first frame race（_pollFirstFrame vs PC first pull）

`_pollFirstFrame()` 16ms tick × 60 attempts 后台轮询拉首帧填 `videoWidth/Height`。如果 PC 第一次 `_pullFrame` 时 wx decoder 还没准备好首帧（启动 latency ~30-80ms），返回 null；GL wrap 检测到 null 直接 skip 这次 upload，下一帧再来。**不要在 null 时 reject 或 throw**，PC 容忍 deferred upload。

### 调试套路

dom-shim / asset-inject / wx-ad-bridge 已经埋了完整探针：
- `[video-proxy] decoder start: {duration, fps, width, height, ...}` — wx 给的 video metadata
- `[video-proxy] first frame WxH attempts=N` — _pollFirstFrame 拿到首帧
- `[video-proxy] deferred-started ID at PC-pull-trigger` — dec.start 实际触发时刻
- `[video-pull-trigger#N]` — PC 第一次 _pullFrame
- `[video-pull#1/10/30/100/300]` — 采样 frameUpdates / nullPolls / errs / lastPts / hasLatest
- `[video-tex6#1/10/30/100/300]` / `[video-tex9#...]` — PC 实际 texImage2D 调用次数 + frame 状态
- `[dirty-tick#1/10/30/60/150/300]` — 33ms tick 状态：dirtied / skippedPaused / viaDirtyAll
- `[video-proxy] decoder ended (1-shot)` — 1 秒视频结束

**定位顺序**：
1. `decoder start: ...` 没出 → wx.createVideoDecoder 失败/不可用
2. `first frame ... attempts=` 没出 → wx 解码失败（mp4 编码不兼容？source 路径错？）
3. `deferred-started` 没出但 `[video-pull-trigger]` 出了 → `_ensureDecoderStarted` 失败（看 warn）
4. `[video-tex6#1] hasFrame=false` 持续出 → PC 在 video ended 之后才 pull（启动慢，已经是 deferred-start 修的场景）
5. `[dirty-tick#N] dirtied=0 skippedPaused=N` → texture 全 paused，dirtyTimer 无效（应该已经 fix 了）

## 启动期性能（v20 — 4.5s → ~3s）

试玩广告启动慢的真凶**不在 luna runtime parse**（小 .js 都是 ms 级），而在三个 wx event loop 抢占点。

### 坑 1：`wx.setEnableDebug({enableDebug:true})` 占 200-500ms

vConsole 在试玩 runtime 启动期 hook 全 console + 加载 vConsole UI 资源。**生产路径关掉**——HTTP probe（dom-shim 内 wrap console → 53017）独立工作，不依赖 vConsole。

```js
// game.js 入口
// try { wx.setEnableDebug({ enableDebug: true }); } catch (e) {}  // 生产关
```

调试时改回 true。试玩广告本来就没"打开调试"按钮，vConsole UI 在真机不可视，**setEnableDebug 真正作用只在 wx 内部 console 路径**——关了不影响我们的诊断。

### 坑 2：game.js 自己的 `wrapConsoleForProbe` 同步打 wx.createImage 占 ~1s

之前 game.js 有一段：
```js
GameGlobal.PROBE_URL = 'http://192.168.1.3:38080/log';
console.log = function() {
  ...
  wx.createImage().src = PROBE_URL + '?m=' + ...;  // 同步！
};
```

启动期 ~50 条 console.log = ~50 次 sync `wx.createImage()` 调用，每次都进 wx 网络栈（**而且 38080 通常没 server，全失败**）。

**修法**：删除整段。dom-shim L31-79 已经 wrap console → 53017，**fire-and-forget Image transport + buffer + setInterval 20ms 拍发**——不阻塞。两套并存是浪费。

### 坑 3：splash 用 setInterval 抢 GPU 队列 → 拖慢 luna init 600ms-2.7s

first-screen.js 如果用 `setInterval(50ms, frame)` 持续画 splash 进度条，每帧 GL `clear / scissor / clear` 4 次进 wx GPU 队列。**实测**：
- 不用 splash：18_bootstrap require ~3ms
- splash setInterval 50ms：18_bootstrap require **2.7 秒**
- splash 单帧（无 timer）：18_bootstrap require ~3ms

luna PC InitializeAsync 内部用 GPU 队列做纹理上传 / WASM init，splash setInterval 抢占 → luna init wait → require 链 hold。

**修法**：splash **只画 1 帧**，静态进度条。深色背景 + 半填进度条已经是足够的"在加载"视觉反馈。

```js
// first-screen.js
(function bootSplash() {
  const c = GameGlobal.canvas || (GameGlobal.canvas = wx.createCanvas());
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return;
  // 设 viewport / clearColor / clear / scissor 1 次, 不 setInterval, 不 setTimeout 链.
  // luna 起来后 PC 自己接管 GL ctx, 自然覆盖.
})();
```

### 不能优化的固有开销（实测下限）

| 阶段 | 时长 | 原因 |
|---|---|---|
| game.js entry → require main scripts | ~30-100ms | dom-shim parse |
| 14 个 luna-runtime require | ~50ms | 每个 .js 几个 ms |
| **18_bootstrap → 19_pi_runtime** | **~2 秒** | **luna PC.Application + WASM + scene init** |
| 19_pi_runtime → luna:build | ~250ms | inline subpackage + asset-inject + wx-ad-bridge |
| luna:build → setSource#1 | ~250-400ms | PC graphicsDevice 初始化 |
| setSource#1 → video first frame | ~1.5 秒 | PC render warmup + video deferred-start 解码 |

总从 game.js entry 到第一帧 ≈ **3-3.5 秒**（最优）。从扫码到画面再加 wx 试玩 runtime 启动 + 包下载 1-2 秒 → 用户感知 4-5 秒。**进一步加速只能从减小包体（图片/视频压缩）或 luna 引擎层优化**，超出 dom-shim 边界。

### 关键时刻表（参考）

| 阶段 | 累积时间 | 视觉 |
|---|---|---|
| game.js entry | T+0 | 黑屏 |
| dom-shim done | T+50ms | 黑屏 |
| first-screen splash 画完 | T+70ms | **深蓝 + 进度条** ← 用户首次反馈 |
| luna:build dispatched | T+2.5s | splash 仍在 |
| setSource#1 → splash 停 | T+2.7s | luna 接管，可能短暂闪 |
| video first frame upload | T+4.5s | **正式画面** |

splash 在 T+70ms 出现已经把"黑屏感"压到最低（其余时间都看得到内容）。再快只能优化 dom-shim parse 时间（几十 ms 级，不显著）。

## HTTP probe：绕 wx 域名白名单看真机日志

试玩广告 vConsole 在真机不可视，`wx.request` 受域名白名单限制。绕开方法：dom-shim 接管 `console.log/warn/error/info`，把 message 通过 HTTP GET 发到 LAN 内的 probe server。

### v20.12 fire-and-forget 模式（生产路径，实测稳定）

经过 v20.6 → v20.12 七版本血泪迭代，下面是**已知唯一稳定**的 probe 客户端模式。任何偏离都会落到 7 个已知失败根因中（详见 `project_luna2wechat_probe_pipeline.md`）。

```js
const PROBE_HOST = '192.168.1.3:53017';   // wx-build LAN IPv4，绝不能用 Tailscale 100.x
const _spamPatterns = [/escapeGuideCount/, /Skipping event sample/, /^\[XXAUDIO\] gain#/];
const _buf = [];
function pushLine(line) {
  for (const p of _spamPatterns) if (p.test(line)) return;   // 启动期 burst 短，spam 会挤掉关键日志
  _buf.push(line);
}
function fireOne(line) {
  const url = 'http://' + PROBE_HOST + '/log?m=' + encodeURIComponent(line.slice(0, 1500));
  try { const img = wx.createImage && wx.createImage(); if (img) img.src = url; } catch (e) {}
  try { if (wx.request) wx.request({ url, method: 'GET', enableHttp2: false, enableCache: false }); } catch (e) {}
}
// 5 行 / 20ms = 250 行/秒；跟得上启动 burst 又不打爆 wx 内核
setInterval(() => { let n = 5; while (n-- > 0 && _buf.length > 0) fireOne(_buf.shift()); }, 20);
```

四条硬约束（任一违反 = 启动期日志全丢）：
- **必须 `wx.createImage()`**，不是 `new Image()` —— 试玩 runtime 的 globalThis 不一定桥到 GameGlobal
- **fire-and-forget**：不挂任何 callback，`wx.request` 的 `complete` 在试玩 runtime 不可靠
- **本地 setInterval drain**：完全不依赖远端反馈推进队列
- **单 host + 双 transport**：multi-host round-robin 一旦有一个不可达就拖死整条队列

### probe server v3（仓库 `deploy/probe_server_v3.js`）

支持 `GET /log?m=...` + `POST /batch` 双路径，listen `0.0.0.0:53017`，写文件 `C:\Users\Nick\probe.log`。

部署：`scp deploy/probe_server_v3.js wx-build:C:/Users/Nick/probe_server_v3.js` → schtasks 启动（**必须** schtasks，不能直接 ssh node 启动，详见排查清单 #1）。完整 schtasks 命令模板在 `project_luna2wechat_probe_pipeline.md`。

### 7 条已知失败模式（probe 不出日志时按序排查）

完整诊断在 `project_luna2wechat_probe_pipeline.md`，速查：

1. VS Code SSH tunnel 抢占 `127.0.0.1` → probe server **必须 schtasks 启动**脱离 SSH 会话；`Get-NetTCPConnection -LocalPort 53017` 必须 `0.0.0.0`
2. 手机不在 Tailscale → 用 `ipconfig` LAN IPv4，不要 `100.x`
3. wx.request 默认并发上限 ~5-10 → 单 host + Image 主路
4. wx.request `complete` callback 不可靠 → 不依赖 callback 推进队列（fire-and-forget）
5. stalled 不可达 host 拖死 round-robin → 单 host
6. 启动期稳态 spam 挤掉关键日志 → 源头 `_spamPatterns` 过滤
7. 截图/vConsole 当退路 → **硬纪律：强迫修通 probe**，两次扫码拿不到日志立刻停下按 1-6 排查

### 抓日志循环

```bash
# 一次性：启动 probe server（schtasks 脱离 SSH）
ssh wx-build 'powershell -Command "schtasks /Delete /TN ProbeServer /F 2>$null; schtasks /Create /SC ONCE /ST 23:59 /TN ProbeServer /TR ''cmd /c node C:\\Users\\Nick\\probe_server_v3.js > C:\\Users\\Nick\\probe-stdout.log 2>&1'' /F; schtasks /Run /TN ProbeServer"'
ssh wx-build 'powershell -Command "Get-NetTCPConnection -LocalPort 53017 | Select State,LocalAddress"'   # 期望 0.0.0.0

# 每轮 build
ssh wx-build 'powershell -Command "Remove-Item C:\\Users\\Nick\\probe.log -ErrorAction SilentlyContinue"'
# … 改 dom-shim → scp → preview → 用户扫 …
scp wx-build:C:/Users/Nick/probe.log /tmp/probe-vXX.log
```

## 部署 / 预览循环

测试机：Windows，tailscale 主机名 `wx-build`，AppID `wx21647eaf197e9b58`，工程路径 `C:\Users\Nick\luna-wx-test`。详见 `reference_wx_build_host.md`。

**wxcli.bat wrapper**（已建在 `C:\Users\Nick\wxcli.bat`，封装中文路径下的 cli.bat）：

```bat
@echo off
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" %*
```

**SSH 编码限制**：tailscale ssh 转发对中文路径不可靠，所以才需要 wrapper。

**完整循环**：

```bash
# 1. 同步改动
scp local/dom-shim.js wx-build:C:/Users/Nick/luna-wx-test/luna-to-wx/dom-shim.js
# (其他改动同理)

# 2. 杀掉残留 devtools 进程（端口被占会报 IDE may already started ... wait timeout）
ssh wx-build 'powershell -Command "Get-Process wechatdevtools -ErrorAction SilentlyContinue | Stop-Process -Force"'

# 3. 鉴权过期会报 INVALID_TOKEN code 10 — 重新登录，让用户扫
ssh wx-build 'cmd /c "C:\\Users\\Nick\\wxcli.bat login --qr-format image --qr-output C:/Users/Nick/luna-wx-login-qr.png"'
scp wx-build:C:/Users/Nick/luna-wx-login-qr.png /tmp/luna-wx-login-qr.png  # 给用户看 → 扫

# 4. 生成预览二维码
ssh wx-build 'cmd /c "C:\\Users\\Nick\\wxcli.bat preview --project C:/Users/Nick/luna-wx-test --qr-format image --qr-output C:/Users/Nick/luna-wx-test-qr.png"'
scp wx-build:C:/Users/Nick/luna-wx-test-qr.png /tmp/luna-wx-test-qr.png   # 给用户扫

# 5. 用户扫 → 真机 vConsole 截日志贴回
```

**别忘了加 `--qr-format image`**，否则生成的是 ANSI 转义不是真 PNG，前面好几次浪费时间在这上面。

### 异步预览 wrapper（绕 ssh 阻塞）

ssh 直接跑 `cli.bat preview` 容易长时间阻塞（cli 内部要等 IDE fork 子进程，ssh 流挂住）。把整条命令塞进 schtasks 的一次性任务，让 IDE 在 Windows 本地以独立进程跑，ssh 立刻返回，再 scp 抓输出/二维码。模板（已部署 `wx-build:C:\Users\Nick\preview-v18.ps1`）：

```powershell
$project = 'C:\Users\Nick\luna-wx-mg'
$qr = 'C:\Users\Nick\preview-qr-v18.png'
$info = 'C:\Users\Nick\preview-info-v18.json'
$out = 'C:\Users\Nick\cli-preview-v18.out'
$cmd = "cmd /c D:\wechatDev\cli.bat preview --project $project --qr-format image --qr-output $qr --info-output $info > $out 2>&1"
schtasks /Delete /TN PreviewV18 /F 2>$null | Out-Null
schtasks /Create /SC ONCE /ST 23:59 /TN PreviewV18 /TR "$cmd" /F | Out-Null
schtasks /Run /TN PreviewV18 | Out-Null
Start-Sleep -Seconds 50
Get-Content $out -ErrorAction SilentlyContinue
if (Test-Path $qr) { Write-Host "QR: $((Get-Item $qr).Length) bytes" } else { Write-Host "QR not generated" }
```

调用：`ssh wx-build 'powershell -File C:\Users\Nick\preview-v18.ps1'` → 50s 后回输出 + 检查 QR。如果 QR 没生成多半是 **fork process timeout**（IDE 守护进程内部炸），这是已知 wx-build 故障——见 `project_luna2wechat_preview_fork_timeout.md` 的备用方案清单（清 IDE 缓存 / 升级 cli / 改 IDE GUI / 改 upload 体验版）。

## 常见错误解码表

| 报错 | 原因 | 修法 |
|---|---|---|
| `RangeError: Maximum call stack size exceeded` 在 WASM 加载 | monkey-patch 递归（见 §3） | unpatch-before-call |
| `WXWebAssembly.instantiate: only support file type .wasm or .wasm.br` | 给 buffer 没给路径 | extract-wasm + dom-shim 重定向 |
| `module "x.json.js" is not defined` | require 了 .json | 包成 `module.exports = ...` 的 .js |
| `wx.loadSubpackage is not a function` | 试玩没分包 | 直接 require 进主包 |
| `fi(...).addEventListener is not a function`（来自 wxgame-playable-lib.js） | dom-shim 上某 DOM 子对象（body/head/documentElement/canvas）漏了 `addEventListener` | 给所有这些子对象都补一个 emitter |
| `Bridge is not defined` | Luna runtime 没初始化（多半是上游错误链导致），看上一条更早的 FAIL | 修上游 |
| `Luna.Unity.Playable 未就绪` | 同上 | |
| `writeFileSync() is not implemented on FileSystem` | 没可写 FS | console capture 改纯内存或直接禁用 |
| `INVALID_TOKEN` / `code 10` | 微信开发者工具登录过期 | wxcli.bat login |
| `IDE may already started ... wait IDE port timeout` | 上次 devtools 进程残留 | 先 Stop-Process |
| `InvalidCharacterError at atob (node:buffer:1294:13)` 在 wxgame-playable-lib | data URI base64 部分非法 | 检查 base64 是不是字符串（playable-libs 的 `wx.arrayBufferToBase64` 是返 ArrayBuffer 的空 stub）—— 改用纯 JS 编码器 |
| BGM 听到第一个 SFX 就消失 | iOS 默认 InnerAudioContext 互斥 | `wx.setInnerAudioOption({mixWithOther: true, obeyMuteSwitch: false})` |
| BGM 重启时 vol=0 死寂 / 部分音效永远 0 音量 | gain 链 fade 中途值 0，源 _inner.volume 锁死 | createGain 维护 _sources 列表，gain 设值时实时回填 _inner.volume |
| `n.complete is not settable` / 资源永远 loading | wx Image.complete 是 readonly getter | defineProperty 改 getter 返 true，失败 fallback 直接赋值 |
| 摇杆释放后角色不停 | touchend 立刻置 active=false，EventSystem 跳过 OnPointerUp | 3-tick keepalive grace（endedTickCount 倒数） |
| 黑屏但 vConsole 无错 | canvas 默认 2x2 / clientWidth 返了物理像素导致 backbuffer 翻倍 | 显式设 canvas.width = cssWidth*dpr，clientWidth getter 返 CSS |
| `[E] ReferenceError: <长 base64 字符串> is not defined` 启动期 | luna 7.x i18n analytics chunk 把 base64 编码的上报路径当 `<script>` 内容输出, wx 解析为 identifier 引用 | postprocess.js 已自动识别 (kind='i18n_analytics') 归 _skipped/, 老工程要手动移到 _skipped/ 并从 main-require-order 删 |
| `[W] request() is not implemented on wx` / `[W] setInnerAudioOption() is not implemented on wx` | 试玩 runtime 把这些 wx API 实现为 throwing stub, 进函数体即 console.warn | dom-shim 早期用 `Object.defineProperty(wx, k, {value: noop, writable: true, configurable: true})` 强行替换 (直接赋值 silently fail, 因为 non-writable) |
| `game.json: 未找到 ["subpackages"][0]["root"] 对应的 /subpackage-bundle/game.js 文件` 预览 fail | game.json 里残留 subpackages 字段, 但试玩 runtime 不支持分包, 子包没自己的 game.js | 删掉 game.json 里 `subpackages` 字段, 所有 chunk 用 require 进主包 |
| `[WASM] redirect len=N -> box2d.wasm.br` 后 `load wasm failed` 黑屏 | dom-shim 表里有 byteLength 映射但 .wasm.br 文件没落盘 | 跑 extract-wasm.cjs 抠 WASM (postprocess.js 已自动 chain). 如果 grep 原 HTML 0 命中 `AGFzbQ`, 多半是新 luna 的 base122+brotli 双层套娃,需要解 decompressString payload 再扫 |
| 「CTA 按钮没反应」/ 「`wx.notifyMiniProgramPlayableStatus({isEnd:true})` 不生效」 | (a) typo: `Playablestatus` 小写 s → undefined → 静默；(b) 预览环境调用成功但**不绘结束页 UI** (微信侧设计,线上投放才绘) | (a) 改成 `PlayableStatus` 大 S；(b) probe 看 `[wx-ad-bridge] notifyMiniProgramPlayableStatus({isEnd:true}) sent` — 出现就是客户端 OK,UI 缺失是预期; 真要验 UI 必须线上投放 |

## 试玩结束信号（CTA → wx.notifyMiniProgramPlayableStatus）

试玩 runtime 上 `wx.notifyMiniProgramPlayableStatus({isEnd:true})` **真实存在且执行成功**（2026-05-06 升武器_unity probe 实证：4 次点击全部 `sent`）。**不在** runtime 缺失清单里。

但**预览环境**（开发者工具扫码）**不绘结束页 UI**——这是微信侧设计：
- 调用层（probe 看到 `sent`）✓ 在预览生效
- UI 层（微信内核绘"安装/试玩更多"页）✗ 仅线上广告投放才绘

两层独立。"按钮没反应"通常是把 UI 缺失当成 API 失败，看 probe log 一秒辨。

**典型路径**（参考 `wx-ad-bridge.js` `endUnityGame` + `doJump`）：

```
Unity CTA 按钮 → Luna.Unity.Playable.InstallFullGame()  (Luna SDK 主入口)
  → wx-ad-bridge.js: doJump()
     1. endUnityGame() → wx.notifyMiniProgramPlayableStatus({isEnd:true})  ← 无条件先发
     2. (如配 wxAppId) wx.navigateToMiniProgram({appId})  ← 否则 fallback 商店链接
```

**多入口防御**（同一 `endUnityGame` 被多路径触发，避免漏报）：
- `Luna.Unity.Playable.InstallFullGame` — 主 CTA（开始/中途/结束页按钮通常都接这里）
- `Luna.Unity.LifeCycle.GameEnded` — 胜负结算（wrap 不覆盖原 `pi.logGameEnd`）
- `luna:ended` event — 部分路径直接 dispatch 不调 LifeCycle.GameEnded
- `window.open` (dom-shim) — Unity `Application.OpenURL` 直链按钮的兜底

**对比 Unity 原生小游戏（minigame-unity-webgl-transform）**：那条工具链走 `wx.navigateToMiniProgram({appId})` 跳目标小程序作为 CTA 终点；C# `WX.NotifyMiniProgramPlayableStatus(opt)` 通过 wasm → `unity-sdk/sdk.js: WX_OneWayFunction` → `wx[lowerName]({...config, success, fail, complete})`。两条最终都落到 `wx.notifyMiniProgramPlayableStatus`，runtime 不挑入口。

## 调试纪律

- **先确认根因，再写 workaround**。如果你在写"只对 mecanim/box2d 生效"的特殊处理，停下来——多半根因没找到。本次的 `noop-arity-strict` 就是一例反面教材：写了一堆硬编码 19 个 arity 的 noop，结果根因是 monkey-patch 递归，跟 imports 内容毫无关系。根因找对后所有模块走同一条 `mode=pass`。
- **找到根因后立即剪掉脚手架**。专用 hack 不剪会变成"考古遗迹"，下次接手的人（包括未来的你）会被误导。
- **录全 vConsole**。试玩预览没控制台，console capture 注入 + wx.setEnableDebug 是看现场的唯一办法（FS 写盘不通时也得看屏幕）。

## globalThis ≠ GameGlobal —— 全局构造器必须双挂

试玩 runtime 里 `globalThis !== GameGlobal`（参看 game.js 里 `globalThis.startGame → GameGlobal.startGame` 的桥接）。Luna 打包后的 `eval()` 代码做裸标识符引用（如 `new Audio()` / `new Image()`）走 **globalThis** 解析，**不**走 GameGlobal。所以 dom-shim 仅 `g.Audio = AudioShim` 不够，会报 `ReferenceError: Audio is not defined` → `_loadSimpleAssetsAsync` reject → 黑屏。

dom-shim 末尾必须把关键构造器同步到 globalThis：

```js
try {
  if (typeof globalThis !== 'undefined' && globalThis !== g) {
    const _mirror = ['Event','MouseEvent','WheelEvent','KeyboardEvent','TouchEvent','PointerEvent',
      'Audio','HTMLAudioElement','HTMLImageElement','HTMLVideoElement','HTMLCanvasElement',
      'HTMLElement','Element','Node','AudioContext','webkitAudioContext','Image'];
    for (const k of _mirror) {
      if (typeof globalThis[k] === 'undefined' && typeof g[k] !== 'undefined') {
        try { globalThis[k] = g[k]; } catch (e) {}
      }
    }
  }
} catch (e) {}
```

注意 `Image === HTMLImageElement` 浏览器约定要保留：`g.Image = g.HTMLImageElement` 否则 `new Image()` 在 eval'd 代码里同样炸。

**每个赋值都要独立 try/catch + continue**：playable runtime 偶尔把某些构造器锁成 readonly 或 non-configurable，单次失败不能让整个 mirror 循环退出。`for (const k of _mirror) { try { ... } catch (e) {} }` 把每一项隔离开——17 项里挂掉 1 项不影响其余 16 项可用。

### `Symbol.hasInstance` 反向校验（critical）

**仅有构造器还不够**——PlayCanvas 内部有 `instanceof HTMLImageElement` / `instanceof HTMLVideoElement` 这类 duck-type 检查，wx 的真 Image 对象 prototype 链对不上 → `instanceof` 返 false → 走错分支（典型：纹理上传被跳过 → 黑屏）。

dom-shim 必须在 ImageShim/VideoShim/AudioShim 上装 `Symbol.hasInstance`：

```js
function makeShimCtor(Ctor, isLike) {
  Object.defineProperty(Ctor, Symbol.hasInstance, {
    value: function (obj) { return obj instanceof Ctor || isLike(obj); }
  });
  return Ctor;
}
const isWxImageLike = (o) => o && typeof o.src === 'string' && typeof o.width === 'number' && typeof o.height === 'number';
makeShimCtor(ImageShim, isWxImageLike);
```

`isLike` 用 duck-type 字段嗅探（src/width/height 都在 wx 真对象上），不靠 prototype 链。这条修对了之后纹理上传链路通的几率大很多。

### ImageShim 懒构造（defineProperty getter）

PC 资源加载器先访问 `img.src`，**onload 还没绑定**。ImageShim 把 `_real = wx.createImage()` 放在 src setter 第一次写入时触发：

```js
function ImageShim() {
  const self = this;
  let _real = null, _src = '';
  Object.defineProperty(self, 'src', {
    configurable: true,
    get() { return _src; },
    set(v) {
      _src = v;
      if (!_real) _real = wx.createImage();
      _real.onload  = () => { self.complete = true; self.onload  && self.onload(); };
      _real.onerror = (e) => { self.onerror && self.onerror(e); };
      _real.src = v;
    }
  });
}
```

`self.complete` 同样 defineProperty 双层 fallback（见 asset-inject 章节）。

### `makeNoop(tag)` for style/script/link

Luna 偶尔注入 `<style>` 或 `<script>` tag。`document.createElement('style').appendChild(...)` 不能炸。给非交互 tag 一个空对象 stub（appendChild/insertBefore/setAttribute 全 no-op），返回前先 setEnableDebug。

## 触摸/轮盘注入：Bridge.NET struct + Input.Update keepalive

Luna 用 PlayCanvas 接 Unity, 但摇杆/Touch 直接吃 `UnityEngine.Input.touches/touchCount/GetTouch(0)`，**不走** `pc.app.touch`。所以 dom-shim 里 dispatchTouch 同步合成 mouse/pointer 事件不够，必须直接写 UnityEngine.Input 内部状态。坑链：

1. **mangled 字段名因 build 不同 — 自家 build 必先观测**

   DC Dark Legion (Aquaman / luna-wx-mg) 上的实测映射：

   | mangled | 含义 |
   |---|---|
   | `W$` | mousePosition |
   | `X$` | touches |
   | `V$`, `G$` | touchCount（两个引用同一字段） |
   | `z$` | mouseButtons |
   | `A$` | mouseButtonsDown |
   | `B$` | mouseButtonsUp |
   | `h$`, `o$` | Touch struct 内 position 的 backing field |

   下个 Luna 版本几乎一定改名。**唯一可靠发现路径**：dom-shim 里加 `_instrumentUIRead()`，对 `UnityEngine.Input` 上每个枚举字段装 getter hook，记录被读到的字段名 + 调用 stack 头部，输出快照（snapshot diff）。比对两份 build 的 snapshot，新名字一目了然。

2. **Bridge.NET `struct Touch` 的 position/deltaPosition accessor 走 `$clone()` 返副本**：直接 `mockT.position.x = ux` 写到副本上，原 Touch 实例的 backing field（mangled `h$`/`o$`）没动 → 摇杆识别不到位置。**唯一解**：`Object.defineProperty` 在 instance 上 force getter，覆盖 prototype accessor：

   ```js
   function forceGetter(key, factory) {
     try { Object.defineProperty(mockT, key, { configurable: true, enumerable: true, get: factory }); return true; } catch (e) { return false; }
   }
   forceGetter('position',      () => mkV2(s.ux, s.uy));
   forceGetter('rawPosition',   () => mkV2(s.ux, s.uy));
   forceGetter('deltaPosition', () => mkV2(dx, dy));
   forceGetter('phase',         () => isStart ? 0 : (isMove ? 1 : 3));
   ```

3. **`UnityEngine.Input.touches` getter 内部也走 X$ 数组的 $clone**：Bridge.NET 把整个 X$ 数组里的 Touch 复制一份，accessor 又被抹。**解法**：在 `_instrumentUIRead` 里把 `touches`/`touchCount` getter 短路（不调 origGet），直接返 `[mockT]`/`1`；`GetTouch(0)` 同样短路返 mockT。三处都要短路，缺一会被 $clone 干掉。

4. **触摸事件离散，但游戏每帧读 Input**：单次 dispatchTouch 写完 z$/W$ 后，Luna `Input.Update()` 下一帧重置全部状态。**16ms `setInterval(_injectUIState, 16)`** keepalive 持续重写到 touchend + 200ms。16ms 不是随便选的：60fps 一帧 = 16.67ms，比帧周期略短保证每帧至少一次写入。

5. **touchend 不能立刻置 active=false（3-tick 释放序列）**：会导致 touchCount 这帧立即 0，Unity EventSystem 直接 return 跳过 OnPointerUp，**摇杆不释放，角色一直跑**。

   正确做法：touchend 后保持 `active=true` 跑 **3 个 keepalive tick**（`endedTickCount` 从 3 倒数到 0）。这 3 帧期间：
   - `touches=[mockT]`, `touchCount=1`
   - `mockT.phase = TouchPhase.Ended` (= 3 in Bridge.NET enum)
   - mouseButtons 立刻清 0, mouseButtonsUp 这帧置 1（一次性）

   让 EventSystem 至少 poll 到一次 phase=Ended → 触发 OnPointerUp → 摇杆释放。3 帧后才 `active=false`。

   **不是任意数字**：1 tick 偶尔够（race），2 tick 还见过角色滑步，3 tick 是经验稳定值。改小试过会回归。

完整 `_setUITouchState` + `_injectUIState` + `_instrumentUIRead` 实现见 `/tmp/luna-wasm-extract/.dom-shim.v18-may4.snapshot`（这一坨 ~250 行）。

### 易遗漏：mkV2/mkV3 多构造签名探测 + `h$/o$` 双层写

写 mock Touch 时，构造 Vector2/Vector3 不能只试 `new V2.ctor()` 一种：Bridge.NET 给值类型生成 0/1/2 参三种重载，少哪个都可能 fallback 到 plain `{x,y}` 对象，下游 `instanceof` 校验直接 false。**优先级**：`new V2.$ctor1(x,y)` → `new V2.ctor()` + 写 `.x/.y` + 写 `_data[0..1]` → plain `{x, y, _data:[x,y]}` 兜底。

`forceGetter` 覆盖 `position/deltaPosition` accessor 之后**还要**直接写 mockT 的 backing field `h$.x/y` + `h$._data[]` 和 `o$.x/y` + `o$._data[]`：Bridge.NET 部分代码路径（编译优化）会绕过 accessor 直接读 backing field，accessor hook 这一层就失效。两层都写才稳，少哪层概率都是"摇杆有时识别有时不"。

### 易遗漏：`__uiInjectFrameCnt` 限频快照（1/30/100 帧）

`_injectUIState` 每 16ms 跑一次 = ~60 次/秒，全打日志会爆控制台。dom-shim 用 `__uiInjectFrameCnt` 计数器，仅在第 **1 / 30 / 100** 帧打 readback 快照（mousePos / touchCount / mockT.phase），覆盖了"首帧错"/"稳态"/"长时漂移"三个时间点。改频率前先想清楚要看什么——这套是定位 race 的关键采样点。

## asset-inject.js：图像/音视频代理的隐藏陷阱

asset-inject.js 把 Luna 资源喂给 dom-shim 的代理元素。三个**不易察觉**的坑：

### `.complete` defineProperty 必须 try/catch 双层 fallback

Luna 的 `_loadSimpleAssetsAsync` 读 `n.complete` 决定是否要再 `n.onload = ...`。wx Image 的 `complete` 可能被实现成 getter 永远返 false → Luna 反复 re-bind onload，永远不 fire → 白屏。

```js
try { Object.defineProperty(n, 'complete', { configurable: true, get: () => true }); }
catch (e) { try { n.complete = true; } catch (_) {} }
```

`naturalWidth/naturalHeight` 同样：仅在 `== null` 时 defineProperty，避免覆盖 wx 已经设好的真实值。

### Proxy `<video>` / `<audio>` 的 `.load()` 必须**异步** fire onloadeddata

PC 资源加载器调 `el.load()`，期待异步触发 `onloadeddata` / `oncanplay`。代理直接同步 fire 行不通——PC 还没来得及挂回调。用 `setTimeout(0)`：

```js
proxy.load = function () {
  setTimeout(() => {
    proxy.readyState = 4;  // HAVE_ENOUGH_DATA, HTML5 媒体常量
    if (typeof proxy.onloadeddata === 'function') proxy.onloadeddata({});
    if (typeof proxy.oncanplay   === 'function') proxy.oncanplay({});
  }, 0);
};
```

`readyState=4` 这个常量必须保留——PC 内部 `if (readyState >= 4)` 判断就绪。

### 易遗漏：`n.remove()` no-op 必须存在

Luna 的 texture handler 走 `texture.setSource(n); n.remove(); /* mipmaps... */` 模式，调用真 `wx.createImage()` 返回的对象上的 `.remove()`——但 wx 真 Image **没**这方法，访问 undefined 抛 TypeError → 整张纹理上传失败 → 黑屏或马赛克。asset-inject 必须给每个代理 image 注入空 stub：

```js
if (typeof img.remove !== 'function') img.remove = function () {};
```

`removeChild` 同理（document.body / document.head 上）。注 stub 而不是省略——Luna 不检查存在性，直接调。

## RAF 双源同源化（window + canvas）

wx 小游戏风格 API 给 `canvas.requestAnimationFrame`，浏览器风格给 `window.requestAnimationFrame`。Luna/PlayCanvas 视版本可能调任一边——dom-shim 必须**同源化**，把 window RAF 路由到 canvas RAF 上保证渲染循环一定起：

```js
const rawWinRaf = (typeof g.requestAnimationFrame === 'function')
  ? g.requestAnimationFrame.bind(g)
  : g.canvas.requestAnimationFrame.bind(g.canvas);
const rawWinCaf = (typeof g.cancelAnimationFrame === 'function')
  ? g.cancelAnimationFrame.bind(g)
  : g.canvas.cancelAnimationFrame.bind(g.canvas);
g.requestAnimationFrame = function (cb) { return rawWinRaf(cb); };
g.cancelAnimationFrame = rawWinCaf;
```

不同源化会出现：单边路径起得来，另一边静默不调用——多半是 PC 内部某 timing 切换后整段画面卡住但 vConsole 无错。

## wx-ad-bridge.js：lifecycle + 渲染矫正

### `pc.platform.touch/mobile` 必须 retry 30 次（100ms 间隔）

`pc` 全局对象在 `require('wx-ad-bridge')` 那一刻**还是 null**，要等 luna 主代码加载到 PlayCanvas init 才出现。直接读会 NPE。

```js
let attempts = 0;
const tick = () => {
  if (typeof pc !== 'undefined' && pc && pc.platform) {
    pc.platform.touch = true; pc.platform.mobile = true; return;
  }
  if (++attempts < 30) setTimeout(tick, 100);
};
tick();
```

3s 上限够；过了说明 PC 根本没起来，得查上游错误链。

### Bundle.handlers 重试包装（5 段 backoff）

PlayCanvas `Bundle` 加载非关键资源（sound / video / audio_mixer）失败会让整个加载链 reject。要把这些 handler 包成**安全 swallow**版本，让加载继续：

```js
const NONESSENTIAL = ['sound', 'video', 'audio_mixer', 'binary'];
const wrapHandlers = () => {
  if (!pc || !pc.app || !pc.app.assets || !pc.app.assets._loader) return false;
  for (const k of NONESSENTIAL) {
    const h = pc.app.assets._loader.getHandler(k);
    if (h && !h.__wrapped) {
      const orig = h.load;
      h.load = function (url, cb, asset) {
        try { return orig.apply(this, arguments); }
        catch (e) { setTimeout(() => cb(null, {}), 0); }
      };
      h.__wrapped = true;
    }
  }
  return true;
};
[10, 50, 200, 500, 1500].forEach(ms => setTimeout(wrapHandlers, ms));
```

5 段 backoff 是因为 handler **每次 `app.configure()` 重建**，单次 hook 会被冲掉。5 次覆盖 PC 启动期所有 configure 时机。

### Ambient lighting 强度 0.15（不是 1.0）

PC 试玩里 ambient 默认强度过亮 → 角色被冲成白色。校正比例是 `(0.50, 0.60, 0.80) / (0.45, 0.45, 0.45) / (0.30, 0.25, 0.20)` × **0.15**（不是 0.5、不是 1/3）。0.5 角色发白，1/3 还是太亮，0.15 留出空间给 directional light。

如果 `ambientProbe` 是空的，`pc.Color` 重建：`probe.clear() + probe.addSkyGradient(top, equator, bottom)`。

### Lightmap shader bitflag 修正

如果场景含有 lightmap users 但 lightmap manager 是空（资源没真加载），shader 编译会卡。**条件性**清 SHADERDEF flag 强制重编：

```js
if (noLMData && withLM > 0) {
  for (const mi of meshInstances) {
    mi._shaderDefs &= ~0x4;  // 清 SHADERDEF_LM
    mi._shaderDefs &= ~0x8;  // 清 SHADERDEF_DIRLM
    mi._shader = null;        // 触发 shader 重编
    mi.lightmapIndex = -1;
  }
}
```

`noLMData && withLM > 0` 这个 gating 很重要——如果 lightmap 真的有数据就别动；只有 manager 空 + 场景需要时才修。0x4/0x8 是 PC 内部 SHADERDEF 位，硬编码值。

## tools/extract-wasm.cjs：抠 WASM 完整链

**输入文件依赖**（缺一不行）：
- `luna-runtime/04_brotli.js` — 必须先 require/eval 它，把 `window.decompress` 注入全局
- `subpackage-bundle/14_compressed_asset.js` — Luna 的资源 chunk，里面藏 `data:application/octet-stream;base64,...` 内联 WASM

**完整流程**：
1. `eval(04_brotli.js)` → 全局多出 `window.decompress`
2. 读 14_compressed_asset.js，正则 `data:application/octet-stream;base64,([A-Za-z0-9+/=]+)` 抠每段 base64
3. 每段 atob → Uint8Array → 头 4 字节 `0x00 0x61 0x73 0x6d` 验 WASM magic（不匹配跳过）
4. 字符串嗅探分类：找到 `b2Body|b2Joint|b2World` → `box2d`；找到 `Animator|Mecanim|MotionField` → `mecanim`；都没命中输出 `luna-wasm-unknown-${size}.wasm`
5. `zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })` 最大压缩
6. 输出 `luna-wasm.json` manifest：`{ "box2d": {raw_size, br_size}, "mecanim": {...} }`

**Node.js 内置 brotli 即可**，不用外部 binary。Quality=11 是上限；SIZE_HINT 给窗口选择，br 后 Box2D 168→60KB / Mecanim 272→85KB 是经验范围。

**dom-shim 端**：`_wasmFiles[bytes.length] = 'box2d.wasm.br'` 这种 byteLength→文件名静态表。所以**手抠完后必须把每个 byteLength 写进 dom-shim**，否则 redirect 的 lookup 会 miss → `unmapped WASM length=...` reject。

## 诊断套件（不止 vConsole）

试玩广告真机看不到 vConsole，单靠 stack trace 解黑屏太慢。dom-shim/wx-ad-bridge 留了一组**主动诊断探针**，调试时按需调用：

### canvas `_bus._stats()` / `_types()` / `_listSources(type)`

`g.canvas._bus` 是自家 emitter（见 §canvas）。

```js
canvas._bus._stats()  // {touchstart: 2, touchmove: 2, mousedown: 1, ...}
canvas._bus._listSources('touchstart')  // 列每个回调的 toString 头 300 字符
```

PC TouchDevice / mousedown 监听器到底来了几个、长什么样，一目了然。**第一波黑屏** 时先看这——回调数 0 = TouchDevice 没 init = 上游链断。

### wx-ad-bridge `deepProbe()` (启动后 3s)

幂等探针，扫一遍：
- `pc.app.scenes._index` —— 场景注册数
- `doc._elements` 注册表 —— 资源代理元素总数 + 状态分布
- `gd.textures` —— 按 `_width × _height` 桶分组（如果全是 4×4 一定是占位纹理没替换 → 资源没真上传）
- `pc.app.stats.frame` —— 渲染帧统计

3s 不是死的，等 luna build 完 + 第一帧渲染。早调（< 1s）多半空。

### `_instrumentUIRead()` —— Unity Input 字段探针

装 getter hook，每次游戏读 `UnityEngine.Input.X$` / `Y$` 之类时记录字段名 + caller stack 头部，输出快照。**新 Luna 版本第一件事跑这个**，然后跟 v18 base 的快照 diff，新 mangled 字段名一目了然。

### `[XXAUDIO]` 音频探针

dom-shim 末尾，所有音频路径都打 console.log（见 §音频桥接 调试套路）。配合 HTTP probe 拉日志。

### Snapshot diff 工作流（重要）

回归出现时**第一动作**：

```bash
diff -u snapshots/dom-shim.may2-12-48.snapshot luna-to-wx/dom-shim.js | grep "^[+-]" | head -50
```

或者 `diff snapshots/dom-shim.v18-may4.snapshot snapshots/dom-shim.v19c-may4-pure-b64.snapshot` 看两版之间动了什么。

**比顺 stack trace 高效一个数量级**——5/3 那次 26 个错链尾端 patch 把画面修没，就是没第一时间走这个。详见 `dom-shim.may4-broken.js` 反面教材。

## 包大小预算（5MB 硬上限）

试玩广告主包 5MB 硬上限，不能分包。当前预算：

| 项 | 大小 | 备注 |
|---|---|---|
| Luna 主 JS（br 后） | ~1MB | cleaner 去 source map / polyfill 重复 |
| Box2D WASM (br) | ~60KB | extract-wasm 出 |
| Mecanim WASM (br) | ~85KB | 同上 |
| dom-shim.js | ≤65KB | v19e 当前 62KB，软上限 65KB（再加要紧编辑） |
| asset-inject.js | ~10KB | 几乎不长 |
| wx-ad-bridge.js | ~30KB | ambient/lightmap 修正一直在加 |
| 资源（图片/音视频/字体） | 余量 | 主要预算去这 |

dom-shim 超 65KB 应警觉——每加一段都问"必要吗"。实际硬墙是 5MB total，不是单文件，但单文件过大说明在堆 hack。

## 工具/版本/坐标固定项

复用迁移时下面这堆**先 diff 自家环境**再开工：

| 项 | 值 | 说明 |
|---|---|---|
| playable-libs 版本 | 2.0.15 | vConsole `[system] playable-libs: X.Y.Z` 自报；其它版本未测，三大坑可能漂移 |
| 微信开发者工具 | `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat` | 中文路径需 wxcli.bat UTF-8 wrapper |
| 测试机 | tailscale `wx-build` (Windows) | 详见 `reference_wx_build_host.md` |
| AppID | `wx21647eaf197e9b58` | luna-wx-mg 项目用；新项目自申 |
| 项目路径 | `C:\Users\Nick\luna-wx-mg` | scp/ssh 路径硬编码 |
| cli.bat | `D:\wechatDev\cli.bat` | wxcli.bat wrapper 转发 |
| Brotli | Node `zlib.brotliCompressSync` | 不用外部 binary |
| Preview 等待 | 50 秒 | schtasks 异步包装；不到 50s 就报 fork timeout 多半真 IDE 故障 |

## 黑屏回归调试纪律

`n.load is not a function` 这类报错在 element.load 调用链尾端，**很可能不是真根因**——是更早 init 路径走了不该走的分支留下的副作用。调试时：

1. **先回到已知能出画面的 baseline**（这次：`.dom-shim.may2-12-48.snapshot`，44KB）
2. **逐项叠加 patch**，每加一条都验画面没坏
3. **不要在 element.load/remove 链尾端补 stub**——`_registerElement`、`_patchWxNative` 这种深度 wrap 容易引入新隐藏路径

参考记忆：`project_luna2wechat_dom_shim_regression.md` 记录了 5/3 03:38 后 26 次 patch 把画面修没的反面教材。**根因**：用户消息里"画面之前正常过"是关键信号——说明问题是回归而非新墙，第一时间 git/snapshot diff 找回归点比一头扎进 stack trace 高效得多。

## 关键时间/常量速查

下面是 dom-shim / wx-ad-bridge 里所有"魔术数"，每个都是经验值，改动前先看 commit 历史里有没有"试过 X 不 work"的记录。

| 常量 | 出处 | 含义 |
|---|---|---|
| `16ms` | `setInterval(_injectUIState, 16)` | 60fps 略短，保证每帧至少一次 UI state 写入 |
| `endedTickCount = 3` | touchend 释放 | EventSystem poll Ended 阶段所需 tick；2 见过 race，3 稳 |
| `200ms` | touchend 后 keepalive 延伸 | 给 EventSystem 完成 OnPointerUp 链 |
| `30 attempts × 100ms = 3s` | wx-ad-bridge `pc.platform` retry | PC init 上限 |
| `[10, 50, 200, 500, 1500] ms` | Bundle handler retry backoff | 覆盖 5 次 `app.configure()` 时机 |
| `0.15` | ambient intensity scalar | 0.5 发白 / 1/3 仍亮 / 0.15 留 directional 空间 |
| `readyState = 4` | video/audio proxy | HTML5 HAVE_ENOUGH_DATA 常量 |
| `0x4 / 0x8` | shader bitflag clear | SHADERDEF_LM / SHADERDEF_DIRLM |
| `_mirror` 17 个全局 | dom-shim 末尾 globalThis 镜像 | Audio/Image/Event 等构造器双挂 |
| Brotli `quality=11` + SIZE_HINT | extract-wasm.cjs | WASM 最小化压缩 |

## 当前迁移状态

见 **`project_luna2wechat_status.md`**——记录跑到哪一步、剩什么硬墙。每次推进后那条记忆要刷新。

## 复用到下个 Luna 试玩的 checklist

按顺序走，跳着走会被坑链回反：

1. **入口形态判断** — 源工程目录直接走 §2；渠道 HTML 跑 `node tools/postprocess.js channelXxx.html out/` 一条命令把整个工程 + WASM 抠完 (postprocess 末尾自动 chain extract-wasm.cjs, 自动注入 bootstrap chunk 末尾 startGame patch, 自动识别 i18n_analytics chunk 归 _skipped/, 自动生成 main-require-order.js + subpackage-list.js). 不用手工干预.
2. **(已自动)** ~~抠 WASM~~ — postprocess 已 chain. 双层套娃 (新 luna 7.x base122+brotli 包装) 已支持.
3. **(已自动)** ~~修 main-require-order~~ — postprocess 输出 .js + .json.
4. **(已自动)** ~~取消分包~~ — game.json 模板已不写 subpackages 字段, game.js 用 require('./subpackage-list.js') 进主包.
5. **跑 dom-shim baseline** — 从 v20 整段拷过来，先看出不出画面
6. **跑 _instrumentUIRead** — 自家 build 的 UnityEngine.Input mangled 字段名 snapshot
7. **接触摸/轮盘** — 用观测出的字段名替换 dom-shim 里的 `W$/X$/V$/G$/z$/A$/B$`
8. **接音频** — v19e 的 AudioShim/AudioContextShim 整段照搬，**不**碰
9. **接视频**（如有 VideoTexture）— v20 deferred-start 整段拷 asset-inject `makeVideoDecoderProxy` + wx-ad-bridge `startVideoDirtyTimer` + dom-shim GL `texImage2D` wrap
10. **真机扫码** — 画面 / 轮盘 / 松手停 / 声音 / 视频 / 0 fatal error 六项
11. **启动加速四件套** — 关 `setEnableDebug` + 删 game.js 自己的 console wrap + first-screen splash 单帧 + (新) postprocess 自动 strip lang_config 里 loadingImgBase64 (实测 -270ms boot)
12. **0 error 后**才考虑视觉优化（ambient/lightmap/shader 等 wx-ad-bridge 修正）
