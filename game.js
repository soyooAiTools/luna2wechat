// 微信小游戏入口 — Luna playable on WeChat
// 启动序列: dom-shim → first-screen splash → main scripts → subpackage → asset-inject + bridge

// **关 setEnableDebug**: vConsole hook 在试玩 runtime 启动期占 200-500ms.
// HTTP probe 已在 dom-shim 内独立 wrap console (走 53017), 不依赖 vConsole.
// 调试期需要时改回 true.
// try { wx.setEnableDebug({ enableDebug: true }); } catch (e) {}

// **不在这里再 wrap console**: 之前 game.js 的 wrapConsoleForProbe 把 console.log 包成
// 同步 wx.createImage().src='http://...:38080/...' (38080 没 server, 每次失败).
// 启动期 ~50 条 log = ~50 次同步 wx 网络栈调用 → 拖慢 ~1s.
// dom-shim L31-79 已 wrap console → 53017 (fire-and-forget + buffer + setInterval), 不阻塞.

require('./luna-to-wx/dom-shim.js');
require('./first-screen.js');

const order = require('./main-require-order.js');
for (const rel of order) {
  try { require(rel); }
  catch (e) { console.error('[boot] require fail:', rel, e && e.stack || e); }
}

// bootstrap chunk 末尾已被 postprocess 注入 startGame 全局挂载 (单一可靠路径);
// 这里再做一次 globalThis → GameGlobal 兜底桥接, 防御不同 wx baseLib 行为差异.
try {
  if (typeof GameGlobal.startGame !== 'function'
      && typeof globalThis !== 'undefined'
      && typeof globalThis.startGame === 'function') {
    GameGlobal.startGame = globalThis.startGame;
  }
} catch (e) { console.error('[boot] startGame bridge FAIL', e && e.stack || e); }

// 分包列表由 postprocess 根据实际 chunk 序号动态生成 — 不同 luna 版本编号不同 (12/13/14 vs 11/12/13).
// 试玩 runtime 不支持 wx.loadSubpackage, 所有 chunk 直接 require 进主包.
const subpkgs = require('./subpackage-list.js');
for (const rel of subpkgs) {
  try { require(rel); }
  catch (e) { console.error('[boot] require fail:', rel, e && e.stack || e); }
}

GameGlobal._dispatchReady && GameGlobal._dispatchReady();

try { require('./luna-to-wx/asset-inject.js'); }
catch (e) { console.error('[boot] asset-inject FAIL', e && e.stack || e); }
try { require('./luna-to-wx/wx-ad-bridge.js'); }
catch (e) { console.error('[boot] wx-ad-bridge FAIL', e && e.stack || e); }
try { GameGlobal.dispatchEvent(new GameGlobal.Event('luna:build')); }
catch (e) { console.error('[boot] luna:build FAIL', e && e.stack || e); }
console.log('[boot] entry done');
