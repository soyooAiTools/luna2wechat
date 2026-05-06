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

  // ---- HTTP probe: 队列化串行 wx.request,避免并发上限把启动期日志全丢 ----
  // 之前发现的根因:并发同时发 100+ wx.request,被 runtime 的 max-concurrent (~5-10) 上限丢光,
  // 只有稳态后 (escapeGuideCount 这种每帧 spam) 慢速拍发的能进 → 启动期 dom-shim init
  // / video init / 错误日志全部静默丢失. 修法:
  //   1. 队列化:同一时刻最多 1 个 wx.request in-flight
  //   2. 过滤 spam (escapeGuideCount / Skipping event sample 等)
  //   3. 多 LAN 候选 IP 串行尝试
  try {
    // 经验证:wx.request 的 complete 回调在试玩 runtime 不可靠,容易让队列 _inflight 永久卡住.
    // 改用纯 fire-and-forget,Image transport (wx.createImage().src) 不走 wx.request 并发上限.
    // 启动期 burst 用 buffer + setInterval 限速 flush 缓解,1 条/20ms 拍发,~5min 排空 5000 条.
    const PROBE_HOST = '192.168.1.3:53017';
    const _origLog  = console.log  ? console.log.bind(console)  : function(){};
    const _origWarn = console.warn ? console.warn.bind(console) : _origLog;
    const _origErr  = console.error? console.error.bind(console): _origLog;
    const _origInfo = console.info ? console.info.bind(console) : _origLog;
    const _spamPatterns = [/escapeGuideCount/, /Skipping event sample/, /^\[XXAUDIO\] gain#/];
    const _buf = [];
    function fireOne(line) {
      const url = 'http://' + PROBE_HOST + '/log?m=' + encodeURIComponent(line.slice(0, 1500));
      // Image transport (主):不走 wx.request 并发限制
      try {
        const img = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage() : null;
        if (img) img.src = url;
      } catch (e) {}
      // 注: 试玩广告 runtime 的 wx.request 是 throwing stub ("is not implemented on wx") —
      // 副通道会触发 W warning, 反而污染日志, 所以这里只走 createImage 主路.
      // dom-shim 后面统一把 wx.request silencer 化, luna 自己调也不会再打 warning.
    }
    setInterval(function () {
      // 每 tick 最多发 5 条,避免短时间 burst 又触发并发上限
      let n = 5;
      while (n-- > 0 && _buf.length > 0) fireOne(_buf.shift());
    }, 20);
    function fmt(args) {
      try {
        return Array.prototype.map.call(args, a => {
          if (a == null) return String(a);
          if (typeof a === 'string') return a;
          if (typeof a === 'number' || typeof a === 'boolean') return String(a);
          if (a instanceof Error) return (a.message||'') + '|' + (a.stack||'').split('\n').slice(0,3).join('//');
          try { return JSON.stringify(a); } catch (e) { return '[obj]'; }
        }).join(' ');
      } catch (e) { return '[fmt-err]'; }
    }
    function send(level, args) {
      try {
        const msg = '[' + level + '] ' + fmt(args);
        for (const re of _spamPatterns) { if (re.test(msg)) return; }
        if (_buf.length < 10000) _buf.push(msg);
      } catch (e) {}
    }
    console.log   = function () { send('L', arguments); _origLog.apply(null, arguments); };
    console.warn  = function () { send('W', arguments); _origWarn.apply(null, arguments); };
    console.error = function () { send('E', arguments); _origErr.apply(null, arguments); };
    console.info  = function () { send('I', arguments); _origInfo.apply(null, arguments); };
    console.log('[probe] HTTP probe attached → ' + PROBE_HOST);
  } catch (e) {}

  // 试玩广告 runtime 的若干 wx API 是 throwing stub ("is not implemented on wx") —
  // 进入函数体即 console.warn, 无论 try/catch 都是 W 噪音.
  // 统一替换为 silent noop, luna/dom-shim 任何路径调都不再产生 warning.
  // 注: probe 走 wx.createImage 主路, 不依赖 wx.request, 不会受影响.
  // wx 上的 API 经常是 non-writable / non-configurable, 直接赋值会 silently fail —
  // 必须用 Object.defineProperty 强行覆盖, 失败再退到赋值兜底.
  try {
    if (typeof wx !== 'undefined' && !wx.__stubsSilenced) {
      const _stubKeys = ['request', 'setInnerAudioOption'];
      const _makeNoop = (k) => function (opts) {
        try { if (opts && typeof opts.fail === 'function') opts.fail({ errMsg: k + ': silenced by dom-shim' }); } catch (e) {}
        try { if (opts && typeof opts.complete === 'function') opts.complete({ errMsg: k + ': silenced by dom-shim' }); } catch (e) {}
      };
      for (const k of _stubKeys) {
        if (typeof wx[k] !== 'function') continue;
        const noop = _makeNoop(k);
        try { Object.defineProperty(wx, k, { value: noop, writable: true, configurable: true }); }
        catch (e) { try { wx[k] = noop; } catch (_) {} }
      }
      wx.__stubsSilenced = true;
    }
  } catch (e) {}

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

    // ---------- WebGL texImage2D / texSubImage2D 视频纹理重定向 ----------
    // 根因: Luna 的 VideoPlayer 走 Network.GetVideoAsync → pc.Texture.setSource(videoElement) →
    //       PC 内部 gl.texImage2D(target, level, ifmt, fmt, type, source) — 6 参数 source 形态.
    // wx 试玩 runtime 的 GL 实现只认 wx.createImage / wx.createCanvas 的真实对象, 不认我们的 VideoShim
    // / VideoDecoderProxy → 抛 "Failed to execute 'texImage2D' on 'WebGLRenderingContext2': invalid pixels".
    // 修法: 把 GL ctx 的 texImage2D / texSubImage2D wrap 一层, 检测 source._isLunaVideo, 拉一帧
    // wx.createVideoDecoder().getFrameData() 返回的 RGBA ArrayBuffer, 改用 9 参数 byteView 形态调原版.
    // 这样 PC 把 video 当普通纹理处理,无需感知是 video 源; 每帧 PC 复用 setSource 触发 upload 时
    // 我们顺势 pull 最新帧.
    {
      const __wrapGL = (gl) => {
        if (!gl || gl.__lunaVideoWrapped) return gl;
        const origTex = gl.texImage2D;
        const origSub = gl.texSubImage2D;
        if (typeof origTex !== 'function') return gl;
        gl.texImage2D = function () {
          const a = arguments;
          // 6-arg form: target, level, internalformat, format, type, source
          // PC 走这条当 source 是 instanceof HTMLImage/Canvas/Video — 我们的 hasInstance hook 让 proxy 也通过.
          if (a.length === 6) {
            const src = a[5];
            if (src && src._isLunaVideo) {
              const fr = typeof src._pullFrame === 'function' ? src._pullFrame() : null;
              const cnt6 = (GameGlobal.__VID_TEX6 = (GameGlobal.__VID_TEX6 || 0) + 1);
              if (cnt6 === 1 || cnt6 === 10 || cnt6 === 30 || cnt6 === 100 || cnt6 === 300) {
                console.log('[video-tex6#' + cnt6 + '] src=' + (src.id || '?') + ' hasFrame=' + (!!fr) + ' fw=' + (fr && fr.width) + ' fh=' + (fr && fr.height));
              }
              if (fr && fr.data && fr.width && fr.height) {
                try {
                  return origTex.call(this, a[0], a[1], a[2], fr.width, fr.height, 0, a[3], a[4],
                    fr.data instanceof ArrayBuffer ? new Uint8Array(fr.data) : fr.data);
                } catch (e) {
                  // 单次 upload 失败不能让 PC render loop 炸; 静默 swallow + 限频 log
                  if ((GameGlobal.__VID_TEX_ERR = (GameGlobal.__VID_TEX_ERR || 0) + 1) <= 3) {
                    console.warn('[video-tex] 9-arg upload failed:', e && e.message);
                  }
                  return undefined;
                }
              }
              // 没帧数据先静默 skip; PC 下一帧还会再来
              if ((GameGlobal.__VID_TEX_NOFRAME = (GameGlobal.__VID_TEX_NOFRAME || 0) + 1) === 1) {
                console.log('[video-tex] first call but no frame yet, deferring');
              }
              return undefined;
            }
          }
          // 9-arg form: target, level, internalformat, width, height, border, format, type, pixels
          // 防御:若 hasInstance hook 因 playable runtime 锁了 HTMLVideoElement 而失效,PC 会把 proxy 当 pixel data
          // 传到 9-arg path. 这里把 proxy 转成 frame data,且用真实 frame 的 w/h 替换 PC 算出来的尺寸
          // (PC 的 w/h 可能是 t._width*i — mipmap level 缩放后的, 跟 frame data 字节数对不上).
          if (a.length === 9) {
            const src = a[8];
            if (src && src._isLunaVideo) {
              const fr = typeof src._pullFrame === 'function' ? src._pullFrame() : null;
              const cnt9 = (GameGlobal.__VID_TEX9 = (GameGlobal.__VID_TEX9 || 0) + 1);
              if (cnt9 === 1 || cnt9 === 10 || cnt9 === 30 || cnt9 === 100 || cnt9 === 300) {
                console.log('[video-tex9#' + cnt9 + '] src=' + (src.id || '?') + ' hasFrame=' + (!!fr) + ' fw=' + (fr && fr.width) + ' fh=' + (fr && fr.height));
              }
              if (fr && fr.data && fr.width && fr.height) {
                try {
                  return origTex.call(this, a[0], a[1], a[2], fr.width, fr.height, a[5], a[6], a[7],
                    fr.data instanceof ArrayBuffer ? new Uint8Array(fr.data) : fr.data);
                } catch (e) {
                  if ((GameGlobal.__VID_TEX9_ERR = (GameGlobal.__VID_TEX9_ERR || 0) + 1) <= 3) {
                    console.warn('[video-tex] 9-arg defense upload failed:', e && e.message);
                  }
                  return undefined;
                }
              }
              if ((GameGlobal.__VID_TEX9_NOFRAME = (GameGlobal.__VID_TEX9_NOFRAME || 0) + 1) === 1) {
                console.log('[video-tex] 9-arg path saw proxy without frame (instanceof hook missed) — defense intercept');
              }
              return undefined;
            }
          }
          return origTex.apply(this, a);
        };
        if (typeof origSub === 'function') {
          gl.texSubImage2D = function () {
            const a = arguments;
            // 7-arg form: target, level, xoffset, yoffset, format, type, source
            if (a.length === 7) {
              const src = a[6];
              if (src && src._isLunaVideo) {
                const fr = typeof src._pullFrame === 'function' ? src._pullFrame() : null;
                if (fr && fr.data && fr.width && fr.height) {
                  try {
                    return origSub.call(this, a[0], a[1], a[2], a[3], fr.width, fr.height, a[4], a[5],
                      fr.data instanceof ArrayBuffer ? new Uint8Array(fr.data) : fr.data);
                  } catch (e) { return undefined; }
                }
                return undefined;
              }
            }
            return origSub.apply(this, a);
          };
        }
        gl.__lunaVideoWrapped = true;
        console.log('[video-tex] wrapped GL texImage2D/texSubImage2D');
        return gl;
      };
      // 把 getContext wrapper 提取成函数, 给所有 canvas (g.canvas + document.createElement('canvas') +
      // wx.createCanvas() 直接调用) 都装上. PC 渲染 canvas 走 document.createElement('canvas') →
      // wx.createCanvas(), 不是 g.canvas — 只 wrap g.canvas 的 getContext 完全错过 PC 主 GL ctx.
      const __wrapCanvasGetContext = (canvas) => {
        if (!canvas || canvas.__lunaGetCtxWrapped) return canvas;
        const __origGetContext = canvas.getContext;
        if (typeof __origGetContext !== 'function') return canvas;
        try {
          canvas.getContext = function () {
            const ctx = __origGetContext.apply(this, arguments);
            if (ctx && (typeof ctx.texImage2D === 'function')) __wrapGL(ctx);
            return ctx;
          };
          canvas.__lunaGetCtxWrapped = true;
          if (!GameGlobal.__VID_WRAP_CANVAS_LOG) {
            GameGlobal.__VID_WRAP_CANVAS_LOG = 1;
            console.log('[video-tex] wrapped getContext on canvas (first instance)');
          }
        } catch (e) {
          if (!GameGlobal.__VID_WRAP_CANVAS_FAIL) {
            GameGlobal.__VID_WRAP_CANVAS_FAIL = 1;
            console.warn('[video-tex] getContext wrap failed:', e && e.message);
          }
        }
        return canvas;
      };
      __wrapCanvasGetContext(g.canvas);

      // monkey-patch wx.createCanvas — 后续创建的所有 canvas (PC 渲染 canvas / 离屏 canvas) 都自动带 wrap
      try {
        if (typeof wx !== 'undefined' && typeof wx.createCanvas === 'function' && !wx.__lunaCanvasWrapped) {
          const __origCreateCanvas = wx.createCanvas;
          wx.createCanvas = function () {
            const c = __origCreateCanvas.apply(wx, arguments);
            return __wrapCanvasGetContext(c);
          };
          wx.__lunaCanvasWrapped = true;
        }
      } catch (e) { console.warn('[video-tex] wx.createCanvas patch failed:', e && e.message); }

      // 兜底: 即使 getContext wrap 没生效, 等 PC 已建好 GL ctx 后我们再 wrap 一次.
      GameGlobal.__lunaWrapGL = __wrapGL;
      GameGlobal.__lunaWrapCanvasGetContext = __wrapCanvasGetContext;
    }

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

    // 暴露 warmup 函数: 启动期外部 RAF chain 调用让 luna PC 第一帧就看到 idle Input 状态
    g.__warmupUIInject = function () {
      try {
        _instrumentUIRead();
        if (!__uiInjectState) {
          // 注入空 idle 状态: 没 active touch, mousePosition=(0,0)
          __uiInjectState = { active: false, ux: 0, uy: 0, dx: 0, dy: 0, phase: 0,
                              fingerId: 0, mockT: null, isDown: false, isUp: false, endedAt: 0, endedTickCount: null };
        }
        _injectUIState();
        console.log('[UI.warmup] Input state injected (idle), UI ready=' + !!(g.UnityEngine && g.UnityEngine.Input));

        // **首次扫码首次触屏漂移 workaround**: web runtime 下浏览器在 canvas 建立时自动 dispatch 'resize',
        // luna PC.app 用它来同步 Canvas Scaler viewport. wx 试玩 runtime 没自动 dispatch,
        // luna PC 第一帧用默认 viewport (750×1334) → Canvas Scaler 第一帧 raycast 错位 → 首次触屏漂移.
        // 主动 dispatch resize + orientationchange + visibilitychange 三发齐, 让 luna PC 重设 viewport.
        try {
          const w = (g._screen && g._screen.cssWidth) || g.innerWidth || 400;
          const h = (g._screen && g._screen.cssHeight) || g.innerHeight || 862;
          const events = ['resize', 'orientationchange', 'visibilitychange'];
          for (const evType of events) {
            try {
              const ev = (typeof g.Event === 'function') ? new g.Event(evType) : { type: evType };
              ev.type = evType;
              if (g._winBus && typeof g._winBus.emit === 'function') g._winBus.emit(evType, ev);
              if (typeof g.dispatchEvent === 'function') { try { g.dispatchEvent(ev); } catch (_) {} }
            } catch (e) {}
          }
          console.log('[UI.warmup] dispatched resize/orientationchange to nudge Canvas Scaler (cssW=' + w + ' cssH=' + h + ')');
        } catch (e) { console.warn('[UI.warmup] resize dispatch FAIL', e && e.message); }
      } catch (e) { console.warn('[UI.warmup] FAIL', e && e.message); }
    };

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
      // **首次 touch 偏移 workaround**: luna PC EventSystem 第一帧 init 时如果 UnityEngine.Input.touches/mousePosition
      // 是 undefined, raycast camera 用默认 viewport, 第一次 OnPointerDown 路由错位.
      // 启动期主动调 _injectUIState 一次让状态非 undefined, 见 dom-shim init 末尾的 warmup tick.
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

  // ---------- window.open 兜底 (Unity Application.OpenURL 路径) ----------
  // 部分 Luna 工程把按钮接到 Application.OpenURL → JS 层 window.open(url).
  // 试玩广告 runtime 里 window.open 不存在, 调用直接 silent fail → 按钮没反应.
  // 这里捕到调用就 fire endUnityGame, 行为对齐 InstallFullGame.
  if (typeof g.open !== 'function') {
    g.open = function (url) {
      console.log('[dom-shim] window.open intercepted url=', url);
      try { if (typeof GameGlobal.endUnityGame === 'function') GameGlobal.endUnityGame(); } catch (e) {}
      return null;
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
  // VideoShim: document.createElement('video') 走这里. 资源型视频走 asset-inject 的
  // makeVideoDecoderProxy (功能完整). 这里给一个最小可用的 _isLunaVideo 代理 — 主要给
  // _instanceof_ HTMLVideoElement / 早期 createElement 兜底, 真正播放需要 src 后调 load().
  function VideoShim() {
    const self = this;
    self._isLunaVideo = true;
    self.tagName = 'VIDEO';
    self.src = ''; self.muted = true; self.autoplay = false; self.loop = false;
    self.currentTime = 0; self.duration = 0; self.paused = true;
    self.videoWidth = 0; self.videoHeight = 0;
    self.readyState = 4; self.networkState = 1;
    self.style = {}; self.dataset = {};
    self._decoder = null; self._latestFrame = null; self._decoderStarted = false;
    self.onloadeddata = null; self.oncanplay = null; self.onerror = null; self.onended = null;

    self.addEventListener = (ev, cb) => { self['on' + ev] = cb; };
    self.removeEventListener = (ev) => { self['on' + ev] = null; };
    self.getAttribute = (k) => k === 'src' ? self.src : null;
    self.setAttribute = () => {};

    self._ensureDecoder = function () {
      if (self._decoder || !self.src) return self._decoder;
      if (typeof wx === 'undefined' || typeof wx.createVideoDecoder !== 'function') return null;
      try {
        self._decoder = wx.createVideoDecoder();
        if (typeof self._decoder.on === 'function') {
          self._decoder.on('start', (info) => {
            if (info && info.width && self.videoWidth === 0) {
              self.videoWidth = info.width; self.videoHeight = info.height;
            }
            if (info && info.duration) self.duration = info.duration / 1000;
          });
          self._decoder.on('ended', () => {
            self.paused = true;
            try { if (typeof self.onended === 'function') self.onended({ type: 'ended' }); } catch (e) {}
          });
        }
      } catch (e) { self._decoder = null; }
      return self._decoder;
    };
    self.load = function () {
      const dec = self._ensureDecoder();
      if (!dec) return;
      try {
        const p = dec.start({ source: self.src, mode: 0, abortAudio: true });
        const after = () => { self._decoderStarted = true; self.paused = false; };
        if (p && p.then) p.then(after, () => {}); else after();
      } catch (e) {}
    };
    self._pullFrame = function () {
      if (!self._decoder) return self._latestFrame;
      if (!self.paused && self._decoderStarted) {
        try {
          const fr = self._decoder.getFrameData();
          if (fr && fr.data && fr.width) {
            self._latestFrame = fr;
            if (self.videoWidth === 0) { self.videoWidth = fr.width; self.videoHeight = fr.height; }
          }
        } catch (e) {}
      }
      return self._latestFrame;
    };
    self.play = () => { if (!self._decoder) self.load(); self.paused = false; return Promise.resolve(); };
    self.pause = () => { self.paused = true; };
    self.remove = () => {
      if (self._decoder) {
        try { self._decoder.stop(); } catch (e) {}
        try { self._decoder.remove(); } catch (e) {}
        self._decoder = null;
      }
    };
  }
  // v19: AudioShim 接 wx.createInnerAudioContext（HTMLAudioElement-style src-based playback）
  function AudioShim() {
    const self = this;
    self.src = ''; self.volume = 1; self.loop = false; self.paused = true;
    self.currentTime = 0; self.duration = 0; self.muted = false;
    const _listeners = Object.create(null);
    let _inner = null;
    const ensure = () => {
      if (_inner) return _inner;
      if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return null;
      try { _wxAudioSessionInit(); } catch (e) {}
      try {
        _inner = wx.createInnerAudioContext();
        _inner.onEnded && _inner.onEnded(() => { self.paused = true; _fire('ended'); });
        _inner.onError && _inner.onError((e) => { _fire('error', e); });
        _inner.onPlay  && _inner.onPlay (() => { self.paused = false; _fire('play'); });
      } catch (e) { console.warn('[AudioShim] createInnerAudioContext failed:', e && e.message); _inner = null; }
      return _inner;
    };
    const _fire = (ev, arg) => {
      const a = _listeners[ev]; if (a) for (const fn of a) { try { fn(arg); } catch (e) {} }
      const cb = self['on' + ev]; if (typeof cb === 'function') { try { cb(arg); } catch (e) {} }
    };
    self.addEventListener    = (ev, fn) => { (_listeners[ev] = _listeners[ev] || []).push(fn); };
    self.removeEventListener = (ev, fn) => { const a = _listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
    self.play = () => {
      const c = ensure(); if (!c) return Promise.resolve();
      try { c.src = self.src; c.loop = !!self.loop; c.volume = self.muted ? 0 : (typeof self.volume === 'number' ? self.volume : 1); c.play(); self.paused = false; }
      catch (e) { console.warn('[AudioShim] play failed:', e && e.message); }
      return Promise.resolve();
    };
    self.pause = () => { if (_inner) { try { _inner.pause(); self.paused = true; } catch (e) {} } };
    self.load  = () => {};
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
  // 必须无条件 force-override:即使 playable runtime 预定义了 HTMLVideoElement/HTMLImageElement,
  // 它的原版没有 Symbol.hasInstance hook → PC 的 `n instanceof HTMLVideoElement` 对我们的 proxy 返 false
  // → PC 走 9-arg path 把 proxy 当 ArrayBufferView 传 → texImage2D 抛 → 视频卡死单帧。
  //
  // 三层组合,任何一层走通即可:
  //   A) 直接 g[key] = ourShim (有些 runtime 上是 writable)
  //   B) Object.defineProperty 强写 (绕 writable=false,只要 configurable=true)
  //   C) Patch Symbol.hasInstance on 已有 constructor (绕 readonly+non-configurable)
  // C 是最强保底:即便 A/B 都失败,只要原 constructor 自身允许 defineProperty 加 well-known symbol,
  // PC 的 `instanceof HVE` 就会经过我们的 duck check.
  const _installCtor = (key, val, duckCheck) => {
    let installed = false;
    // A) 直接赋值
    try { g[key] = val; if (g[key] === val) installed = true; } catch (e) {}
    // B) defineProperty force write
    if (!installed) {
      try { Object.defineProperty(g, key, { value: val, configurable: true, writable: true, enumerable: false }); if (g[key] === val) installed = true; } catch (e) {}
    }
    // C) hasInstance patch on whatever constructor is currently in g[key]
    try {
      const cur = g[key];
      if (cur && typeof cur === 'function' && cur !== val) {
        Object.defineProperty(cur, Symbol.hasInstance, {
          value: function (inst) {
            if (inst == null) return false;
            try { return !!duckCheck(inst); } catch (e) { return false; }
          },
          configurable: true,
        });
        console.log('[dom-shim] patched ' + key + '.@@hasInstance on existing runtime constructor');
      }
    } catch (e) { console.warn('[dom-shim] hasInstance patch failed for ' + key + ':', e && e.message); }
    return installed;
  };
  _installCtor('HTMLImageElement', makeShimCtor(ImageShim, isWxImageLike), isWxImageLike);
  // 浏览器里 Image === HTMLImageElement;打包代码 `new Image()` 走 globalThis 解析,这里同源即可
  _installCtor('Image', g.HTMLImageElement, isWxImageLike);
  _installCtor('HTMLVideoElement', makeShimCtor(VideoShim, isVideoLike), isVideoLike);
  if (typeof g.HTMLAudioElement  === 'undefined') g.HTMLAudioElement  = AudioShim;
  // Luna sound handler 在 _loadSimpleAssetsAsync 里 `new Audio()` 即使资源为 0 也走构造路径,
  // 试玩 runtime 没全局 Audio → ReferenceError → 整个 _loadSimpleAssetsAsync reject → 黑屏。
  // 浏览器里 Audio === HTMLAudioElement, 这里复用 AudioShim 即可。
  if (typeof g.Audio             === 'undefined') g.Audio             = AudioShim;
  _installCtor('HTMLCanvasElement', makeShimCtor(null, isCanvasLike), isCanvasLike);
  if (typeof g.HTMLElement       === 'undefined') g.HTMLElement       = function HTMLElement() {};
  if (typeof g.Element           === 'undefined') g.Element           = function Element() {};
  if (typeof g.Node              === 'undefined') g.Node              = function Node() {};

  // v19 真桥接：PlayCanvas SoundManager + Unity 走 WebAudio 路径
  //   decodeAudioData(arraybuf) → 嗅 mime → base64 data URI → 挂到 buffer._wxDataUri
  //   createBufferSource().start() → wx.createInnerAudioContext + src=dataUri + play()
  //   createGain() → 沿 connect 链回填 volume 到 source
  // Unity webgl AudioClip 默认编码是 ogg/vorbis（或 mp3），decodeAudioData 收到的是
  // 原始 ogg/mp3 bytes，不需要真解码，喂给 InnerAudioContext 让它自己解。
  // 一次性设置 wx 音频会话允许混音
  // Why: iOS 默认 mixWithOther=false → 新 InnerAudioContext.play() 会中断
  //      已经在播的另一个 InnerAudioContext，BGM 听到第一个 SFX 就被打死
  // 必须开 mixWithOther:true；obeyMuteSwitch:false 让静音键不阻播
  function _wxAudioSessionInit() {
    if (GameGlobal.__XXAUDIO_sessionInit) return;
    GameGlobal.__XXAUDIO_sessionInit = true;
    try {
      if (typeof wx !== 'undefined' && typeof wx.setInnerAudioOption === 'function') {
        wx.setInnerAudioOption({ mixWithOther: true, obeyMuteSwitch: false });
        console.log('[XXAUDIO] setInnerAudioOption mixWithOther=true');
      } else {
        console.log('[XXAUDIO] wx.setInnerAudioOption missing');
      }
    } catch (e) { console.warn('[XXAUDIO] setInnerAudioOption failed:', e && e.message); }
  }

  function AudioContextShim() {
    const ctx = this;
    _wxAudioSessionInit();
    try { GameGlobal.__XXAUDIO_ctxNew = (GameGlobal.__XXAUDIO_ctxNew || 0) + 1; } catch (e) {}
    console.log('[XXAUDIO] AudioContext instantiated, count=' + (GameGlobal.__XXAUDIO_ctxNew || 1));
    ctx.state = 'running';
    ctx.sampleRate = 44100;
    ctx.currentTime = 0;
    ctx.destination = { _isDestination: true, connect() {}, disconnect() {} };
    ctx.listener = { setPosition() {}, setOrientation() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };

    // gain 节点：维持 _gain 值，connect 时挂到下游 _next，让 source.start 沿链算总 volume
    let _gainCounter = 0;
    ctx.createGain = () => {
      const _id = ++_gainCounter;
      const _setG = (v, who) => {
        const old = node._gain;
        node._gain = v; node.gain._v = v;
        node._sources && node._sources.forEach(src => { if (src._inner) try { src._inner.volume = src._chainVol(); } catch (e) {} });
        if (old !== v) console.log('[XXAUDIO] gain#' + _id + ' ' + who + ' ' + (typeof old==='number'?old.toFixed(3):old) + '→' + (typeof v==='number'?v.toFixed(3):v));
      };
      const node = {
        gain: {
          _v: 1,
          get value() { return node.gain._v; },
          set value(v) { _setG(v, 'set'); },
          setValueAtTime(v) { _setG(v, 'setAt'); },
          linearRampToValueAtTime(v) { _setG(v, 'linRamp'); },
          exponentialRampToValueAtTime(v) { _setG(v, 'expRamp'); },
          cancelScheduledValues() {},
        },
        _gain: 1, _id: _id, _next: null, _sources: [],
        connect(target) { node._next = target; return target; },
        disconnect() { node._next = null; },
      };
      return node;
    };

    // buffer source：start 时实际起 InnerAudioContext 播放
    ctx.createBufferSource = () => {
      const node = {
        buffer: null,
        playbackRate: { value: 1, setValueAtTime() {} },
        _next: null,
        _inner: null, _started: false, _stopped: false,
        _loop: false,
        get loop() { return node._loop; },
        set loop(v) {
          node._loop = !!v;
          if (node._inner) { try { node._inner.loop = !!v; } catch (e) {} }
        },
        _chainVol() {
          let vol = 1, n = node._next, hops = 0;
          while (n && hops < 16) {
            if (typeof n._gain === 'number') vol *= n._gain;
            if (n._isDestination) break;
            n = n._next; hops++;
          }
          return Math.max(0, Math.min(1, vol));
        },
        connect(target) {
          node._next = target;
          // 沿链注册到 gain 的 _sources，gain 变化时实时更新音量
          let n = target, hops = 0;
          while (n && hops < 16) {
            if (n._sources && n._sources.indexOf(node) < 0) n._sources.push(node);
            if (n._isDestination) break;
            n = n._next; hops++;
          }
          return target;
        },
        disconnect() {
          let n = node._next, hops = 0;
          while (n && hops < 16) {
            if (n._sources) { const i = n._sources.indexOf(node); if (i >= 0) n._sources.splice(i, 1); }
            if (n._isDestination) break;
            n = n._next; hops++;
          }
          node._next = null;
          if (node._inner) { try { node._inner.stop(); node._inner.destroy(); } catch (e) {} node._inner = null; }
        },
        onended: null,
        start(_when) {
          if (node._started || node._stopped) return; node._started = true;
          const buf = node.buffer;
          if (!buf || !buf._wxDataUri) {
            try { GameGlobal.__XXAUDIO_skip = (GameGlobal.__XXAUDIO_skip || 0) + 1; } catch (e) {}
            console.log('[XXAUDIO] start skipped: buf=' + !!buf + ' uri=' + !!(buf && buf._wxDataUri));
            return;
          }
          if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') {
            console.log('[XXAUDIO] start skipped: wx.createInnerAudioContext missing');
            return;
          }
          const vol = node._chainVol();
          try {
            const _inner = wx.createInnerAudioContext();
            node._inner = _inner;
            _inner.src = buf._wxDataUri;
            _inner.loop = !!node._loop;
            _inner.volume = vol;
            _inner.onEnded && _inner.onEnded(() => {
              console.log('[XXAUDIO] ended bytes=' + (buf._wxBytes||0) + ' loop=' + (!!node._loop));
              try { node.onended && node.onended(); } catch (e) {}
              try { node._inner && node._inner.destroy(); } catch (e) {}
              node._inner = null;
            });
            _inner.onError && _inner.onError((e) => {
              console.log('[XXAUDIO] error bytes=' + (buf._wxBytes||0) + ' err=' + JSON.stringify(e||{}));
              try { GameGlobal.__XXAUDIO_err = (GameGlobal.__XXAUDIO_err || 0) + 1; } catch (er) {}
              try { node._inner && node._inner.destroy(); } catch (er) {}
              node._inner = null;
            });
            _inner.play();
            try { GameGlobal.__XXAUDIO_play = (GameGlobal.__XXAUDIO_play || 0) + 1; } catch (e) {}
            console.log('[XXAUDIO] play vol=' + vol.toFixed(2) + ' loop=' + (!!node._loop) + ' bytes=' + (buf._wxBytes||0) + ' mime=' + (buf._wxMime||'?'));
          } catch (e) { console.warn('[ACtxShim] play failed:', e && e.message); }
        },
        stop() {
          node._stopped = true;
          console.log('[XXAUDIO] stop bytes=' + (node.buffer && node.buffer._wxBytes||0));
          if (node._inner) { try { node._inner.stop(); node._inner.destroy(); } catch (e) {} node._inner = null; }
        },
      };
      return node;
    };

    ctx.createBuffer = (ch, len, sr) => ({
      numberOfChannels: ch, length: len, sampleRate: sr || 44100,
      duration: len / (sr || 44100),
      getChannelData: () => new Float32Array(len),
      _wxDataUri: null,
    });

    ctx.createPanner     = () => ({ _next: null, connect(t) { this._next = t; return t; }, disconnect() { this._next = null; }, setPosition() {}, setOrientation() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } });
    ctx.createAnalyser   = () => ({ _next: null, connect(t) { this._next = t; return t; }, disconnect() { this._next = null; }, fftSize: 2048, getByteFrequencyData() {}, getByteTimeDomainData() {} });
    ctx.createOscillator = () => ({ frequency: { value: 440 }, _next: null, connect(t) { this._next = t; return t; }, disconnect() { this._next = null; }, start() {}, stop() {} });

    // 核心：原始 audio bytes → base64 data URI，挂到返回的 buffer 对象上
    ctx.decodeAudioData = (arraybuf, ok, fail) => {
      try {
        const u8 = arraybuf instanceof ArrayBuffer ? new Uint8Array(arraybuf)
                 : (arraybuf && arraybuf.buffer) ? new Uint8Array(arraybuf.buffer, arraybuf.byteOffset || 0, arraybuf.byteLength)
                 : new Uint8Array(0);
        // mime 嗅探（Unity webgl 一般 ogg/vorbis 或 mp3）
        const mime = (u8[0] === 0x4F && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) ? 'audio/ogg'
                   : (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33)                   ? 'audio/mpeg'
                   : (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0)                            ? 'audio/mpeg'
                   : (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) ? 'audio/wav'
                   : (u8[0] === 0x66 && u8[1] === 0x4C && u8[2] === 0x61 && u8[3] === 0x43) ? 'audio/flac'
                   : 'audio/mpeg';
        // 自家 base64 编码器：playable-libs 的 wx.arrayBufferToBase64 是空 stub
        // 返回 ArrayBuffer 自身（truthy non-string），导致拼出 'data:...;base64,undefined'
        // 触发 wxgame-playable-lib atob InvalidCharacterError
        let b64 = '';
        try {
          const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
          let s = '', i = 0, n = u8.length;
          for (; i + 3 <= n; i += 3) {
            const v = (u8[i] << 16) | (u8[i+1] << 8) | u8[i+2];
            s += A[(v>>18)&63] + A[(v>>12)&63] + A[(v>>6)&63] + A[v&63];
          }
          const r = n - i;
          if (r === 1) { const v = u8[i] << 16; s += A[(v>>18)&63] + A[(v>>12)&63] + '=='; }
          else if (r === 2) { const v = (u8[i] << 16) | (u8[i+1] << 8); s += A[(v>>18)&63] + A[(v>>12)&63] + A[(v>>6)&63] + '='; }
          b64 = s;
        } catch (e) { console.warn('[ACtxShim] base64 encode failed:', e && e.message); }
        const buffer = {
          duration: 0, sampleRate: 44100, numberOfChannels: 2, length: 0,
          getChannelData: () => new Float32Array(0),
          _wxDataUri: b64 ? ('data:' + mime + ';base64,' + b64) : null,
          _wxMime: mime,
          _wxBytes: u8.length,
        };
        try { GameGlobal.__XXAUDIO_dec = (GameGlobal.__XXAUDIO_dec || 0) + 1; GameGlobal.__XXAUDIO_lastMime = mime; GameGlobal.__XXAUDIO_lastBytes = u8.length; } catch (e) {}
        console.log('[XXAUDIO] decode bytes=' + u8.length + ' mime=' + mime + ' b64Len=' + (typeof b64 === 'string' ? b64.length : ('!str:'+typeof b64)));
        ok && ok(buffer);
        return Promise.resolve(buffer);
      } catch (e) {
        fail && fail(e);
        return Promise.reject(e);
      }
    };

    ctx.resume              = () => Promise.resolve();
    ctx.suspend             = () => Promise.resolve();
    ctx.close               = () => Promise.resolve();
    ctx.addEventListener    = () => {};
    ctx.removeEventListener = () => {};
  }
  if (typeof g.AudioContext       === 'undefined') g.AudioContext       = AudioContextShim;
  if (typeof g.webkitAudioContext === 'undefined') g.webkitAudioContext = AudioContextShim;

  // 试玩 runtime: GameGlobal !== globalThis (game.js startGame bridge 已确认)。
  // eval 的打包代码 `new Audio()` / `new Event()` 走 globalThis 解析裸标识符 →
  // 设到 GameGlobal 上的 shim 看不见 → ReferenceError → _loadSimpleAssetsAsync reject → 黑屏。
  // 把 dom-shim 暴露的关键构造器同步到 globalThis,且只设 globalThis 上不存在的。
  try {
    if (typeof globalThis !== 'undefined' && globalThis !== g) {
      // 必须 force-override (不带 typeof undefined guard): playable runtime 已经预定义了
      // HTMLVideoElement / HTMLImageElement 等到 globalThis,但它们没有 Symbol.hasInstance hook
      // → PC 的 instanceof 对 proxy/wx-Image 返 false → 走错分支 → 黑屏/视频卡帧。
      // 必须把带 hasInstance 的 shim 镜像过去覆盖原版。每项独立 try/catch:
      // 个别 key (常见 Event/MouseEvent) 在 playable runtime 里被锁成 non-configurable readonly,
      // 单次写入失败会抛 TypeError; 不能让一项 readonly 把后面 16 项都中断。
      const _forceMirror = ['HTMLImageElement','HTMLVideoElement','HTMLCanvasElement','Image'];
      for (const k of _forceMirror) {
        if (typeof g[k] !== 'undefined') {
          try { globalThis[k] = g[k]; } catch (e) {}
        }
      }
      // 其余 keys 保持只补缺(不覆盖 playable runtime 的原版,避免 instanceof 关系漂移)
      const _mirror = ['Event','MouseEvent','WheelEvent','KeyboardEvent','TouchEvent','PointerEvent',
        'Audio','HTMLAudioElement','HTMLElement','Element','Node','AudioContext','webkitAudioContext'];
      for (const k of _mirror) {
        if (typeof globalThis[k] === 'undefined' && typeof g[k] !== 'undefined') {
          try { globalThis[k] = g[k]; } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // **首次 touch 偏移 workaround**: luna PC EventSystem 第一帧 init 时若 UnityEngine.Input.touches/mousePosition
  // 是 undefined, raycast camera 用默认 viewport, 第一次 OnPointerDown 路由错位 → 用户感知首次操控偏移.
  // 不等到第一次 touch 才装 hook + 注入状态, 启动期 RAF chain retry 直到 luna runtime 设了 UnityEngine.Input,
  // 主动注入 active=false 的 idle 状态让 EventSystem 第一帧看到完整 Input 表面.
  try {
    let _warmupAttempts = 0;
    const _warmupTick = setInterval(function () {
      _warmupAttempts++;
      const UI = g.UnityEngine && g.UnityEngine.Input;
      if (UI && typeof UI.mousePosition !== 'undefined' || _warmupAttempts > 100) {
        // luna runtime 已设 UnityEngine.Input, 装 read hook + 注入 idle 状态
        try {
          // 直接调 dom-shim 内部函数; 通过 g.__warmupUIInject 路径暴露 (闭包内)
          if (typeof g.__warmupUIInject === 'function') g.__warmupUIInject();
        } catch (e) {}
        clearInterval(_warmupTick);
      }
    }, 50);
  } catch (e) {}
})();

