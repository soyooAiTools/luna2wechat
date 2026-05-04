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

### 6. game.js 入口典型流程

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

## 触摸/轮盘注入：Bridge.NET struct + Input.Update keepalive

Luna 用 PlayCanvas 接 Unity, 但摇杆/Touch 直接吃 `UnityEngine.Input.touches/touchCount/GetTouch(0)`，**不走** `pc.app.touch`。所以 dom-shim 里 dispatchTouch 同步合成 mouse/pointer 事件不够，必须直接写 UnityEngine.Input 内部状态。坑链：

1. **mangled 字段名因 build 不同**：DC Dark Legion 上 `W$=mousePosition`/`X$=touches`/`V$,G$=touchCount`/`z$,A$,B$=mouseButtons{,Down,Up}`，下个 Luna 版本可能改名。**用 `_instrumentUIRead()` 装 getter hook 观测 game 实际读哪些字段**，再决定写哪。

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

4. **触摸事件离散，但游戏每帧读 Input**：单次 dispatchTouch 写完 z$/W$ 后，Luna `Input.Update()` 下一帧可能重置。用 `setInterval(_injectUIState, 16)` keepalive 持续重写到 touchend + 200ms。

5. **touchend 不能立刻置 active=false**：会导致 touchCount 这帧立即 0，Unity EventSystem 直接 return 跳过 OnPointerUp，**摇杆不释放，角色不停**。正确做法：touchend 后保持 active=true 跑 3 个 keepalive tick（`endedTickCount`），让 EventSystem 至少 poll 到一次 phase=Ended，OnPointerUp 触发后再置 false。

完整 `_setUITouchState` + `_injectUIState` + `_instrumentUIRead` 实现见 `/tmp/luna-wasm-extract/.dom-shim.v18-may4.snapshot`（这一坨 ~250 行）。

## 黑屏回归调试纪律

`n.load is not a function` 这类报错在 element.load 调用链尾端，**很可能不是真根因**——是更早 init 路径走了不该走的分支留下的副作用。调试时：

1. **先回到已知能出画面的 baseline**（这次：`.dom-shim.may2-12-48.snapshot`，44KB）
2. **逐项叠加 patch**，每加一条都验画面没坏
3. **不要在 element.load/remove 链尾端补 stub**——`_registerElement`、`_patchWxNative` 这种深度 wrap 容易引入新隐藏路径

参考记忆：`project_luna2wechat_dom_shim_regression.md` 记录了 5/3 03:38 后 26 次 patch 把画面修没的反面教材。**根因**：用户消息里"画面之前正常过"是关键信号——说明问题是回归而非新墙，第一时间 git/snapshot diff 找回归点比一头扎进 stack trace 高效得多。

## 当前迁移状态

见 **`project_luna2wechat_status.md`**——记录跑到哪一步、剩什么硬墙。每次推进后那条记忆要刷新。
