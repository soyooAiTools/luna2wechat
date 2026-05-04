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

## 适配清单（按依赖顺序）

### 1. 抽 WASM 出来当静态文件
Luna 把 Unity 的两份 emscripten WASM（**Box2D ~168KB** + **Mecanim ~272KB**，具体 byteLength 因 Unity 版本会变）当 `data:` URI 内联在 chunk 里。试玩 runtime 不能从 buffer instantiate，必须落成静态文件。

- 工具：`extract-wasm.cjs`（在 luna 工程里跑），扫描 chunk 找 `\x00asm` magic、解出文件、用 `brotli -q 11` 压成 `.wasm.br`，并打印 byteLength → 文件名 manifest
- 命名约定：`box2d.wasm.br` / `mecanim.wasm.br`，和 dom-shim 的 `_wasmFiles` 表对得上
- 主包加这两个文件后包大小通常仍在 5MB 内（Luna 主 JS 被 br 后约 1MB，两份 WASM br 后约 60+85KB）

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

## HTTP probe：绕 wx 域名白名单看真机日志

试玩广告 vConsole 在真机上不可视，`wx.request` 受域名白名单限制。绕开方法：dom-shim 接管 `console.log/warn/error/info`，把 message 通过 `new Image().src = 'http://LAN_IP:PORT/log?m=...'` 发出去（图片 GET 不走域名白名单），本机起一个 HTTP server 接收。

```js
// /tmp/probe-server.js（在测试机或开发机跑）
const http = require('http'), fs = require('fs');
const LOG = process.argv[2] || 'C:\\Users\\Nick\\probe.log';
http.createServer((req, res) => {
  fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + req.method + ' ' + req.url + '\n');
  res.writeHead(200, {'Access-Control-Allow-Origin': '*'}); res.end('ok');
}).listen(38080, '0.0.0.0');
```

dom-shim 端：每次 console.log 把 args 拼成 `?m=[level] msg` query 发出去。手机和测试机在同一 LAN 才行（`192.168.1.3:38080` 之类）。`wx-build` 上跑后用 `scp wx-build:C:/Users/Nick/probe.log /tmp/probe.log` 拉回来 grep。

每次 build 前 `Remove-Item probe.log` 清空，避免老条干扰判断。

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

1. **跑一遍 baseline** — 主代码 + 原 Luna 资源 → 看 vConsole 第一个 fatal 报错
2. **抠 WASM** — `extract-wasm.cjs` 找两份 emscripten module，落成 `.wasm.br`，记 byteLength
3. **修 main-require-order** — 把 .json manifest 转成 `module.exports = [...]` 的 .js
4. **取消分包** — 所有 `wx.loadSubpackage` 调用点改 `require()`，资源进主包，包大小 < 5MB
5. **跑 dom-shim baseline** — 从 v18 整段拷过来，先看出不出画面
6. **跑 _instrumentUIRead** — 自家 build 的 UnityEngine.Input mangled 字段名 snapshot
7. **接触摸/轮盘** — 用观测出的字段名替换 dom-shim 里的 `W$/X$/V$/G$/z$/A$/B$`
8. **接音频** — v19e 的 AudioShim/AudioContextShim 整段照搬，**不**碰
9. **真机扫码** — 画面 / 轮盘 / 松手停 / 声音 / 0 fatal error 五项
10. **0 error 后**才考虑视觉优化（ambient/lightmap/shader 等 wx-ad-bridge 修正）
