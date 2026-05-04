/**
 * Minimum DOM shim for Luna runtime running under WeChat 小游戏.
 *
 * Luna 启动期实际触达的 DOM 表面非常窄,只 mock 这几条:
 *   document.querySelectorAll("[data-src122]")   — 资源扫描 (微信下走 asset-inject 替代,这里返回空)
 *   document.getElementById(id)                   — 拿 canvas / preloader
 *   document.createElement(tag)                   — 创建 Image / video (微信走 wx.createImage)
 *   URL.createObjectURL(blob)                     — 配合 <img> <video> (微信下用 wxfile://)
 *   addEventListener / dispatchEvent              — DOMContentLoaded / bridge:ready / luna:starting
 *   navigator.userAgent / .languages              — Luna 探测 locale
 *
 * 微信全局: GameGlobal === wx 主线程的 globalThis. canvas 由 wx 创建并挂载.
 * 与 cocos-wx 不同, 我们不引入完整 web-adapter.js, 因为 Luna 表面更小.
 */

(function bootShim() {
  const g = GameGlobal;

  // wx 原生 createImage/createCanvas 返回的对象缺 W3C 方法 (.load/.remove/addEventListener),
  // Luna asset bundle 内部直接 `new Image()` / 通过 wx.createImage() 创建, 然后 .load() 失败.
  // 在 createImage/createCanvas 返回前拼上 noop 方法, 任何路径拿到的 wx 对象都不会再 TypeError.
  function _patchWxNative(o, tag) {
    if (!o) return o;
    if (typeof o.load !== 'function') o.load = () => {};
    if (typeof o.remove !== 'function') o.remove = () => {};
    if (typeof o.addEventListener !== 'function') o.addEventListener = () => {};
    if (typeof o.removeEventListener !== 'function') o.removeEventListener = () => {};
    if (typeof o.setAttribute !== 'function') o.setAttribute = () => {};
    if (typeof o.getAttribute !== 'function') o.getAttribute = () => null;
    if (!o.style) o.style = {};
    if (!o.dataset) o.dataset = {};
    if (!o.tagName) o.tagName = tag;
    return o;
  }
  if (typeof wx !== 'undefined') {
    if (wx.createImage && !wx._createImage_orig) {
      wx._createImage_orig = wx.createImage.bind(wx);
      wx.createImage = function () { return _patchWxNative(wx._createImage_orig.apply(wx, arguments), 'IMG'); };
    }
    if (wx.createCanvas && !wx._createCanvas_orig) {
      wx._createCanvas_orig = wx.createCanvas.bind(wx);
      wx.createCanvas = function () { return _patchWxNative(wx._createCanvas_orig.apply(wx, arguments), 'CANVAS'); };
    }
  }

  if (!g.canvas) g.canvas = wx.createCanvas();
  // 即使 g.canvas 已由 playable runtime 提前创建, 也补齐 W3C 方法 — Luna 视频/纹理 handler
  // 在 getElementById('application-canvas') 拿到这个对象, 然后 .onloadeddata=... .load() 调用,
  // 缺 .load 整个 _loadSimpleAssetsAsync reject → InitializeAsync 永不 resolve → 黑屏。
  _patchWxNative(g.canvas, 'CANVAS');

  // luna-runtime/19_pi_runtime.js 的 Bridge.ready cb 会写 Luna.Unity.LifeCycle.GameEnded =,
  // Luna.Unity.LifeCycle 在 Bridge.NET 早期没生成 → "Cannot set properties of undefined" throw。
  // 在 dom-shim 早期占位, runtime 后期再覆盖也没问题 (Bridge.NET assignTo 是 Object.assign 风格)。
  g.Luna = g.Luna || {};
  g.Luna.Unity = g.Luna.Unity || {};
  g.Luna.Unity.LifeCycle = g.Luna.Unity.LifeCycle || {};
  g.Luna.Unity.Analytics = g.Luna.Unity.Analytics || {};
  g.Luna.Unity.Playable  = g.Luna.Unity.Playable  || {};

  // wx 试玩 runtime 缺 atob/btoa: 11_base122_decode.js 的 _base64ToArrayBuffer 用 window.atob 解 sound base64,
  // 缺了所有 decompressArrayBuffer(_, false) Promise 都 reject, window.sounds 永远空 → 听不到声音。
  // 同样 TextDecoder 在试玩 runtime 也常缺, decompressString 走 base64 + TextDecoder utf-8 路径会挂。
  if (typeof g.atob !== 'function') {
    const ATOB_T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const ATOB_M = new Int16Array(256); for (let i = 0; i < ATOB_M.length; i++) ATOB_M[i] = -1;
    for (let i = 0; i < ATOB_T.length; i++) ATOB_M[ATOB_T.charCodeAt(i)] = i;
    g.atob = function (s) {
      s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
      let out = '', a, b, c, d, i = 0;
      while (i < s.length) {
        a = ATOB_M[s.charCodeAt(i++)]; b = ATOB_M[s.charCodeAt(i++)];
        c = ATOB_M[s.charCodeAt(i++)]; d = ATOB_M[s.charCodeAt(i++)];
        out += String.fromCharCode((a << 2) | (b >> 4));
        if (c !== -1) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
        if (d !== -1) out += String.fromCharCode(((c & 3) << 6) | d);
      }
      return out;
    };
  }
  if (typeof g.btoa !== 'function') {
    const BTOA_T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    g.btoa = function (s) {
      s = String(s); let out = '';
      for (let i = 0; i < s.length; i += 3) {
        const a = s.charCodeAt(i), b = s.charCodeAt(i + 1) || 0, c = s.charCodeAt(i + 2) || 0;
        out += BTOA_T[a >> 2] + BTOA_T[((a & 3) << 4) | (b >> 4)] +
               (i + 1 < s.length ? BTOA_T[((b & 15) << 2) | (c >> 6)] : '=') +
               (i + 2 < s.length ? BTOA_T[c & 63] : '=');
      }
      return out;
    };
  }
  if (typeof g.TextDecoder !== 'function') {
    g.TextDecoder = function () {
      this.decode = function (buf) {
        const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
        let s = '', i = 0;
        while (i < u8.length) {
          const c = u8[i++];
          if (c < 0x80) s += String.fromCharCode(c);
          else if (c < 0xE0) s += String.fromCharCode(((c & 0x1F) << 6) | (u8[i++] & 0x3F));
          else if (c < 0xF0) {
            const c2 = u8[i++], c3 = u8[i++];
            s += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F));
          } else {
            const c2 = u8[i++], c3 = u8[i++], c4 = u8[i++];
            let cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F);
            cp -= 0x10000;
            s += String.fromCharCode(0xD800 | (cp >> 10), 0xDC00 | (cp & 0x3FF));
          }
        }
        return s;
      };
    };
  }
  if (typeof g.TextEncoder !== 'function') {
    g.TextEncoder = function () {
      this.encode = function (s) {
        s = String(s); const out = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
          else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
          else { const c2 = s.charCodeAt(++i); c = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
            out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
          }
        }
        return new Uint8Array(out);
      };
    };
  }

  // wx.createCanvas() 默认 2x2 — PlayCanvas/Luna 看到无效尺寸不启动渲染循环。
  // 显式设为屏幕尺寸 * pixelRatio (高 DPI 能覆盖纹理); CSS 像素仍由 clientWidth/Height 报告。
  // 注: 若试玩广告需要响应屏幕旋转, 后续要监听 wx.onWindowResize 重设, 现在一次性够用。
  try {
    const sys = wx.getSystemInfoSync();
    const dpr = sys.pixelRatio || 1;
    const w = sys.windowWidth  || sys.screenWidth  || 750;
    const h = sys.windowHeight || sys.screenHeight || 1334;
    g.canvas.width  = Math.floor(w * dpr);
    g.canvas.height = Math.floor(h * dpr);
    g._screen = { cssWidth: w, cssHeight: h, dpr };
    // PlayCanvas / Luna 读 window.devicePixelRatio 决定 backbuffer 比例; window.inner{W,H} 读 CSS 尺寸。
    if (g.devicePixelRatio == null) g.devicePixelRatio = dpr;
    if (g.innerWidth  == null) g.innerWidth  = w;
    if (g.innerHeight == null) g.innerHeight = h;
    if (g.outerWidth  == null) g.outerWidth  = w;
    if (g.outerHeight == null) g.outerHeight = h;
    g.screen = g.screen || { width: w, height: h, availWidth: w, availHeight: h };
    console.log('[bootShim] canvas sized to', g.canvas.width + 'x' + g.canvas.height, 'css=', w + 'x' + h, 'dpr=', dpr);
  } catch (e) {
    console.log('[bootShim] canvas size fail:', e && e.message);
    g.canvas.width  = 750;
    g.canvas.height = 1334;
  }

  // canvas: 试玩 runtime 上 wx.createCanvas() 返回的对象**已带** addEventListener，但那是 playable-libs
  // 拦截过的有 bug 版本（内部 fi(...).addEventListener 抛 TypeError）。**总是**挂 _bus，下游优先用 _bus。
  {
    const __canvasBus = (function () {
      const map = new Map();
      return {
        on(t, cb) { (map.get(t) || map.set(t, new Set()).get(t)).add(cb); },
        off(t, cb) { const s = map.get(t); if (s) s.delete(cb); },
        emit(t, ev) { const s = map.get(t); if (s) for (const cb of s) try { cb(ev); } catch (e) { console.error(e); } },
        // 探针: 列出已注册的事件类型 + 每类的回调数, 看 PC 真在监听啥
        _stats() {
          const out = {};
          for (const [k, s] of map.entries()) out[k] = s.size;
          return out;
        },
        _types() { return Array.from(map.keys()); },
        _count(t) { const s = map.get(t); return s ? s.size : 0; },
        _listSources(t) {
          const s = map.get(t);
          if (!s) return [];
          const out = [];
          for (const cb of s) {
            try { out.push(String(cb).slice(0, 300)); } catch (e) { out.push('<toString fail>'); }
          }
          return out;
        },
      };
    })();
    g.canvas._bus = __canvasBus;
    // 覆盖 canvas.addEventListener / removeEventListener / dispatchEvent → 走 _bus。
    // 之前以为"原版有功能,留着"，错的：playable-libs 的 wrap 内部 fi(...).addEventListener 永远抛 TypeError，
    // PlayCanvas init 调到（webglcontextlost / mousemove 等）就炸。改用 _bus 后所有注册都安全落地。
    g.canvas.addEventListener = function (t, cb) { __canvasBus.on(t, cb); };
    g.canvas.removeEventListener = function (t, cb) { __canvasBus.off(t, cb); };
    g.canvas.dispatchEvent = function (ev) { __canvasBus.emit(ev && ev.type, ev); return true; };
    // PlayCanvas 用 canvas.getBoundingClientRect() 取视口；wx canvas 没这方法，补一个，
    // 用 canvas.width/height 当 viewport（试玩广告画布即全屏）。
    if (typeof g.canvas.getBoundingClientRect !== 'function') {
      g.canvas.getBoundingClientRect = function () {
        // 返回 CSS 像素尺寸 (PlayCanvas 用此值 * devicePixelRatio 算 backbuffer 大小)
        const w = (g._screen && g._screen.cssWidth)  || this.width  || 0;
        const h = (g._screen && g._screen.cssHeight) || this.height || 0;
        return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
      };
    }
    // PlayCanvas 用 clientWidth/Height 配合 devicePixelRatio 算 backbuffer 像素 — 必须返回 CSS 尺寸,
    // 否则会出现 backbuffer = canvas.width * dpr → 每帧翻倍直到爆显存。
    const dims = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'];
    for (const k of dims) {
      if (g.canvas[k] == null) {
        Object.defineProperty(g.canvas, k, {
          configurable: true,
          get() {
            const w = (g._screen && g._screen.cssWidth)  || this.width  || 0;
            const h = (g._screen && g._screen.cssHeight) || this.height || 0;
            return k.includes('Width') ? w : h;
          },
        });
      }
    }
    // 不直接覆盖 canvas.addEventListener — 留给 playable-libs 那条路径继续；下游用 _bus 安全注册。

    // ---------- 触控桥接 wx.onTouch* → canvas._bus → PC TouchDevice ----------
    // PlayCanvas TouchDevice 在 init 时 canvas.addEventListener('touchstart'/'move'/'end'/'cancel', ...).
    // 我们的 canvas.addEventListener 已重定向到 __canvasBus.on; 这里把 wx.onTouchStart 等 fan-out
    // 进 bus, 构造与 DOM TouchEvent 兼容的 evt: e.touches / changedTouches / targetTouches + preventDefault.
    // wx 触点坐标 clientX/Y 已是 CSS 像素 (与 canvas.getBoundingClientRect 一致); PC 内部会自行 * dpr.
    function makeTouchObj(t) {
      // Touch 对象需要的字段: identifier, clientX/Y, pageX/Y, screenX/Y, target, force, radiusX/Y
      const x = t.clientX, y = t.clientY;
      return {
        identifier: t.identifier,
        clientX: x, clientY: y,
        pageX: x, pageY: y,
        screenX: x, screenY: y,
        radiusX: 1, radiusY: 1, force: t.force == null ? 1 : t.force, rotationAngle: 0,
        target: g.canvas,
      };
    }
    // Luna PC fork 的实际游戏输入挂在 window 的 mousedown/mousemove/mouseup (不是 touchstart/move)。
    // 触屏要同时合成 mouse 事件; touchstart→mousedown, touchmove→mousemove, touchend→mouseup。
    const TOUCH_TO_MOUSE = { touchstart: 'mousedown', touchmove: 'mousemove', touchend: 'mouseup', touchcancel: 'mouseup' };
    let __touchDispatchCnt = 0;
    let __lastTouchPos = { x: 0, y: 0 };
    function makeMouseEv(type, x, y) {
      return {
        type,
        clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
        offsetX: x, offsetY: y, x: x, y: y,
        button: 0, buttons: type === 'mouseup' ? 0 : 1, which: 1, detail: 1,
        movementX: 0, movementY: 0,
        ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
        target: g.canvas, currentTarget: g.canvas,
        timeStamp: Date.now(),
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
        isTrusted: true, bubbles: true, cancelable: true,
      };
    }

    // ---------- UnityEngine.Input keepalive 注入 ----------
    // 触摸事件离散, 但游戏每帧都读 Input。把状态存进 __uiInjectState, 用 16ms 定时器
    // 反复重写到 UI 的 mangled 字段, 防止 Luna Input.Update() 每帧把我们的状态重置。
    let __uiInjectState = null;
    let __uiInjectTimer = null;
    let __uiInjectInstrumented = false;
    let __uiInjectFrameCnt = 0;

    function _instrumentUIRead() {
      // 给 UI 的 getter / 方法装 hook,看游戏到底读什么
      const UI = g.UnityEngine && g.UnityEngine.Input;
      if (!UI || __uiInjectInstrumented) return;
      __uiInjectInstrumented = true;
      const calls = {};
      function _log(name, info) {
        calls[name] = (calls[name] || 0) + 1;
        if (calls[name] <= 6) {
          console.log('[UI.read#' + calls[name] + '] ' + name + ' ' + info);
        } else if (calls[name] === 50 || calls[name] === 200) {
          console.log('[UI.read.cnt] ' + name + ' total=' + calls[name]);
        }
      }
      // wrap property getters (mousePosition / touches / touchCount / anyKey / anyKeyDown)
      // 关键: touches/touchCount 不再调 orig getter — Bridge.NET orig 返 cloned X$ 数组,
      // 且 GetTouch 也走 $clone() 把 instance accessor 抹掉。直接返我们的 mockT (live ref)。
      for (const propName of ['mousePosition', 'touches', 'touchCount', 'anyKey', 'anyKeyDown']) {
        try {
          const d = Object.getOwnPropertyDescriptor(UI, propName);
          if (!d || !d.get) continue;
          const origGet = d.get;
          Object.defineProperty(UI, propName, {
            configurable: true,
            get: function () {
              // touches/touchCount 全程短路 — 绕开 Bridge.NET 内部 X$/V$ backing
              // (我们维护的 __uiInjectState 是真相; 释放后无 active 直接返 0/[], 角色立停)
              if (propName === 'touches') {
                return (__uiInjectState && __uiInjectState.active && __uiInjectState.mockT) ? [__uiInjectState.mockT] : [];
              }
              if (propName === 'touchCount') {
                return (__uiInjectState && __uiInjectState.active) ? 1 : 0;
              }
              const r = origGet.call(this);
              let info;
              if (typeof r === 'object' && r !== null) {
                if (Array.isArray(r)) info = 'arr.len=' + r.length;
                else info = 'obj{x:' + r.x + ',y:' + r.y + '}';
              } else info = String(r);
              _log('get ' + propName, '→ ' + info);
              return r;
            },
            set: d.set,
          });
        } catch (e) { console.log('[UI.instrument] wrap ' + propName + ' fail:', e && e.message); }
      }
      // wrap method calls (GetMouseButton/Down/Up, GetTouch, GetKey/Down/Up)
      for (const fnName of ['GetMouseButton', 'GetMouseButtonDown', 'GetMouseButtonUp', 'GetTouch', 'GetKey', 'GetKeyDown', 'GetKeyUp']) {
        try {
          const orig = UI[fnName];
          if (typeof orig !== 'function') continue;
          UI[fnName] = function () {
            // GetTouch 短路 — 有 active touch 时直接返 mockT (保留 forceGetter accessor),
            // 否则走 orig 但 orig 会 $clone() 把我们的 accessor 抹掉。
            if (fnName === 'GetTouch' && __uiInjectState && __uiInjectState.active && __uiInjectState.mockT && arguments[0] === 0) {
              calls[fnName] = (calls[fnName] || 0) + 1;
              if (calls[fnName] <= 4) {
                const m = __uiInjectState.mockT;
                console.log('[UI.read#' + calls[fnName] + '] GetTouch (0) → mockT pos={x:' + (m.position && m.position.x) +
                             ',y:' + (m.position && m.position.y) + '} phase=' + m.phase + ' fingerId=' + m.fingerId);
              }
              return __uiInjectState.mockT;
            }
            const r = orig.apply(this, arguments);
            if (fnName === 'GetTouch') {
              calls[fnName] = (calls[fnName] || 0) + 1;
              if (calls[fnName] <= 4) {
                let info = '<' + (r && r.constructor && r.constructor.name) + '>';
                if (r && typeof r === 'object') {
                  const ks = Object.keys(r).slice(0, 14).join(',');
                  info += ' keys=' + ks;
                  const probe = (k) => k in r ? (typeof r[k] === 'object' && r[k] ? JSON.stringify({x:r[k].x,y:r[k].y}) : String(r[k])) : 'NO';
                  info += ' position=' + probe('position') + ' phase=' + probe('phase') + ' fingerId=' + probe('fingerId');
                  const mangled = Object.keys(r).filter(k => /^[a-z]\$$/.test(k));
                  if (mangled.length) {
                    info += ' mangled=' + mangled.map(k => k + ':' + (typeof r[k] === 'object' && r[k] ? '{' + Object.keys(r[k]).slice(0,3).join(',') + '}' : String(r[k]).slice(0,20))).join(',');
                  }
                }
                console.log('[UI.read#' + calls[fnName] + '] ' + fnName + ' (' + Array.from(arguments).slice(0,3).join(',') + ') → ' + info);
              } else if (calls[fnName] === 50 || calls[fnName] === 200) {
                console.log('[UI.read.cnt] ' + fnName + ' total=' + calls[fnName]);
              }
            } else {
              _log(fnName, '(' + Array.from(arguments).slice(0,3).join(',') + ') → ' + (typeof r === 'object' ? '<obj>' : String(r)));
            }
            return r;
          };
        } catch (e) {}
      }
      // 一次性探测 Bridge.NET Touch 实例的真字段 — 看新建一个是什么样
      try {
        const TC = g.UnityEngine && g.UnityEngine.Touch;
        if (TC) {
          let inst = null;
          try { inst = typeof TC.ctor === 'function' ? new TC.ctor() : null; } catch (e) {}
          if (!inst && TC.$initMembers) { try { inst = {}; TC.$initMembers.call(inst); } catch (e) {} }
          if (inst) {
            const ks = Object.keys(inst).slice(0, 30).join(',');
            const desc = {};
            for (const k of Object.keys(inst).slice(0, 30)) {
              try {
                const d = Object.getOwnPropertyDescriptor(inst, k);
                if (d) desc[k] = d.get ? 'GET' : (typeof d.value);
              } catch (_) {}
            }
            console.log('[UI.touch-probe] new Touch.ctor() keys=' + ks);
            console.log('[UI.touch-probe] new Touch.ctor() desc=' + JSON.stringify(desc));
            // proto chain
            const proto = Object.getPrototypeOf(inst);
            if (proto) {
              const protoKs = Object.getOwnPropertyNames(proto).slice(0, 30).join(',');
              console.log('[UI.touch-probe] Touch.prototype keys=' + protoKs);
            }
          } else {
            console.log('[UI.touch-probe] could not construct Touch instance');
          }
        }
      } catch (e) { console.log('[UI.touch-probe] threw:', e && e.message); }
      console.log('[UI.instrument] hooks installed');
    }

    function _injectUIState() {
      const UI = g.UnityEngine && g.UnityEngine.Input;
      if (!UI || !__uiInjectState) return;
      const s = __uiInjectState;
      __uiInjectFrameCnt++;
      // Release sequencing: touchend 帧不能立刻 active=false (touchCount→0, EventSystem 这帧
      // 直接 return, 永远收不到 mockT.phase=Ended → joystick 不释放, 角色继续走)。
      // 改成 touchend 后再保留 active=true 跑几个 keepalive tick (mockT.phase 已是 3=Ended),
      // 让 EventSystem 至少 poll 到一次 Ended, OnPointerUp 才会 fire; 之后再 active=false。
      if (s.endedTickCount != null) {
        s.endedTickCount++;
        if (s.endedTickCount >= 3) s.active = false;
      }
      // mousePosition (Vector3)
      const V3 = g.UnityEngine && g.UnityEngine.Vector3;
      let posVec = null;
      if (V3 && typeof V3.ctor === 'function') { try { posVec = new V3.ctor(s.ux, s.uy, 0); } catch (e) {} }
      if (!posVec) posVec = { x: s.ux, y: s.uy, z: 0, _data: [s.ux, s.uy, 0] };
      try { UI.W$ = posVec; } catch (e) {}
      try { UI.mousePosition = posVec; } catch (e) {}
      try { UI.J$ = posVec; } catch (e) {}
      try { UI.multiTouchEnabled = true; } catch (e) {}
      // mouseButtons[0] 持续 true 直到 touchend
      if (Array.isArray(UI.z$) && UI.z$.length >= 1) UI.z$[0] = s.active;
      // mouseButtonsDown[0] 仅这一帧 true (Unity 语义), 应用后置 false
      if (Array.isArray(UI.A$) && UI.A$.length >= 1) UI.A$[0] = s.isDown;
      if (Array.isArray(UI.B$) && UI.B$.length >= 1) UI.B$[0] = s.isUp;
      if (s.active && s.mockT) {
        try { UI.touches = [s.mockT]; } catch (e) {}
        try { UI.X$ = [s.mockT]; } catch (e) {}
        try { UI.G$ = 1; } catch (e) {}
        try { UI.V$ = 1; } catch (e) {}
      } else {
        try { UI.touches = []; } catch (e) {}
        try { UI.X$ = []; } catch (e) {}
        try { UI.G$ = 0; } catch (e) {}
        try { UI.V$ = 0; } catch (e) {}
      }
      // 一帧后清掉 isDown/isUp (Unity GetMouseButtonDown/Up 只那一帧 true)
      s.isDown = false;
      s.isUp = false;
      // 第 1 / 30 / 100 帧再 dump 一次, 看 game 有没有读
      if (__uiInjectFrameCnt === 1 || __uiInjectFrameCnt === 30 || __uiInjectFrameCnt === 100) {
        try {
          console.log('[UI.keep#' + __uiInjectFrameCnt + '] readback: mousePos={x:' + (UI.mousePosition && UI.mousePosition.x) + ',y:' + (UI.mousePosition && UI.mousePosition.y) +
                       '} GetMouseButton(0)=' + (typeof UI.GetMouseButton === 'function' ? UI.GetMouseButton(0) : '?') +
                       ' touchCount=' + UI.touchCount + ' z$[0]=' + (UI.z$ && UI.z$[0]));
        } catch (e) {}
      }
    }

    function _setUITouchState(type, ux, uy, fingerObj) {
      // ux/uy 已是 Unity 坐标系 (Y 朝上,DOM Y 翻转过). caller 在 dispatchTouch 里转换。
      const isStart = (type === 'touchstart');
      const isEnd   = (type === 'touchend' || type === 'touchcancel');
      const fingerId = (fingerObj && fingerObj.identifier) || 0;
      // 上一帧位置 — 用来算 deltaPosition. 没 delta → 摇杆识别不到"移动",character 不动。
      const prevUx = __uiInjectState && __uiInjectState.ux != null ? __uiInjectState.ux : ux;
      const prevUy = __uiInjectState && __uiInjectState.uy != null ? __uiInjectState.uy : uy;
      const dx = isStart ? 0 : (ux - prevUx);
      const dy = isStart ? 0 : (uy - prevUy);
      // 构造 Bridge.NET Vector2 — Bridge.NET 重载约定: ctor 是 no-arg, $ctor1 是 (x,y) 重载。
      const V2 = g.UnityEngine && g.UnityEngine.Vector2;
      function mkV2(x, y) {
        if (V2) {
          if (typeof V2.$ctor1 === 'function') {
            try { return new V2.$ctor1(x, y); } catch (e) {}
          }
          if (typeof V2.ctor === 'function') {
            let v = null;
            try { v = new V2.ctor(); } catch (e) {}
            if (v) {
              try { v.x = x; v.y = y; } catch (e) {}
              try { if (Array.isArray(v._data) && v._data.length >= 2) { v._data[0] = x; v._data[1] = y; } } catch (e) {}
              return v;
            }
          }
        }
        return { x: x, y: y, _data: [x, y] };
      }
      // 复用 mockT 实例 (touchstart 才新建; touchmove 改字段)
      let mockT = __uiInjectState && __uiInjectState.mockT;
      if (isStart || !mockT) {
        const TC = g.UnityEngine && g.UnityEngine.Touch;
        mockT = null;
        if (TC && typeof TC.ctor === 'function') { try { mockT = new TC.ctor(); } catch (e) {} }
        if (!mockT) mockT = {};
      }
      // 实测: Bridge.NET Touch.ctor() 把 m_Position/m_PositionDelta 编为 Vector2 backing field
      // (mangled h$/o$). Vector2 在 C# 是 struct, Bridge.NET 公共 accessor `position` 的 getter
      // 走 `this.h$.$clone()` 返 COPY → mutate copy 不会写回 h$, public setter 也走 $clone
      // 把 input 拷一份存进去 — 我们传 plain {x,y,_data} 时 $clone 抛错 (没 $clone method)
      // 被 try 吞了, 永远写不进。
      // 唯一靠谱的: (1) Object.defineProperty 强制覆盖 instance accessor — getter 直接返我们的值;
      //              (2) 同时 mutate h$/o$ backing — 兜底, 万一 instance accessor 被代码访问 prototype 路径绕开。
      function forceGetter(key, factory) {
        try { Object.defineProperty(mockT, key, { configurable: true, enumerable: true, get: factory }); return true; } catch (e) { return false; }
      }
      // (1) instance accessor 覆盖 — Bridge.NET 把 accessor 定义在 prototype, 在 instance 上 defineProperty 优先生效。
      // position/rawPosition 跟随 __uiInjectState (live ref), deltaPosition/phase 用闭包静态值
      // (回退之前激进衰减; 真正"角色释放后停下"靠 touchCount=0 短路, 不靠 phase 衰减)
      forceGetter('position',      function () { return mkV2(__uiInjectState ? __uiInjectState.ux : ux, __uiInjectState ? __uiInjectState.uy : uy); });
      forceGetter('rawPosition',   function () { return mkV2(__uiInjectState ? __uiInjectState.ux : ux, __uiInjectState ? __uiInjectState.uy : uy); });
      forceGetter('deltaPosition', function () { return mkV2(dx, dy); });
      forceGetter('phase',         function () { return isStart ? 0 : (type === 'touchmove' ? 1 : 3); });
      forceGetter('fingerId',      function () { return fingerId; });
      forceGetter('tapCount',      function () { return 1; });
      forceGetter('pressure',      function () { return 1; });
      forceGetter('deltaTime',     function () { return 0.016; });
      forceGetter('type',          function () { return 0; });
      // (2) 直接改 mangled backing (h$=position, o$=positionDelta — 从 [UI.read GetTouch] dump 反推)。
      try {
        const h = mockT.h$;
        if (h && typeof h === 'object') {
          h.x = ux; h.y = uy;
          if (Array.isArray(h._data) && h._data.length >= 2) { h._data[0] = ux; h._data[1] = uy; }
        }
      } catch (e) {}
      try {
        const o = mockT.o$;
        if (o && typeof o === 'object') {
          o.x = dx; o.y = dy;
          if (Array.isArray(o._data) && o._data.length >= 2) { o._data[0] = dx; o._data[1] = dy; }
        }
      } catch (e) {}
      // 数值字段 — 没 struct 问题, 直接写
      try { mockT.maximumPossiblePressure = 1; } catch (e) {}
      try { mockT.radius = 1; mockT.radiusVariance = 0; } catch (e) {}
      try { mockT.altitudeAngle = 0; mockT.azimuthAngle = 0; } catch (e) {}
      // 前 3 次 touchstart dump read-back — 验证 forceGetter 是否生效
      g.__mockTDumpCnt = (g.__mockTDumpCnt || 0);
      if (isStart && g.__mockTDumpCnt < 3) {
        g.__mockTDumpCnt++;
        try {
          const pos = mockT.position, rpos = mockT.rawPosition, dlt = mockT.deltaPosition;
          const h = mockT.h$, o = mockT.o$;
          console.log('[!!MOCKT#' + g.__mockTDumpCnt + '!!] readback pos={x:' + (pos && pos.x) + ',y:' + (pos && pos.y) +
                        '} delta={x:' + (dlt && dlt.x) + ',y:' + (dlt && dlt.y) +
                        '} phase=' + mockT.phase + ' fingerId=' + mockT.fingerId +
                        ' h$={x:' + (h && h.x) + ',y:' + (h && h.y) +
                        '} o$={x:' + (o && o.x) + ',y:' + (o && o.y) +
                        '} | wrote ux=' + ux + ' uy=' + uy + ' dx=' + dx + ' dy=' + dy);
        } catch (e) { console.log('[!!MOCKT!!] dump threw: ' + (e && e.message)); }
      }
      // phase: Began(0)/Moved(1)/Stationary(2)/Ended(3)/Canceled(4)
      // 这一帧设当前事件 phase, 下帧由 _injectUIState 衰减到 Stationary
      const initialPhase = isStart ? 0 : (type === 'touchmove' ? 1 : (isEnd ? 3 : 2));
      __uiInjectState = {
        // touchend 帧保持 active=true (touchCount 仍 1) 让 Unity EventSystem 这帧能进 poll
        // 看到 mockT.phase=Ended → 派 OnPointerUp; 真正的 active=false 由 endedTickCount 推进。
        active: true, ux: ux, uy: uy, dx: isEnd ? 0 : dx, dy: isEnd ? 0 : dy,
        phase: initialPhase, fingerId: fingerId,
        mockT: mockT, isDown: isStart, isUp: isEnd,
        endedAt: isEnd ? Date.now() : 0,
        endedTickCount: isEnd ? 0 : null,
      };
      // 装 hook (一次性)
      _instrumentUIRead();
      // 立刻应用 + 启动 keepalive
      _injectUIState();
      if (!__uiInjectTimer) {
        __uiInjectTimer = setInterval(function () {
          _injectUIState();
          // touchend 后 200ms 停 timer
          if (__uiInjectState && !__uiInjectState.active && __uiInjectState.endedAt &&
              Date.now() - __uiInjectState.endedAt > 200) {
            __uiInjectState = null;
            clearInterval(__uiInjectTimer);
            __uiInjectTimer = null;
            console.log('[UI.keep] timer stopped after touch released');
          }
        }, 16);
      }
    }

    function dispatchTouch(type, res) {
      const list = (res.touches || []).map(makeTouchObj);
      const changed = (res.changedTouches || res.touches || []).map(makeTouchObj);
      const ev = {
        type,
        touches: list,
        changedTouches: changed,
        targetTouches: list,
        timeStamp: res.timeStamp || Date.now(),
        target: g.canvas,
        currentTarget: g.canvas,
        preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
        isTrusted: true, bubbles: true, cancelable: true,
      };
      // 取触点坐标 (touchend 用最后已知坐标, 因为 changedTouches[0] 才有点)
      const pt = list[0] || changed[0];
      const px = pt ? pt.clientX : __lastTouchPos.x;
      const py = pt ? pt.clientY : __lastTouchPos.y;
      if (pt) __lastTouchPos = { x: px, y: py };

      const __isLogTouch = __touchDispatchCnt < 5;
      if (__isLogTouch) {
        __touchDispatchCnt++;
        console.log('[touch#' + __touchDispatchCnt + '] type=' + type +
                     ' touches=' + list.length + ' x=' + px + ' y=' + py);
        // PC 内部状态 before-emit
        try {
          const _pc = g.pc;
          const _app = (_pc && _pc.Application && _pc.Application.getApplication && _pc.Application.getApplication()) || g.app;
          if (_app) {
            const m = _app.mouse, t = _app.touch;
            console.log('[touch#' + __touchDispatchCnt + '] BEFORE app.mouse=' + (m ? ('en=' + m._enabled + ' tgt=' + (m._target && m._target.constructor && m._target.constructor.name) + ' btns=' + JSON.stringify(m._buttons || [])) : 'NULL') +
                         ' app.touch=' + (t ? ('en=' + t._enabled + ' el=' + (t._element && t._element.constructor && t._element.constructor.name) + ' tn=' + (t._touches ? t._touches.length : 'undef')) : 'NULL'));
          } else {
            console.log('[touch#' + __touchDispatchCnt + '] no app');
          }
        } catch (e) { console.log('[touch#] before-probe threw:', e && e.message); }
      }
      // 1) 派发 touch 事件 (canvas / body / docEl / doc / window)
      __canvasBus.emit(type, ev);
      const doc = g.document;
      if (doc) {
        if (doc.body && doc.body._bus) doc.body._bus.emit(type, ev);
        if (doc.documentElement && doc.documentElement._bus) doc.documentElement._bus.emit(type, ev);
        if (doc._bus) doc._bus.emit(type, ev);
      }
      if (g._winBus) g._winBus.emit(type, ev);

      // 2) 同步合成 mouse 事件 — Luna PC 实际走这条
      const mouseType = TOUCH_TO_MOUSE[type];
      if (mouseType) {
        const mev = makeMouseEv(mouseType, px, py);
        if (g._winBus) g._winBus.emit(mouseType, mev);
        __canvasBus.emit(mouseType, mev);
        if (doc && doc.body && doc.body._bus) doc.body._bus.emit(mouseType, mev);
        if (doc && doc.documentElement && doc.documentElement._bus) doc.documentElement._bus.emit(mouseType, mev);
        if (doc && doc._bus) doc._bus.emit(mouseType, mev);
      }
      // 3) 合成 pointer 事件 (现代游戏多用 PointerEvent, w3c 标准要求 pointerdown 先于 mousedown)
      const POINTER_MAP = { touchstart: 'pointerdown', touchmove: 'pointermove', touchend: 'pointerup', touchcancel: 'pointercancel' };
      const ptype = POINTER_MAP[type];
      if (ptype) {
        const pev = Object.assign(makeMouseEv(ptype, px, py), {
          pointerId: (pt && pt.identifier) || 1, pointerType: 'touch', isPrimary: true,
          width: 1, height: 1, pressure: 0.5, tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0,
        });
        if (g._winBus) g._winBus.emit(ptype, pev);
        __canvasBus.emit(ptype, pev);
        if (doc && doc.body && doc.body._bus) doc.body._bus.emit(ptype, pev);
        if (doc && doc.documentElement && doc.documentElement._bus) doc.documentElement._bus.emit(ptype, pev);
      }
      // 4.5) 直接写 UnityEngine.Input 内部状态 — 用 keepalive timer 保证状态每帧都新鲜
      //     (避免 Luna Input.Update() 万一每帧重置我们的 z$/A$/B$/W$)
      const __scrH = (g._screen && g._screen.cssHeight) || (g.canvas && g.canvas.height) || 1334;
      _setUITouchState(type, px, __scrH - py, pt);
      if (__isLogTouch) {
        try {
          const UI = g.UnityEngine && g.UnityEngine.Input;
          if (UI) {
            console.log('[touch#' + __touchDispatchCnt + '] UI inj: touchCount=' + UI.touchCount +
                         ' GetMouseButton(0)=' + (typeof UI.GetMouseButton === 'function' ? UI.GetMouseButton(0) : 'N/A') +
                         ' GetMouseButtonDown(0)=' + (typeof UI.GetMouseButtonDown === 'function' ? UI.GetMouseButtonDown(0) : 'N/A') +
                         ' z$=' + JSON.stringify(Array.from(UI.z$ || [])) +
                         ' A$=' + JSON.stringify(Array.from(UI.A$ || [])) +
                         ' mousePos={x:' + (UI.mousePosition && UI.mousePosition.x) + ',y:' + (UI.mousePosition && UI.mousePosition.y) + '}' +
                         ' touches.len=' + (UI.touches && UI.touches.length) +
                         ' active=' + (__uiInjectState && __uiInjectState.active));
          }
        } catch (e) { console.log('[UE inject log] threw:', e && e.message); }
      }

      // 4) touchend 后合成 click — body._bus.click 有监听器, 多半是 CTA/UI 按钮
      if (type === 'touchend') {
        const cev = makeMouseEv('click', px, py);
        if (g._winBus) g._winBus.emit('click', cev);
        __canvasBus.emit('click', cev);
        if (doc && doc.body && doc.body._bus) doc.body._bus.emit('click', cev);
      }
      // 派完之后再读一次 — 看 PC Mouse._buttons / TouchDevice._touches 是否被更新
      if (__isLogTouch) {
        try {
          const _pc = g.pc;
          const _app = (_pc && _pc.Application && _pc.Application.getApplication && _pc.Application.getApplication()) || g.app;
          if (_app) {
            const m = _app.mouse, t = _app.touch;
            console.log('[touch#' + __touchDispatchCnt + '] AFTER  app.mouse btns=' + (m ? JSON.stringify(m._buttons || []) : 'NULL') +
                         ' app.touch tn=' + (t && t._touches ? t._touches.length : (t ? 'no-_touches:keys=' + Object.keys(t).slice(0,8).join(',') : 'NULL')));
          }
        } catch (e) { console.log('[touch#] after-probe threw:', e && e.message); }
        // UnityEngine.Input snapshot diff: 哪个 mangled 字段被改了 = touches/mouseButtons 真位置
        try {
          if (g.__UI_snapshotFn && g.__UI_snapshot_initial) {
            const after = g.__UI_snapshotFn();
            const before = g.__UI_snapshot_initial;
            const diffs = [];
            for (const k of Object.keys(after)) {
              if (before[k] !== after[k]) diffs.push(k + ':[' + before[k] + ']→[' + after[k] + ']');
            }
            console.log('[touch#' + __touchDispatchCnt + '] UI diff: ' + (diffs.length ? diffs.slice(0,12).join(' || ') : 'NO_CHANGE'));
          }
        } catch (e) { console.log('[touch#] UI-diff threw:', e && e.message); }
      }
      // 第 1 次真触摸后, 重新 dump bus 状态: 如果 win._bus.mousedown 从 x2 → x1, 说明 PC SoundManager
      // unlock handler 自删了 → 我们 emit 的 mouse 事件确实跑到了真 PC handler
      if (__touchDispatchCnt === 1 && g.__busesForRedump) {
        setTimeout(function () {
          try {
            const B = g.__busesForRedump || {};
            const c = function (b, t) { return b && b._count ? b._count(t) : 'N/A'; };
            console.log('[postTouch] win._bus mousedown=' + c(B.win, 'mousedown') +
                         ' mousemove=' + c(B.win, 'mousemove') +
                         ' mouseup=' + c(B.win, 'mouseup') +
                         ' click=' + c(B.win, 'click') +
                         ' pointerdown=' + c(B.win, 'pointerdown'));
            console.log('[postTouch] body._bus touchstart=' + c(B.body, 'touchstart') +
                         ' click=' + c(B.body, 'click') +
                         ' pointerdown=' + c(B.body, 'pointerdown'));
            console.log('[postTouch] canvas._bus touchstart=' + c(B.canvas, 'touchstart') +
                         ' mousedown=' + c(B.canvas, 'mousedown') +
                         ' pointerdown=' + c(B.canvas, 'pointerdown'));
            // 把目标 listener 源码再 dump 一次, 看哪些 type 多了
            if (B.body && B.body._listSources) {
              console.log('[postTouch] body._bus pointerdown sources: ' + JSON.stringify((B.body._listSources('pointerdown')||[]).map(s => s.replace(/\s+/g,' '))));
            }
          } catch (e) { console.log('[postTouch] dump threw:', e && e.message); }
        }, 50);
      }
    }
    let __touchBound = { start: false, move: false, end: false, cancel: false };
    if (typeof wx !== 'undefined') {
      try { if (typeof wx.onTouchStart  === 'function') { wx.onTouchStart (r => dispatchTouch('touchstart',  r)); __touchBound.start  = true; } } catch (e) { console.log('[bootShim] onTouchStart  bind fail:', e && e.message); }
      try { if (typeof wx.onTouchMove   === 'function') { wx.onTouchMove  (r => dispatchTouch('touchmove',   r)); __touchBound.move   = true; } } catch (e) { console.log('[bootShim] onTouchMove   bind fail:', e && e.message); }
      try { if (typeof wx.onTouchEnd    === 'function') { wx.onTouchEnd   (r => dispatchTouch('touchend',    r)); __touchBound.end    = true; } } catch (e) { console.log('[bootShim] onTouchEnd    bind fail:', e && e.message); }
      try { if (typeof wx.onTouchCancel === 'function') { wx.onTouchCancel(r => dispatchTouch('touchcancel', r)); __touchBound.cancel = true; } } catch (e) { console.log('[bootShim] onTouchCancel bind fail:', e && e.message); }
      console.log('[bootShim] wx touch handlers wired:', JSON.stringify(__touchBound));
    } else {
      console.log('[bootShim] no wx, touch wiring skipped');
    }
  }

  // ---------- window ----------
  // 强制 window = GameGlobal (即 g): playable-libs 可能预置一个 window stub 指到独立对象,
  // 那样 19_pi_runtime 等代码里的 window.addEventListener('luna:start', ...) 注册到独立 bus,
  // 而 game.js 走的 GameGlobal.dispatchEvent 投递到 _winBus, 两边对不上 → startGame 永不触发。
  g.window = g;
  g.self = g;

  // ---------- location (URLSearchParams 在 luna 里用来读 ?soyoo_lang=...) ----------
  if (!g.location) {
    g.location = {
      href: 'wx://luna/', protocol: 'https:', host: 'wx', hostname: 'wx',
      port: '', pathname: '/', search: '', hash: '', origin: 'https://wx',
      reload() {}, replace() {}, assign() {},
    };
  }

  // ---------- URLSearchParams (playable runtime 不一定有) ----------
  if (typeof g.URLSearchParams === 'undefined') {
    g.URLSearchParams = function URLSearchParams(s) {
      const map = new Map();
      const str = (typeof s === 'string') ? (s[0] === '?' ? s.slice(1) : s) : '';
      if (str) for (const part of str.split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const k = i < 0 ? decodeURIComponent(part) : decodeURIComponent(part.slice(0, i));
        const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1));
        map.set(k, v);
      }
      this.get = (k) => map.has(k) ? map.get(k) : null;
      this.has = (k) => map.has(k);
      this.set = (k, v) => map.set(k, String(v));
      this.toString = () => Array.from(map.entries()).map(([k, v]) =>
        encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    };
  }

  // ---------- _compressedAssets (luna ready_glue 等这数组,无分包就给空) ----------
  if (!g._compressedAssets) g._compressedAssets = [];

  // ---------- console 阉割补丁 ----------
  // 试玩 runtime 的 console 只有 log/info/warn/error；PlayCanvas 用 console.assert，Luna 偶尔用 trace/debug/table。
  // 全部缺失项映射到 log，不影响主流程。
  if (typeof console !== 'undefined') {
    const fallback = console.log ? console.log.bind(console) : function () {};
    const ensures = ['assert', 'debug', 'trace', 'table', 'group', 'groupEnd', 'groupCollapsed', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'dir', 'dirxml'];
    for (const k of ensures) {
      if (typeof console[k] !== 'function') {
        // assert 特殊：第一参数是断言，false 时才打印
        if (k === 'assert') {
          console[k] = function (cond /*, ...msg */) { if (!cond) fallback.apply(null, ['[assert]'].concat(Array.prototype.slice.call(arguments, 1))); };
        } else {
          console[k] = fallback;
        }
      }
    }
  }

  // ---------- Luna namespace stub (静态最小集) ----------
  // 历史: 之前用 auto-vivifying Proxy 占位, 期望"任意深路径写都不爆"。
  // 但 Luna 自身的 type walker (`getTypeNamespace` ↔ `getTypeFullName` 互递归) 假设
  // namespace 链有限; Proxy 让 `x.namespace.namespace.namespace...` 无限延伸 → 直接 RangeError 爆栈。
  // 现在: 只放一个静态 root + 一个 Unity.Playable 子节点 (wx-ad-bridge 唯一会写的路径)。
  // Luna runtime 自己会把真正的类型挂到 g.Luna 子树上 (它写就写覆盖, 静态对象不挡路)。
  // 如果将来真出现 "Cannot set properties of undefined" 的具体路径, 在这里加那一条具体路径,
  // 不要回退到 Proxy。
  if (typeof g.Luna === 'undefined') {
    g.Luna = { Unity: { Playable: {} } };
  }

  // ---------- Bridge (IAB MRAID Bridge stub) ----------
  // playable-libs 编译产物里直接引用 `Bridge` 全局（<anonymous>:124:2097），没有就 ReferenceError。
  // 我们没真 Bridge，给个 ready→立即回调 的 stub，让那条路径不爆。
  if (typeof g.Bridge === 'undefined') {
    g.Bridge = {
      ready(cb) { try { cb && cb(); } catch (e) { console.error('[Bridge.ready] cb threw', e); } },
      // 占位：playable-libs 可能再调 .send / .register 之类，全部 noop 不爆
      send() {}, register() {}, on() {}, off() {}, emit() {},
    };
  }

  // ---------- crypto (luna webpack 用 crypto.getRandomValues 做 uuidv4) ----------
  if (typeof g.crypto === 'undefined') {
    g.crypto = {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0;
        return arr;
      },
      randomUUID() {
        const b = new Uint8Array(16);
        for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      },
    };
  }

  // ---------- WebAssembly.RuntimeError / .CompileError / .LinkError (playable WebAssembly 阉了) ----------
  if (typeof g.WebAssembly !== 'undefined') {
    for (const k of ['RuntimeError', 'CompileError', 'LinkError']) {
      if (typeof g.WebAssembly[k] !== 'function') {
        g.WebAssembly[k] = function (msg) { const e = new Error(msg); e.name = 'WebAssembly.' + k; return e; };
      }
    }

    // ---------- WebAssembly.instantiate → WXWebAssembly.instantiate(static .wasm.br) ----------
    // WeChat 试玩 runtime 的 WXWebAssembly.instantiate 只吃文件路径，不吃 buffer。
    // Luna 把 Box2D + Mecanim 两份 WASM 当 base64 data: URI 直接 atob 后 instantiate(buffer,...)。
    // build 时已经用 extract-wasm.cjs 把这两个模块解出来 → box2d.wasm.br / mecanim.wasm.br。
    // 这里按 byteLength 把调用改路成 WXWebAssembly.instantiate('<name>.wasm.br', imports)。
    // byteLength 以 extract-wasm.cjs 输出的 luna-wasm.json 为准；换 Luna 包时重跑脚本会更新两个文件，
    // 然后**回来更新这张 size→file 表**(脚本在末尾 console.error 打印 manifest)。
    // 路径加载 manifest（按 byteLength → 包内文件）。两份都用 .br 压缩省主包体积。
    const _wasmFiles = {
      168334: 'box2d.wasm.br',
      271539: 'mecanim.wasm.br',
    };
    // imports 处理模式：'pass'(默认，原样传) / 'clean'(包一层 thunk) / 'noop'(全 noop) / 'noop-arity'(按 arity noop)
    // 默认 pass：根因（monkey-patch 递归）已通过 unpatch 解决，emscripten 原 imports 直接可用。
    function cleanImports(imp) {
      const mode = (typeof globalThis !== 'undefined' && globalThis.__WASM_IMPORT_MODE) || 'pass';
      if (!imp || typeof imp !== 'object') return imp;
      const out = {};
      for (const m of Object.keys(imp)) {
        const mod = imp[m];
        if (!mod || typeof mod !== 'object') { out[m] = mod; continue; }
        const dst = {};
        for (const n of Object.keys(mod)) {
          const v = mod[n];
          if (typeof v !== 'function') { dst[n] = v; continue; }
          if (mode === 'pass') dst[n] = v;
          else if (mode === 'clean') dst[n] = function () { return v.apply(null, arguments); };
          else if (mode === 'noop') dst[n] = function () { return 0; };
          else if (mode === 'noop-arity') {
            // 用 v.length 模拟 arity（不一定准但有时候 trigger 不同 path）
            dst[n] = new Function(...Array(v.length).fill(0).map((_, i) => 'a' + i), 'return 0');
          }
          else dst[n] = v;
        }
        out[m] = dst;
      }
      return out;
    }

    // 保存原始引用。WXWebAssembly bridge 内部会回调 WebAssembly.instantiate(path, ...)。
    // 解法：在 redirect 前临时把 WebAssembly.instantiate 还原为原函数，emscripten 一次成功后永久不再 patch。
    const _origInstantiate = g.WebAssembly.instantiate;
    const _ourShim = function (arg, imports) {
      console.log('[WASM-SHIM] called argType=' + (typeof arg) + (arg && arg.byteLength != null ? ' len=' + arg.byteLength : ''));
      // 字符串路径 — 走原 bridge
      if (typeof arg === 'string') {
        return _origInstantiate.apply(this, arguments);
      }
      let bytes = null;
      if (arg instanceof ArrayBuffer) bytes = new Uint8Array(arg);
      else if (arg && arg.buffer instanceof ArrayBuffer) bytes = new Uint8Array(arg.buffer, arg.byteOffset || 0, arg.byteLength);
      const len = bytes ? bytes.length : -1;
      const file = _wasmFiles[len];
      if (!file) {
        const head = bytes ? Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' ') : '<no-bytes>';
        console.error('[WASM] unknown buffer len=' + len + ' head=' + head + ' — update _wasmFiles in dom-shim.js');
        return Promise.reject(new Error('unmapped WASM buffer length=' + len));
      }
      // 默认 'pass'：原样转发 emscripten 的 imports；unpatch 切断递归后已不需要 noop 替换。
      // 仍可通过 globalThis.__WASM_IMPORT_MODE 切到 clean/noop/noop-arity 调试。
      const mode = (typeof globalThis !== 'undefined' && globalThis.__WASM_IMPORT_MODE) || 'pass';
      if (imports && typeof imports === 'object') {
        const topo = Object.keys(imports).map(k => k + ':' + (typeof imports[k]) + '(' + (imports[k] && typeof imports[k] === 'object' ? Object.keys(imports[k]).length : '?') + ')').join(',');
        console.log('[WASM] imports top-level = {' + topo + '}');
      }
      const cleaned = cleanImports(imports);
      console.log('[WASM] redirect len=' + len + ' -> ' + file + ' mode=' + mode + ' defer=setTimeout+unpatch');
      // 关键：WXWebAssembly === WebAssembly (或 WXWebAssembly impl 在内部 resolves WebAssembly.instantiate at runtime)
      // 若我们 patch 仍 active, 内部会递归撞回 _ourShim 死循环。
      // 因此: setTimeout 切到全新栈, 还原 WebAssembly.instantiate 为原函数, 再调用. emscripten 成功后不再需要 patch.
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          console.log('[WASM] unpatching WebAssembly.instantiate, calling original with path=' + file);
          g.WebAssembly.instantiate = _origInstantiate;  // 还原, 不再 patch
          try {
            _origInstantiate.call(g.WebAssembly, file, cleaned).then(
              v => { console.log('[WASM] OK exports first=' + Object.keys(v.instance.exports).slice(0,3).join(',')); resolve(v); },
              e => { console.error('[WASM] FAIL', e && e.message || e); reject(e); }
            );
          } catch (e) { console.error('[WASM] sync throw', e && e.message || e); reject(e); }
        }, 0);
      });
    };
    // 装上 patch
    g.WebAssembly.instantiate = _ourShim;
  }

  // ---------- document ----------
  if (!g.document) {
    const eventBus = makeEmitter();
    const elements = new Map();
    elements.set('application-canvas', g.canvas);

    // playable-libs 在 wx.onShow/onHide "manually adapt" 路径会给 documentElement / body / canvas 绑监听器，
    // 都得有 addEventListener；用同一个 eventBus 让事件互通，避免出现"绑了但永不触发"的死表面。
    const docElEvents = makeEmitter();
    const bodyEvents = makeEmitter();
    const headEvents = makeEmitter();
    const canvasEvents = makeEmitter();
    const evApi = (bus) => ({
      addEventListener: (t, cb) => bus.on(t, cb),
      removeEventListener: (t, cb) => bus.off(t, cb),
      dispatchEvent: (ev) => { bus.emit(ev && ev.type, ev); return true; },
    });

    g.document = {
      readyState: 'loading',
      // PlayCanvas Application 启动期会查这俩判断窗口可见性 (页面 visibility / 焦点)
      hasFocus: () => true,
      hidden: false,
      visibilityState: 'visible',
      title: '',
      documentElement: Object.assign({ style: {}, _bus: docElEvents }, evApi(docElEvents)),
      body: Object.assign({ style: {}, appendChild() {}, removeChild() {}, _bus: bodyEvents }, evApi(bodyEvents)),
      head: Object.assign({ appendChild() {}, removeChild() {}, _bus: headEvents }, evApi(headEvents)),

      getElementById(id) {
        const el = elements.get(id) || null;
        if (typeof GameGlobal.PROBE === 'function') {
          const tag = el && el.tagName || (el === null ? 'null' : typeof el);
          const hasLoad = el && typeof el.load === 'function';
          GameGlobal.PROBE('[gEBI] id=' + JSON.stringify(String(id).slice(0,80)) + ' tag=' + tag + ' load=' + hasLoad + ' size=' + elements.size);
        }
        return el;
      },
      // Luna 的 base122 资源扫描走这里, 微信下我们改为 asset-inject 主动喂, 这里返回空
      querySelectorAll(sel) {
        if (sel === '[data-src122]') return [];
        return [];
      },
      querySelector(sel) {
        if (sel === '#application-canvas') return g.canvas;
        return null;
      },
      createElement(tag) {
        tag = String(tag).toLowerCase();
        if (tag === 'canvas') {
          const c = wx.createCanvas();
          // wx 原生 canvas 缺 W3C HTMLCanvasElement 的 .load/.remove/addEventListener.
          // Luna asset 加载完后会 .remove() offscreen canvas → TypeError 整个 bundle 失败。
          if (typeof c.load !== 'function') c.load = () => {};
          if (typeof c.remove !== 'function') c.remove = () => {};
          if (typeof c.addEventListener !== 'function') c.addEventListener = () => {};
          if (typeof c.removeEventListener !== 'function') c.removeEventListener = () => {};
          if (typeof c.setAttribute !== 'function') c.setAttribute = () => {};
          if (typeof c.getAttribute !== 'function') c.getAttribute = () => null;
          if (!c.style) c.style = {};
          if (!c.dataset) c.dataset = {};
          if (!c.tagName) c.tagName = 'CANVAS';
          return c;
        }
        if (tag === 'img' || tag === 'image') return new ImageShim();
        if (tag === 'video') return new VideoShim();
        if (tag === 'audio') return new AudioShim();
        if (tag === 'style' || tag === 'link') return makeNoop(tag);
        if (tag === 'script') return makeNoop(tag);
        return makeNoop(tag);
      },
      addEventListener: (type, cb) => eventBus.on(type, cb),
      removeEventListener: (type, cb) => eventBus.off(type, cb),
      dispatchEvent: (ev) => eventBus.emit(ev.type, ev),
      _bus: eventBus,
      _registerElement(id, el) {
        // 注册前补齐 W3C 方法 — 主要救 wx.createImage 返回的对象 (frozen, 直接赋值不上).
        // Luna video/image handler `n.onloadeddata=...,n.load()` 缺 .load/.remove 直接 TypeError → 黑屏.
        if (el && typeof el === 'object') {
          if (typeof el.load               !== 'function') try { el.load               = function () {}; } catch (e) {}
          if (typeof el.remove             !== 'function') try { el.remove             = function () {}; } catch (e) {}
          if (typeof el.addEventListener   !== 'function') try { el.addEventListener   = function () {}; } catch (e) {}
          if (typeof el.removeEventListener!== 'function') try { el.removeEventListener= function () {}; } catch (e) {}
          // 如果直接赋值赋不上 (defineProperty 锁住了), 用 Object.defineProperty 强行覆盖
          if (typeof el.load !== 'function')   try { Object.defineProperty(el, 'load',   { value: function () {}, writable: true, configurable: true }); } catch (e) {}
          if (typeof el.remove !== 'function') try { Object.defineProperty(el, 'remove', { value: function () {}, writable: true, configurable: true }); } catch (e) {}
          // 视频 handler `n.onloadeddata = function(t){e.b$(n)},n.load()` —
          // wx.Image 即使 .load() 是 noop, e.b$(n) 永不触发 → InitializeAsync 永不 resolve.
          // 给 .load 一个会异步触发 onloadeddata/onload 的实现:
          try {
            const __orig_load = el.load;
            Object.defineProperty(el, 'load', { value: function () {
              setTimeout(() => {
                try { if (typeof el.onloadeddata === 'function') el.onloadeddata({ type: 'loadeddata', target: el }); } catch (e) {}
                try { if (typeof el.oncanplay     === 'function') el.oncanplay({ type: 'canplay', target: el }); } catch (e) {}
              }, 0);
              return __orig_load && __orig_load.apply(el, arguments);
            }, writable: true, configurable: true });
          } catch (e) {}
        }
        elements.set(id, el);
      },
    };
  }

  // ---------- window addEventListener ----------
  // 试玩 runtime 自带的 g.addEventListener 是 playable-libs 包过的有 bug stub
  // (有时候根本不投递事件), 强制覆盖 — 否则 wx-ad-bridge 的 luna:build → luna:start
  // 信号链路丢失, startGame() 永不触发, 整局黑屏。同时一定挂上 _winBus 给 bridge 用。
  {
    const winBus = makeEmitter();
    g.addEventListener = (type, cb) => winBus.on(type, cb);
    g.removeEventListener = (type, cb) => winBus.off(type, cb);
    g.dispatchEvent = (ev) => { winBus.emit(ev && ev.type, ev); return true; };
    g._winBus = winBus;
  }

  // ---------- Event ----------
  if (typeof g.Event === 'undefined') {
    g.Event = function Event(type, init) { this.type = type; Object.assign(this, init || {}); };
  }
  // PlayCanvas Mouse._handleMove 构造 MouseEvent 时做 `event instanceof WheelEvent` 检查 →
  // 试玩 runtime 没 WheelEvent → ReferenceError → 整条 _handleMove 抛错 → 摇杆 touchmove 完全失效。
  // 同步补齐 W3C 常见 Event 子类, 让 instanceof / new 都不炸 (返回 false / 普通对象即可)。
  function _mkEv(defaults) {
    return function (typeOrSrc, init) {
      // 兼容两种调用: new XEvent('click', {...}) 和 new MouseEvent(this, srcEvt) (PC 内部用法)
      if (typeOrSrc && typeof typeOrSrc === 'object') {
        Object.assign(this, defaults, typeOrSrc, init || {});
        if (init && init.type) this.type = init.type;
      } else {
        this.type = typeOrSrc || '';
        Object.assign(this, defaults, init || {});
      }
    };
  }
  if (typeof g.MouseEvent    === 'undefined') g.MouseEvent    = _mkEv({ clientX: 0, clientY: 0, screenX: 0, screenY: 0, pageX: 0, pageY: 0, button: 0, buttons: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, movementX: 0, movementY: 0 });
  if (typeof g.WheelEvent    === 'undefined') g.WheelEvent    = _mkEv({ deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, wheelDelta: 0, wheelDeltaX: 0, wheelDeltaY: 0 });
  if (typeof g.KeyboardEvent === 'undefined') g.KeyboardEvent = _mkEv({ key: '', code: '', keyCode: 0, which: 0, charCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false });
  if (typeof g.TouchEvent    === 'undefined') g.TouchEvent    = _mkEv({ touches: [], targetTouches: [], changedTouches: [] });
  if (typeof g.PointerEvent  === 'undefined') g.PointerEvent  = _mkEv({ clientX: 0, clientY: 0, pointerId: 1, pointerType: 'touch', isPrimary: true, width: 1, height: 1, pressure: 0.5 });
  if (typeof g.FocusEvent    === 'undefined') g.FocusEvent    = _mkEv({});
  if (typeof g.InputEvent    === 'undefined') g.InputEvent    = _mkEv({ data: '', inputType: '' });
  if (typeof g.UIEvent       === 'undefined') g.UIEvent       = _mkEv({ detail: 0 });
  if (typeof g.DragEvent     === 'undefined') g.DragEvent     = _mkEv({ dataTransfer: null });
  if (typeof g.ClipboardEvent=== 'undefined') g.ClipboardEvent= _mkEv({ clipboardData: null });

  // ---------- URL.createObjectURL ----------
  if (!g.URL) g.URL = {};
  if (!g.URL.createObjectURL) {
    let seq = 0;
    const blobMap = new Map();
    g.URL.createObjectURL = (blob) => {
      const url = `blob:luna/${++seq}`;
      blobMap.set(url, blob);
      return url;
    };
    g.URL.revokeObjectURL = (url) => blobMap.delete(url);
    g.URL._blobMap = blobMap;
  }

  // ---------- Blob ----------
  if (typeof g.Blob === 'undefined') {
    g.Blob = function Blob(parts, opts) {
      this.parts = parts || [];
      this.type = (opts && opts.type) || '';
      this.size = (parts || []).reduce((a, p) =>
        a + (p && p.byteLength != null ? p.byteLength : (p && p.length) || 0), 0);
    };
    g.Blob.prototype.arrayBuffer = function () {
      const total = this.size;
      const u8 = new Uint8Array(total);
      let off = 0;
      for (const p of this.parts) {
        const view = p instanceof ArrayBuffer ? new Uint8Array(p)
                   : p && p.buffer ? new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength)
                   : new TextEncoder().encode(String(p));
        u8.set(view, off);
        off += view.byteLength;
      }
      return Promise.resolve(u8.buffer);
    };
  }

  // ---------- localStorage (Luna playerPrefs) ----------
  // wx 试玩 runtime 的 wx.getStorageSync(k) 在 key 不存在时 console.error("Error: 未找到保存的数据") 再 throw,
  // try/catch 包不住打印 → 走纯内存 Map, 试玩广告 session 短不需要持久化。
  if (!g.localStorage) {
    const __mem = new Map();
    g.localStorage = {
      getItem(k) { return __mem.has(k) ? __mem.get(k) : null; },
      setItem(k, v) { __mem.set(k, String(v)); },
      removeItem(k) { __mem.delete(k); },
      clear() { __mem.clear(); },
      get length() { return __mem.size; },
      key(i) { return Array.from(__mem.keys())[i] || null; },
    };
  }

  // ---------- navigator ----------
  if (!g.navigator) {
    const sys = (() => { try { return wx.getSystemInfoSync(); } catch (e) { return {}; } })();
    g.navigator = {
      userAgent: `Mozilla/5.0 (${sys.platform || 'wx'}) WeChat/${sys.version || ''}`,
      language: sys.language || 'en-US',
      languages: [sys.language || 'en-US'],
      platform: sys.platform || 'wx',
      vendor: 'WeChat',
    };
  }

  // ---------- requestAnimationFrame (window + canvas 都包) ----------
  // Luna/PlayCanvas 实际上很可能直接调 `canvas.requestAnimationFrame` (wx 小游戏风格 API),
  // 完全绕过 window.requestAnimationFrame。同时把 window 的 RAF 路由到 canvas RAF 上,
  // 保证渲染循环一定能跑起来。
  {
    const rawWinRaf = (typeof g.requestAnimationFrame === 'function')
      ? g.requestAnimationFrame.bind(g)
      : g.canvas.requestAnimationFrame.bind(g.canvas);
    const rawWinCaf = (typeof g.cancelAnimationFrame === 'function')
      ? g.cancelAnimationFrame.bind(g)
      : g.canvas.cancelAnimationFrame.bind(g.canvas);
    g.requestAnimationFrame = function (cb) { return rawWinRaf(cb); };
    g.cancelAnimationFrame = rawWinCaf;
  }

  // ---------- performance ----------
  if (!g.performance) {
    g.performance = { now: () => Date.now() };
  }

  // 注: 不在 dom-shim 里自动 dispatch DOMContentLoaded ——
  // 由 game.js 在 require 完所有主包脚本之后显式 dispatch, 保证时序正确.
  g._dispatchReady = function () {
    g.document.readyState = 'complete';
    g.dispatchEvent(new g.Event('DOMContentLoaded'));
    g.dispatchEvent(new g.Event('load'));
  };

  // ---------- helpers ----------
  function makeEmitter() {
    const map = new Map();
    return {
      on(type, cb) { (map.get(type) || map.set(type, new Set()).get(type)).add(cb); },
      off(type, cb) { const s = map.get(type); if (s) s.delete(cb); },
      emit(type, ev) { const s = map.get(type); if (s) for (const cb of s) try { cb(ev); } catch (e) { console.error(e); } },
      _types() { return Array.from(map.keys()); },
      _count(type) { const s = map.get(type); return s ? s.size : 0; },
      _listSources(type) {
        const s = map.get(type);
        if (!s) return [];
        const out = [];
        for (const cb of s) {
          try { out.push(String(cb).slice(0, 300)); } catch (e) { out.push('<toString fail>'); }
        }
        return out;
      },
    };
  }
  function makeNoop(tag) {
    return {
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
      setAttribute() {}, getAttribute() { return null; },
      appendChild() {}, removeChild() {},
      addEventListener() {}, removeEventListener() {},
      load() {}, remove() {}, click() {}, focus() {}, blur() {},
      parentNode: null,
    };
  }
  function ImageShim() {
    this.src = ''; this.onload = null; this.onerror = null;
    this.width = 0; this.height = 0;
    Object.defineProperty(this, '_real', {
      get() {
        if (!this.__real) this.__real = wx.createImage();
        return this.__real;
      }
    });
    const self = this;
    Object.defineProperty(this, 'src', {
      get() { return self._real.src; },
      set(v) {
        const real = self._real;
        real.onload = function () {
          self.width = real.width; self.height = real.height;
          if (self.onload) self.onload();
        };
        real.onerror = (e) => { if (self.onerror) self.onerror(e); };
        real.src = v;
      },
    });
    // Luna asset loader 在某些路径下调 image.load() / image.remove() — HTMLImageElement
    // 标准没 load(), 但 HTMLMediaElement 有, Luna 内部可能复用. 给个 noop 防止 TypeError 中断 bundle.
    this.load = () => {};
    this.remove = () => {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }
  function VideoShim() {
    // Luna 启动期不一定播放, 仅暴露占位接口; 真要播放走 luna-to-wx/video.js
    this.src = ''; this.muted = true; this.autoplay = false; this.loop = false;
    this.currentTime = 0; this.duration = 0; this.paused = true;
    this.style = {};
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.play = () => Promise.resolve();
    this.pause = () => {};
    this.load = () => {};
    this.remove = () => {};
  }
  // 音频桥接: window.sounds[url] = ArrayBuffer (raw mp3 via decompressArrayBuffer/false).
  // 试玩 runtime 的 wx.env.USER_DATA_PATH = "/" 且 writeFileSync 不可用 (vConsole 实测确认),
  // 所以只能走 data URI: data:audio/mpeg;base64,... 喂给 wx.createInnerAudioContext.src。
  // 真机测试: wx.createInnerAudioContext 在试玩 runtime 接受 data URI (sound runtime 来源)。
  const __audioFileCache = new Map();
  function __abToBase64(buf) {
    // 高效 base64: chunk 处理避免 String.fromCharCode(...giantArray) 爆栈
    const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    }
    // wx 提供 btoa? 大概率有, fallback 自实现
    if (typeof btoa === 'function') return btoa(bin);
    if (typeof g.btoa === 'function') return g.btoa(bin);
    // 退化路径: 自己 base64 (字符表)
    const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bin.length; i += 3) {
      const a = bin.charCodeAt(i), b = bin.charCodeAt(i + 1) || 0, c = bin.charCodeAt(i + 2) || 0;
      out += T[a >> 2] + T[((a & 3) << 4) | (b >> 4)] +
             (i + 1 < bin.length ? T[((b & 15) << 2) | (c >> 6)] : '=') +
             (i + 2 < bin.length ? T[c & 63] : '=');
    }
    return out;
  }
  function __ensureAudioFile(url) {
    if (__audioFileCache.has(url)) return __audioFileCache.get(url);
    const sounds = g.sounds || {};
    const buf = sounds[url];
    if (!buf || (typeof buf === 'object' && !buf.byteLength && !(buf instanceof ArrayBuffer))) {
      __audioFileCache.set(url, null);
      return null;
    }
    try {
      const b64 = __abToBase64(buf);
      const uri = 'data:audio/mpeg;base64,' + b64;
      __audioFileCache.set(url, uri);
      return uri;
    } catch (e) {
      console.log('[XXAUDIO] dataURI fail ' + url + ': ' + (e && e.message));
      __audioFileCache.set(url, null);
      return null;
    }
  }
  function AudioShim() {
    const self = this;
    let wxA = null;
    let _src = '', _volume = 1, _loop = false, _muted = false, _ended = false;
    self._listeners = {};
    function ensureWx() {
      if (wxA) return wxA;
      if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return null;
      wxA = wx.createInnerAudioContext();
      wxA.onEnded(function () {
        _ended = true;
        try { if (typeof self.onended === 'function') self.onended(); } catch (e) {}
        const a = self._listeners.ended; if (Array.isArray(a)) a.forEach(fn => { try { fn(); } catch (e) {} });
      });
      wxA.onError(function (e) {
        try { if (typeof self.onerror === 'function') self.onerror(e); } catch (_) {}
      });
      wxA.onCanplay(function () {
        try { if (typeof self.oncanplay === 'function') self.oncanplay(); } catch (_) {}
        const a = self._listeners.canplay; if (Array.isArray(a)) a.forEach(fn => { try { fn(); } catch (_) {} });
      });
      return wxA;
    }
    Object.defineProperty(this, 'src', {
      configurable: true,
      get() { return _src; },
      set(v) {
        _src = v || '';
        const w = ensureWx(); if (!w) return;
        let path = _src;
        if (g.sounds && g.sounds[_src]) path = __ensureAudioFile(_src) || _src;
        try { w.src = path; } catch (e) {}
      },
    });
    Object.defineProperty(this, 'volume', {
      configurable: true,
      get() { return _volume; },
      set(v) { _volume = v; if (wxA) try { wxA.volume = _muted ? 0 : v; } catch (e) {} },
    });
    Object.defineProperty(this, 'loop', {
      configurable: true,
      get() { return _loop; },
      set(v) { _loop = !!v; if (wxA) try { wxA.loop = _loop; } catch (e) {} },
    });
    Object.defineProperty(this, 'muted', {
      configurable: true,
      get() { return _muted; },
      set(v) { _muted = !!v; if (wxA) try { wxA.volume = _muted ? 0 : _volume; } catch (e) {} },
    });
    Object.defineProperty(this, 'currentTime', {
      configurable: true,
      get() { return wxA ? (wxA.currentTime || 0) : 0; },
      set(v) { if (wxA) try { wxA.seek(v); } catch (e) {} },
    });
    Object.defineProperty(this, 'duration', {
      configurable: true,
      get() { return wxA ? (wxA.duration || 0) : 0; },
    });
    Object.defineProperty(this, 'paused', {
      configurable: true,
      get() { return wxA ? !!wxA.paused : true; },
    });
    Object.defineProperty(this, 'ended', {
      configurable: true,
      get() { return _ended; },
    });
    this.addEventListener = (ev, fn) => { (self._listeners[ev] = self._listeners[ev] || []).push(fn); };
    this.removeEventListener = (ev, fn) => { const a = self._listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
    this.play = () => {
      _ended = false;
      const w = ensureWx();
      if (g.__audioPlayLogCnt == null) g.__audioPlayLogCnt = 0;
      if (g.__audioPlayLogCnt < 4) {
        g.__audioPlayLogCnt++;
        console.log('[audio-bridge] HTMLAudio.play src=' + (_src || '').slice(0, 60) + ' wxA=' + !!w);
      }
      if (w) try { w.play(); } catch (e) {}
      return Promise.resolve();
    };
    this.pause = () => { if (wxA) try { wxA.pause(); } catch (e) {} };
    this.load = () => {};
    this.remove = () => { if (wxA) try { wxA.destroy(); } catch (e) {} wxA = null; };
    this.cloneNode = () => new AudioShim();
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
  }

  // PlayCanvas Texture.setSource(t) 走:
  //   t instanceof HTMLImageElement || t instanceof HTMLCanvasElement
  //   || t instanceof HTMLVideoElement || t instanceof ArrayBuffer || (e = true);
  // e=true 时强制 _width=4 _height=4 _levels[0]=null → 黑/白 4x4 占位。
  // wx.createImage() 返的是 wx-native 对象 (constructor.name === 'nr'),
  // 跟 ImageShim 不同 prototype, instanceof 必失败 → 所有材质纹理失效 → 环境黑屏。
  // 修法: 用 Symbol.hasInstance 拦截 instanceof, 让 wx.Image / proxy 也通过。
  function makeShimCtor(ShimImpl, duckCheck) {
    function Ctor() { return new ShimImpl(); }
    Object.defineProperty(Ctor, Symbol.hasInstance, {
      value: function (inst) {
        if (inst == null) return false;
        if (ShimImpl && inst instanceof ShimImpl) return true;
        try { return !!duckCheck(inst); } catch (e) { return false; }
      },
      configurable: true,
    });
    return Ctor;
  }
  // wx.Image 鸭子型: 有 .src (string) + 有 .width/.height (number) + 不是 video/canvas/audio
  const isWxImageLike = (o) => {
    if (typeof o !== 'object') return false;
    if (typeof o.src !== 'string') return false;
    if (typeof o.width !== 'number' || typeof o.height !== 'number') return false;
    const tag = o.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'CANVAS') return false;
    // wx 原生 Image: 看 constructor.name (probe 抓到是 'nr'), 或我们 asset-inject 注册的 wx.createImage 实例
    return true;
  };
  const isCanvasLike = (o) => {
    if (typeof o !== 'object' || o == null) return false;
    if (o.tagName === 'CANVAS') return true;
    return typeof o.getContext === 'function' && typeof o.width === 'number' && typeof o.height === 'number';
  };
  const isVideoLike = (o) => {
    if (typeof o !== 'object' || o == null) return false;
    return o.tagName === 'VIDEO';
  };
  if (typeof g.HTMLImageElement  === 'undefined') g.HTMLImageElement  = makeShimCtor(ImageShim,  isWxImageLike);
  if (typeof g.HTMLVideoElement  === 'undefined') g.HTMLVideoElement  = makeShimCtor(VideoShim,  isVideoLike);
  if (typeof g.HTMLAudioElement  === 'undefined') g.HTMLAudioElement  = AudioShim;
  // Luna 内部 asset bundle 加载用 `new Audio()` / `new Image()` (global ctor),
  // 试玩 runtime 不一定有这些全局类, 即使有也是 wx 原生 image 缺 .load()/.remove() 等 W3C 方法.
  // 浏览器里 Audio === HTMLAudioElement、Image === HTMLImageElement, 强制覆盖为我们的 shim.
  g.Audio = AudioShim;
  g.Image = ImageShim;
  if (typeof g.HTMLCanvasElement === 'undefined') g.HTMLCanvasElement = makeShimCtor(null,        isCanvasLike);
  if (typeof g.HTMLElement       === 'undefined') g.HTMLElement       = function HTMLElement() {};
  if (typeof g.Element           === 'undefined') g.Element           = function Element() {};
  if (typeof g.Node              === 'undefined') g.Node              = function Node() {};

  // PlayCanvas SoundManager 期望 `new (window.AudioContext || window.webkitAudioContext)()`.
  // 试玩 runtime 没 WebAudio. 我们给个 shim, decodeAudioData 把 ArrayBuffer 落盘到 USER_DATA_PATH,
  // createBufferSource().start() 时 lazy 起一个 wx.createInnerAudioContext 播该文件, stop 时停掉。
  // 这样 PlayCanvas 不论走 WebAudio 还是 HTMLAudio (AudioShim) 都能出声。
  function __hashBuf(buf) {
    if (!buf) return '0';
    const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    const len = u8.length;
    let h = len & 0xffff;
    const sample = Math.min(64, len);
    for (let i = 0; i < sample; i++) h = (h * 31 + u8[i]) | 0;
    if (len > 128) for (let i = len - 32; i < len; i++) h = (h * 31 + u8[i]) | 0;
    return (h >>> 0).toString(36) + '-' + len.toString(36);
  }
  function __ensureAudioFileFromBuf(buf) {
    if (!buf) return null;
    const key = '__buf:' + __hashBuf(buf);
    if (__audioFileCache.has(key)) return __audioFileCache.get(key);
    try {
      const b64 = __abToBase64(buf);
      const uri = 'data:audio/mpeg;base64,' + b64;
      __audioFileCache.set(key, uri);
      return uri;
    } catch (e) {
      __audioFileCache.set(key, null);
      return null;
    }
  }
  function AudioContextShim() {
    g.__audioCtxNewCnt = (g.__audioCtxNewCnt || 0) + 1;
    this.state = 'running';
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.destination = { connect() {}, disconnect() {} };
    this.listener = { setPosition() {}, setOrientation() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };
    this.createGain        = () => {
      const node = { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} };
      return node;
    };
    this.createBufferSource = () => {
      const node = {
        buffer: null, loop: false, playbackRate: { value: 1 },
        _wxA: null, _started: false,
        connect() {}, disconnect() {},
        start(when, offset) {
          if (node._started) return; node._started = true;
          const b = node.buffer; const path = b && b.__wxFile;
          if (g.__audioStartLogCnt == null) g.__audioStartLogCnt = 0;
          if (g.__audioStartLogCnt < 4) {
            g.__audioStartLogCnt++;
            console.log('[audio-bridge] BufferSource.start path=' + (path || 'NULL') + ' bufHasFile=' + !!(b && b.__wxFile));
          }
          if (!path) return;
          try {
            const w = wx.createInnerAudioContext();
            w.src = path;
            w.loop = !!node.loop;
            w.onEnded(function () { try { if (typeof node.onended === 'function') node.onended(); } catch (e) {} });
            w.play();
            node._wxA = w;
          } catch (e) {}
        },
        stop() {
          const w = node._wxA; node._wxA = null;
          if (w) try { w.stop(); w.destroy && w.destroy(); } catch (e) {}
        },
        onended: null,
      };
      return node;
    };
    this.createBuffer       = (ch, len, sr) => ({ numberOfChannels: ch, length: len, sampleRate: sr, duration: len / (sr || 1), getChannelData: () => new Float32Array(len), __wxFile: null });
    this.createPanner       = () => ({ connect() {}, disconnect() {}, setPosition() {}, setOrientation() {} });
    this.createAnalyser     = () => ({ connect() {}, disconnect() {}, fftSize: 2048, getByteFrequencyData() {}, getByteTimeDomainData() {} });
    this.createOscillator   = () => ({ frequency: { value: 440 }, connect() {}, disconnect() {}, start() {}, stop() {} });
    this.decodeAudioData    = (buf, ok, fail) => {
      g.__decodeCalls = (g.__decodeCalls || 0) + 1;
      g.__lastDecodeBytes = (buf && buf.byteLength) || 0;
      const path = __ensureAudioFileFromBuf(buf);
      g.__lastWxFile = path || '(null)';
      const ab = { duration: 0, sampleRate: 44100, numberOfChannels: 2, length: 0, getChannelData: () => new Float32Array(0), __wxFile: path };
      try { ok && ok(ab); } catch (e) { fail && fail(e); }
      return Promise.resolve(ab);
    };
    this.resume             = () => Promise.resolve();
    this.suspend            = () => Promise.resolve();
    this.close              = () => Promise.resolve();
    this.addEventListener   = () => {};
    this.removeEventListener= () => {};
  }
  if (typeof g.AudioContext       === 'undefined') g.AudioContext       = AudioContextShim;
  if (typeof g.webkitAudioContext === 'undefined') g.webkitAudioContext = AudioContextShim;

  // Audio self-test — 首次 touchstart 后 800ms 直接放 sounds 里第一个 mp3。
  // 如果 wx.createInnerAudioContext 在试玩 runtime 下能用, 这条最直接, 不依赖 PlayCanvas。
  // 同时把 onError/onPlay 结果写到 g.__selfTestResult, 后面 toast 出来。
  let __audioSelfTestRan = false;
  function __runAudioSelfTest() {
    if (__audioSelfTestRan) return; __audioSelfTestRan = true;
    setTimeout(() => {
      try {
        const sounds = g.sounds || {};
        const sk = Object.keys(sounds);
        if (!sk.length) { g.__selfTestResult = 'no-sounds-loaded'; return; }
        const url = sk[0];
        const buf = sounds[url];
        if (!buf || buf.byteLength == null) { g.__selfTestResult = 'sounds[0]-not-buf'; return; }
        const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
        const b64 = __abToBase64(u8);
        const uri = 'data:audio/mpeg;base64,' + b64;
        const w = wx.createInnerAudioContext();
        w.src = uri;
        w.volume = 1;
        w.onPlay(() => { g.__selfTestResult = 'PLAY-OK len=' + buf.byteLength; });
        w.onError((err) => { g.__selfTestResult = 'ERR ' + JSON.stringify(err).slice(0, 100); });
        w.onCanplay(() => { g.__selfTestResult = (g.__selfTestResult || '') + ' canplay'; });
        w.play();
        g.__selfTestResult = 'play-called uri-len=' + uri.length;
      } catch (e) {
        g.__selfTestResult = 'EX ' + String(e && e.message).slice(0, 100);
      }
    }, 800);
  }
  // touch 触发: bind 一次 即可
  if (typeof wx !== 'undefined' && wx.onTouchStart) {
    try { wx.onTouchStart(__runAudioSelfTest); } catch (e) {}
  }
  // 兜底: 8 秒后无论有没有 touch 都跑一遍
  setTimeout(__runAudioSelfTest, 8000);

  // 报告 — 一次性 @8s 状态打印, 走 console.log (避免红色 Error 噪音)。
  // 当下个 Luna 试玩 manifest 里有 audio 资源时, 这里能确认桥接路径是否被调用。
  // 同时存到 g.__audioDebugSummary 给主上下文 hook 拉取。
  function __reportAudioState(tag) {
    try {
      const sounds = g.sounds || {};
      const sk = Object.keys(sounds);
      const ctxNew = (typeof g.__audioCtxNewCnt === 'number') ? g.__audioCtxNewCnt : 0;
      const decAudCnt = (typeof g.__decodeCalls === 'number') ? g.__decodeCalls : 0;
      const startCnt = (typeof g.__audioStartLogCnt === 'number') ? g.__audioStartLogCnt : 0;
      const playCnt = (typeof g.__audioPlayLogCnt === 'number') ? g.__audioPlayLogCnt : 0;
      const wxOK = typeof wx !== 'undefined' && typeof wx.createInnerAudioContext === 'function';
      const selfTest = g.__selfTestResult || 'self-test-not-run';
      const ca = (g._compressedAssets || []).length;
      const atobOK = typeof g.atob === 'function' || typeof atob === 'function';
      const tdOK = typeof g.TextDecoder === 'function' || typeof TextDecoder === 'function';
      const decAB = typeof g.decompressArrayBuffer === 'function';
      const sndKeys = sk.length ? sk.slice(0, 3).map(k => k.split('/').pop()).join(',') : '';
      const summary = '[XXAUDIO]' + tag + ' snd=' + sk.length + (sndKeys ? '(' + sndKeys + ')' : '') +
                      ' ctx=' + ctxNew + ' dec=' + decAudCnt + ' start=' + startCnt + ' play=' + playCnt +
                      ' wx=' + (wxOK ? 'Y' : 'N') + ' ca=' + ca +
                      ' atob=' + (atobOK ? 'Y' : 'N') + ' td=' + (tdOK ? 'Y' : 'N') + ' dAB=' + (decAB ? 'Y' : 'N') +
                      ' selfTest=' + selfTest;
      g.__audioDebugSummary = summary;
      console.log(summary);
    } catch (e) {
      console.log('[XXAUDIO]ERR ' + String(e && e.message).slice(0, 80));
    }
  }
  setTimeout(() => __reportAudioState('@3s'), 3000);
  setTimeout(() => __reportAudioState('@8s'), 8000);
  setTimeout(() => __reportAudioState('@15s'), 15000);
  setTimeout(() => __reportAudioState('@30s'), 30000);
  // 每 10 秒持续报告，保证 log buffer 底部一定能看到最新状态
  setInterval(() => __reportAudioState('@P'), 10000);
})();
