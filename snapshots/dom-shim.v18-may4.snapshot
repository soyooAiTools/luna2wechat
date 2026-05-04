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
  if (!g.canvas) g.canvas = wx.createCanvas();

  // luna-runtime/19_pi_runtime.js 的 Bridge.ready cb 会写 Luna.Unity.LifeCycle.GameEnded =,
  // Luna.Unity.LifeCycle 在 Bridge.NET 早期没生成 → "Cannot set properties of undefined" throw。
  // 在 dom-shim 早期占位, runtime 后期再覆盖也没问题 (Bridge.NET assignTo 是 Object.assign 风格)。
  g.Luna = g.Luna || {};
  g.Luna.Unity = g.Luna.Unity || {};
  g.Luna.Unity.LifeCycle = g.Luna.Unity.LifeCycle || {};
  g.Luna.Unity.Analytics = g.Luna.Unity.Analytics || {};
  g.Luna.Unity.Playable  = g.Luna.Unity.Playable  || {};

  // PlayCanvas Mouse._handleMove 构造 MouseEvent 时做 `event instanceof WheelEvent` 检查 →
  // 试玩 runtime 没 WheelEvent → ReferenceError → 整条 _handleMove 抛错 → 摇杆 touchmove 完全失效。
  function _mkEv(defaults) {
    return function (typeOrSrc, init) {
      if (typeOrSrc && typeof typeOrSrc === 'object') {
        Object.assign(this, defaults, typeOrSrc, init || {});
        if (init && init.type) this.type = init.type;
      } else {
        this.type = typeOrSrc || '';
        Object.assign(this, defaults, init || {});
      }
    };
  }
  if (typeof g.Event         === 'undefined') g.Event         = _mkEv({});
  if (typeof g.MouseEvent    === 'undefined') g.MouseEvent    = _mkEv({ clientX: 0, clientY: 0, button: 0, buttons: 0 });
  if (typeof g.WheelEvent    === 'undefined') g.WheelEvent    = _mkEv({ deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0 });
  if (typeof g.KeyboardEvent === 'undefined') g.KeyboardEvent = _mkEv({ key: '', code: '', keyCode: 0 });
  if (typeof g.TouchEvent    === 'undefined') g.TouchEvent    = _mkEv({ touches: [], targetTouches: [], changedTouches: [] });
  if (typeof g.PointerEvent  === 'undefined') g.PointerEvent  = _mkEv({ clientX: 0, clientY: 0, pointerId: 1 });

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
    console.warn('[bootShim] canvas size fail:', e && e.message);
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
      const UI = g.UnityEngine && g.UnityEngine.Input;
      if (!UI || __uiInjectInstrumented) return;
      __uiInjectInstrumented = true;
      const calls = {};
      function _log(name, info) {
        calls[name] = (calls[name] || 0) + 1;
        if (calls[name] <= 6) {
          console.warn('[UI.read#' + calls[name] + '] ' + name + ' ' + info);
        } else if (calls[name] === 50 || calls[name] === 200) {
          console.warn('[UI.read.cnt] ' + name + ' total=' + calls[name]);
        }
      }
      for (const propName of ['mousePosition', 'touches', 'touchCount', 'anyKey', 'anyKeyDown']) {
        try {
          const d = Object.getOwnPropertyDescriptor(UI, propName);
          if (!d || !d.get) continue;
          const origGet = d.get;
          Object.defineProperty(UI, propName, {
            configurable: true,
            get: function () {
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
        } catch (e) { console.warn('[UI.instrument] wrap ' + propName + ' fail:', e && e.message); }
      }
      for (const fnName of ['GetMouseButton', 'GetMouseButtonDown', 'GetMouseButtonUp', 'GetTouch', 'GetKey', 'GetKeyDown', 'GetKeyUp']) {
        try {
          const orig = UI[fnName];
          if (typeof orig !== 'function') continue;
          UI[fnName] = function () {
            if (fnName === 'GetTouch' && __uiInjectState && __uiInjectState.active && __uiInjectState.mockT && arguments[0] === 0) {
              calls[fnName] = (calls[fnName] || 0) + 1;
              if (calls[fnName] <= 4) {
                const m = __uiInjectState.mockT;
                console.warn('[UI.read#' + calls[fnName] + '] GetTouch (0) → mockT pos={x:' + (m.position && m.position.x) +
                             ',y:' + (m.position && m.position.y) + '} phase=' + m.phase + ' fingerId=' + m.fingerId);
              }
              return __uiInjectState.mockT;
            }
            const r = orig.apply(this, arguments);
            _log(fnName, '(' + Array.from(arguments).slice(0,3).join(',') + ') → ' + (typeof r === 'object' ? '<obj>' : String(r)));
            return r;
          };
        } catch (e) {}
      }
      console.warn('[UI.instrument] hooks installed');
    }

    function _injectUIState() {
      const UI = g.UnityEngine && g.UnityEngine.Input;
      if (!UI || !__uiInjectState) return;
      const s = __uiInjectState;
      __uiInjectFrameCnt++;
      if (s.endedTickCount != null) {
        s.endedTickCount++;
        if (s.endedTickCount >= 3) s.active = false;
      }
      const V3 = g.UnityEngine && g.UnityEngine.Vector3;
      let posVec = null;
      if (V3 && typeof V3.ctor === 'function') { try { posVec = new V3.ctor(s.ux, s.uy, 0); } catch (e) {} }
      if (!posVec) posVec = { x: s.ux, y: s.uy, z: 0, _data: [s.ux, s.uy, 0] };
      try { UI.W$ = posVec; } catch (e) {}
      try { UI.mousePosition = posVec; } catch (e) {}
      try { UI.J$ = posVec; } catch (e) {}
      try { UI.multiTouchEnabled = true; } catch (e) {}
      if (Array.isArray(UI.z$) && UI.z$.length >= 1) UI.z$[0] = s.active;
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
      s.isDown = false;
      s.isUp = false;
      if (__uiInjectFrameCnt === 1 || __uiInjectFrameCnt === 30 || __uiInjectFrameCnt === 100) {
        try {
          console.warn('[UI.keep#' + __uiInjectFrameCnt + '] readback: mousePos={x:' + (UI.mousePosition && UI.mousePosition.x) + ',y:' + (UI.mousePosition && UI.mousePosition.y) +
                       '} GetMouseButton(0)=' + (typeof UI.GetMouseButton === 'function' ? UI.GetMouseButton(0) : '?') +
                       ' touchCount=' + UI.touchCount + ' z$[0]=' + (UI.z$ && UI.z$[0]));
        } catch (e) {}
      }
    }

    function _setUITouchState(type, ux, uy, fingerObj) {
      const isStart = (type === 'touchstart');
      const isEnd   = (type === 'touchend' || type === 'touchcancel');
      const fingerId = (fingerObj && fingerObj.identifier) || 0;
      const prevUx = __uiInjectState && __uiInjectState.ux != null ? __uiInjectState.ux : ux;
      const prevUy = __uiInjectState && __uiInjectState.uy != null ? __uiInjectState.uy : uy;
      const dx = isStart ? 0 : (ux - prevUx);
      const dy = isStart ? 0 : (uy - prevUy);
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
      let mockT = __uiInjectState && __uiInjectState.mockT;
      if (isStart || !mockT) {
        const TC = g.UnityEngine && g.UnityEngine.Touch;
        mockT = null;
        if (TC && typeof TC.ctor === 'function') { try { mockT = new TC.ctor(); } catch (e) {} }
        if (!mockT) mockT = {};
      }
      function forceGetter(key, factory) {
        try { Object.defineProperty(mockT, key, { configurable: true, enumerable: true, get: factory }); return true; } catch (e) { return false; }
      }
      forceGetter('position',      function () { return mkV2(__uiInjectState ? __uiInjectState.ux : ux, __uiInjectState ? __uiInjectState.uy : uy); });
      forceGetter('rawPosition',   function () { return mkV2(__uiInjectState ? __uiInjectState.ux : ux, __uiInjectState ? __uiInjectState.uy : uy); });
      forceGetter('deltaPosition', function () { return mkV2(dx, dy); });
      forceGetter('phase',         function () { return isStart ? 0 : (type === 'touchmove' ? 1 : 3); });
      forceGetter('fingerId',      function () { return fingerId; });
      forceGetter('tapCount',      function () { return 1; });
      forceGetter('pressure',      function () { return 1; });
      forceGetter('deltaTime',     function () { return 0.016; });
      forceGetter('type',          function () { return 0; });
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
      try { mockT.maximumPossiblePressure = 1; } catch (e) {}
      try { mockT.radius = 1; mockT.radiusVariance = 0; } catch (e) {}
      try { mockT.altitudeAngle = 0; mockT.azimuthAngle = 0; } catch (e) {}
      const initialPhase = isStart ? 0 : (type === 'touchmove' ? 1 : (isEnd ? 3 : 2));
      __uiInjectState = {
        active: true, ux: ux, uy: uy, dx: isEnd ? 0 : dx, dy: isEnd ? 0 : dy,
        phase: initialPhase, fingerId: fingerId,
        mockT: mockT, isDown: isStart, isUp: isEnd,
        endedAt: isEnd ? Date.now() : 0,
        endedTickCount: isEnd ? 0 : null,
      };
      _instrumentUIRead();
      _injectUIState();
      if (!__uiInjectTimer) {
        __uiInjectTimer = setInterval(function () {
          _injectUIState();
          if (__uiInjectState && !__uiInjectState.active && __uiInjectState.endedAt &&
              Date.now() - __uiInjectState.endedAt > 200) {
            __uiInjectState = null;
            clearInterval(__uiInjectTimer);
            __uiInjectTimer = null;
            console.warn('[UI.keep] timer stopped after touch released');
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
        console.warn('[touch#' + __touchDispatchCnt + '] type=' + type +
                     ' touches=' + list.length + ' x=' + px + ' y=' + py);
        // PC 内部状态 before-emit
        try {
          const _pc = g.pc;
          const _app = (_pc && _pc.Application && _pc.Application.getApplication && _pc.Application.getApplication()) || g.app;
          if (_app) {
            const m = _app.mouse, t = _app.touch;
            console.warn('[touch#' + __touchDispatchCnt + '] BEFORE app.mouse=' + (m ? ('en=' + m._enabled + ' tgt=' + (m._target && m._target.constructor && m._target.constructor.name) + ' btns=' + JSON.stringify(m._buttons || [])) : 'NULL') +
                         ' app.touch=' + (t ? ('en=' + t._enabled + ' el=' + (t._element && t._element.constructor && t._element.constructor.name) + ' tn=' + (t._touches ? t._touches.length : 'undef')) : 'NULL'));
          } else {
            console.warn('[touch#' + __touchDispatchCnt + '] no app');
          }
        } catch (e) { console.warn('[touch#] before-probe threw:', e && e.message); }
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
            console.warn('[touch#' + __touchDispatchCnt + '] UI inj: touchCount=' + UI.touchCount +
                         ' GetMouseButton(0)=' + (typeof UI.GetMouseButton === 'function' ? UI.GetMouseButton(0) : 'N/A') +
                         ' GetMouseButtonDown(0)=' + (typeof UI.GetMouseButtonDown === 'function' ? UI.GetMouseButtonDown(0) : 'N/A') +
                         ' z$=' + JSON.stringify(Array.from(UI.z$ || [])) +
                         ' A$=' + JSON.stringify(Array.from(UI.A$ || [])) +
                         ' mousePos={x:' + (UI.mousePosition && UI.mousePosition.x) + ',y:' + (UI.mousePosition && UI.mousePosition.y) + '}' +
                         ' touches.len=' + (UI.touches && UI.touches.length) +
                         ' active=' + (__uiInjectState && __uiInjectState.active));
          }
        } catch (e) { console.warn('[UE inject log] threw:', e && e.message); }
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
            console.warn('[touch#' + __touchDispatchCnt + '] AFTER  app.mouse btns=' + (m ? JSON.stringify(m._buttons || []) : 'NULL') +
                         ' app.touch tn=' + (t && t._touches ? t._touches.length : (t ? 'no-_touches:keys=' + Object.keys(t).slice(0,8).join(',') : 'NULL')));
          }
        } catch (e) { console.warn('[touch#] after-probe threw:', e && e.message); }
        // UnityEngine.Input snapshot diff: 哪个 mangled 字段被改了 = touches/mouseButtons 真位置
        try {
          if (g.__UI_snapshotFn && g.__UI_snapshot_initial) {
            const after = g.__UI_snapshotFn();
            const before = g.__UI_snapshot_initial;
            const diffs = [];
            for (const k of Object.keys(after)) {
              if (before[k] !== after[k]) diffs.push(k + ':[' + before[k] + ']→[' + after[k] + ']');
            }
            console.warn('[touch#' + __touchDispatchCnt + '] UI diff: ' + (diffs.length ? diffs.slice(0,12).join(' || ') : 'NO_CHANGE'));
          }
        } catch (e) { console.warn('[touch#] UI-diff threw:', e && e.message); }
      }
      // 第 1 次真触摸后, 重新 dump bus 状态: 如果 win._bus.mousedown 从 x2 → x1, 说明 PC SoundManager
      // unlock handler 自删了 → 我们 emit 的 mouse 事件确实跑到了真 PC handler
      if (__touchDispatchCnt === 1 && g.__busesForRedump) {
        setTimeout(function () {
          try {
            const B = g.__busesForRedump || {};
            const c = function (b, t) { return b && b._count ? b._count(t) : 'N/A'; };
            console.warn('[postTouch] win._bus mousedown=' + c(B.win, 'mousedown') +
                         ' mousemove=' + c(B.win, 'mousemove') +
                         ' mouseup=' + c(B.win, 'mouseup') +
                         ' click=' + c(B.win, 'click') +
                         ' pointerdown=' + c(B.win, 'pointerdown'));
            console.warn('[postTouch] body._bus touchstart=' + c(B.body, 'touchstart') +
                         ' click=' + c(B.body, 'click') +
                         ' pointerdown=' + c(B.body, 'pointerdown'));
            console.warn('[postTouch] canvas._bus touchstart=' + c(B.canvas, 'touchstart') +
                         ' mousedown=' + c(B.canvas, 'mousedown') +
                         ' pointerdown=' + c(B.canvas, 'pointerdown'));
            // 把目标 listener 源码再 dump 一次, 看哪些 type 多了
            if (B.body && B.body._listSources) {
              console.warn('[postTouch] body._bus pointerdown sources: ' + JSON.stringify((B.body._listSources('pointerdown')||[]).map(s => s.replace(/\s+/g,' '))));
            }
          } catch (e) { console.warn('[postTouch] dump threw:', e && e.message); }
        }, 50);
      }
    }
    let __touchBound = { start: false, move: false, end: false, cancel: false };
    if (typeof wx !== 'undefined') {
      try { if (typeof wx.onTouchStart  === 'function') { wx.onTouchStart (r => dispatchTouch('touchstart',  r)); __touchBound.start  = true; } } catch (e) { console.warn('[bootShim] onTouchStart  bind fail:', e && e.message); }
      try { if (typeof wx.onTouchMove   === 'function') { wx.onTouchMove  (r => dispatchTouch('touchmove',   r)); __touchBound.move   = true; } } catch (e) { console.warn('[bootShim] onTouchMove   bind fail:', e && e.message); }
      try { if (typeof wx.onTouchEnd    === 'function') { wx.onTouchEnd   (r => dispatchTouch('touchend',    r)); __touchBound.end    = true; } } catch (e) { console.warn('[bootShim] onTouchEnd    bind fail:', e && e.message); }
      try { if (typeof wx.onTouchCancel === 'function') { wx.onTouchCancel(r => dispatchTouch('touchcancel', r)); __touchBound.cancel = true; } } catch (e) { console.warn('[bootShim] onTouchCancel bind fail:', e && e.message); }
      console.warn('[bootShim] wx touch handlers wired:', JSON.stringify(__touchBound));
    } else {
      console.warn('[bootShim] no wx, touch wiring skipped');
    }
  }

  // ---------- window ----------
  if (!g.window) g.window = g;
  g.self = g.self || g;

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
        return elements.get(id) || null;
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
        if (tag === 'canvas') return wx.createCanvas();
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
      _registerElement(id, el) { elements.set(id, el); },
    };
  }

  // ---------- window addEventListener ----------
  if (!g.addEventListener) {
    const winBus = makeEmitter();
    g.addEventListener = (type, cb) => winBus.on(type, cb);
    g.removeEventListener = (type, cb) => winBus.off(type, cb);
    g.dispatchEvent = (ev) => winBus.emit(ev.type, ev);
    g._winBus = winBus;
  }

  // ---------- Event ----------
  if (typeof g.Event === 'undefined') {
    g.Event = function Event(type, init) { this.type = type; Object.assign(this, init || {}); };
  }

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
  if (!g.localStorage) {
    g.localStorage = {
      getItem(k) { try { return wx.getStorageSync(k) || null; } catch (e) { return null; } },
      setItem(k, v) { try { wx.setStorageSync(k, String(v)); } catch (e) {} },
      removeItem(k) { try { wx.removeStorageSync(k); } catch (e) {} },
      clear() { try { wx.clearStorageSync(); } catch (e) {} },
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
  }
  function VideoShim() {
    // Luna 启动期不一定播放, 仅暴露占位接口; 真要播放走 luna-to-wx/video.js
    this.src = ''; this.muted = true; this.autoplay = false; this.loop = false;
    this.currentTime = 0; this.duration = 0; this.paused = true;
    this.style = {};
    this.addEventListener = () => {};
    this.play = () => Promise.resolve();
    this.pause = () => {};
  }
  function AudioShim() {
    this.src = ''; this.volume = 1; this.loop = false; this.paused = true;
    this.addEventListener = () => {};
    this.play = () => Promise.resolve();
    this.pause = () => {};
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
  // 浏览器里 Image === HTMLImageElement;打包代码 `new Image()` 走 globalThis 解析,这里同源即可
  if (typeof g.Image             === 'undefined') g.Image             = g.HTMLImageElement;
  if (typeof g.HTMLVideoElement  === 'undefined') g.HTMLVideoElement  = makeShimCtor(VideoShim,  isVideoLike);
  if (typeof g.HTMLAudioElement  === 'undefined') g.HTMLAudioElement  = AudioShim;
  // Luna sound handler 在 _loadSimpleAssetsAsync 里 `new Audio()` 即使资源为 0 也走构造路径,
  // 试玩 runtime 没全局 Audio → ReferenceError → 整个 _loadSimpleAssetsAsync reject → 黑屏。
  // 浏览器里 Audio === HTMLAudioElement, 这里复用 AudioShim 即可。
  if (typeof g.Audio             === 'undefined') g.Audio             = AudioShim;
  if (typeof g.HTMLCanvasElement === 'undefined') g.HTMLCanvasElement = makeShimCtor(null,        isCanvasLike);
  if (typeof g.HTMLElement       === 'undefined') g.HTMLElement       = function HTMLElement() {};
  if (typeof g.Element           === 'undefined') g.Element           = function Element() {};
  if (typeof g.Node              === 'undefined') g.Node              = function Node() {};

  // PlayCanvas SoundManager 期望 `new (window.AudioContext || window.webkitAudioContext)()`
  // 试玩 runtime 没 WebAudio API; 给个最小可用 stub, 让 SoundManager 能 new 出来不立即崩。
  // 真正播放走 wx.createInnerAudioContext (后面 sound 子系统再桥接)。
  function AudioContextShim() {
    this.state = 'running';
    this.sampleRate = 44100;
    this.currentTime = 0;
    this.destination = { connect() {}, disconnect() {} };
    this.listener = { setPosition() {}, setOrientation() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };
    this.createGain        = () => ({ gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} });
    this.createBufferSource = () => ({ buffer: null, loop: false, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null });
    this.createBuffer       = (ch, len, sr) => ({ numberOfChannels: ch, length: len, sampleRate: sr, duration: len / (sr || 1), getChannelData: () => new Float32Array(len) });
    this.createPanner       = () => ({ connect() {}, disconnect() {}, setPosition() {}, setOrientation() {} });
    this.createAnalyser     = () => ({ connect() {}, disconnect() {}, fftSize: 2048, getByteFrequencyData() {}, getByteTimeDomainData() {} });
    this.createOscillator   = () => ({ frequency: { value: 440 }, connect() {}, disconnect() {}, start() {}, stop() {} });
    this.decodeAudioData    = (buf, ok, fail) => { try { ok && ok({ duration: 0, sampleRate: 44100, numberOfChannels: 2, length: 0, getChannelData: () => new Float32Array(0) }); } catch (e) { fail && fail(e); } return Promise.resolve({ duration: 0, sampleRate: 44100, numberOfChannels: 2, length: 0, getChannelData: () => new Float32Array(0) }); };
    this.resume             = () => Promise.resolve();
    this.suspend            = () => Promise.resolve();
    this.close              = () => Promise.resolve();
    this.addEventListener   = () => {};
    this.removeEventListener= () => {};
  }
  if (typeof g.AudioContext       === 'undefined') g.AudioContext       = AudioContextShim;
  if (typeof g.webkitAudioContext === 'undefined') g.webkitAudioContext = AudioContextShim;

  // 试玩 runtime: GameGlobal !== globalThis (game.js startGame bridge 已确认)。
  // eval 的打包代码 `new Audio()` / `new Event()` 走 globalThis 解析裸标识符 →
  // 设到 GameGlobal 上的 shim 看不见 → ReferenceError → _loadSimpleAssetsAsync reject → 黑屏。
  // 把 dom-shim 暴露的关键构造器同步到 globalThis,且只设 globalThis 上不存在的。
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
})();

