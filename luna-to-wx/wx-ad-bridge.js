/**
 * 替代 luna-runtime/_to_rewrite/21_ad_bridge.js
 *
 * 原文件做四件事 (基于 IAB MRAID 规范, 微信下不存在):
 *   1. mraid.viewableChange/stateChange → dispatch luna:start / luna:resume / luna:pause
 *   2. mraid.audioVolumeChange         → dispatch luna:unsafe:mute / luna:unsafe:unmute
 *   3. luna:build 后 → wait Bridge.ready → 注册 InstallFullGame CTA 跳商店
 *   4. iOS Safari 的 touchend/click 兜底跳转
 *
 * 微信版替代:
 *   1. wx.onShow / onHide                              → luna:start / luna:resume / luna:pause
 *   2. wx.onAudioInterruptionBegin / End               → luna:unsafe:mute / unmute
 *   3. luna:build 后 → 注册 InstallFullGame → wx.navigateToMiniProgram
 *   4. 微信不需要 iOS Safari 兜底 (touchend 直接走 canvas)
 *
 * CTA 跳转目标: 优先用 packageConfig.wxAppId / wxPath; 否则 fallback 到 cfg.androidLink
 * 解析 (期望形如 "weixin://dl/business/?appid=...&path=...&query=..." 或商店链接).
 */

(function wxAdBridge() {
  const g = GameGlobal;
  const win = g;

  // ---- 早期 fix: pc.platform.touch=true ----
  // wx-ad-bridge require 时 pc 还没 load (deferred 探针确认 pc.platform 当时是 NULL),
  // 等到 deepProbe 时才看到 pc.platform={} 空对象 — 真 PC Application 在 luna:build 之后构造,
  // PlayCanvas 在 Application 构造前会自己 detect 并填 platform.touch/mobile。
  // 多次 retry: 找到 pc.platform 非空时立即 patch。
  (function patchPlatform() {
    let attempts = 0;
    function tick() {
      attempts++;
      try {
        if (g.pc && g.pc.platform) {
          if (g.pc.platform.touch !== true)  g.pc.platform.touch  = true;
          if (g.pc.platform.mobile !== true) g.pc.platform.mobile = true;
          console.log('[wx-ad-bridge] pc.platform.touch=true mobile=true (attempt ' + attempts + ')');
          // 但 PC 在 Application 构造期就检查 pc.platform.touch — 若已构造完, 这次太晚。
          // 不影响 — 我们靠 UnityEngine.Input 直接注入即可。
          return;
        }
      } catch (e) {}
      if (attempts < 30) setTimeout(tick, 100);
    }
    tick();
  })();

  // ---- 早期 hook: pc.Texture.prototype.setSource — 想抓 InitializeAsync 期的纹理 upload ----
  // 这里 wx-ad-bridge 在 game.js 里的 require 顺序在 main scripts 之后, asset-inject 之前,
  // 但 InitializeAsync (调 setSource) 要等 luna:build 才启动 → 此时 hook 来得及。
  try {
    const TexProto = g.pc && g.pc.Texture && g.pc.Texture.prototype;
    if (TexProto && typeof TexProto.setSource === 'function' && !TexProto.__probed) {
      const orig = TexProto.setSource;
      let cnt = 0;
      TexProto.setSource = function (t) {
        const N = ++cnt;
        if (N <= 12) {
          try {
            const isImg    = (g.HTMLImageElement  && t instanceof g.HTMLImageElement);
            const isCanvas = (g.HTMLCanvasElement && t instanceof g.HTMLCanvasElement);
            const isVideo  = (g.HTMLVideoElement  && t instanceof g.HTMLVideoElement);
            const isAB     = (t instanceof ArrayBuffer);
            console.log('[setSource#' + N + '] tex.name=' + this.name + ' arg.ctor=' + (t && t.constructor && t.constructor.name) +
                         ' isImg=' + isImg + ' isCanvas=' + isCanvas + ' isVideo=' + isVideo + ' isAB=' + isAB +
                         ' tag=' + (t && t.tagName) + ' src=' + (t && typeof t.src) +
                         ' w=' + (t && t.width) + 'x' + (t && t.height));
          } catch (e) { console.log('[setSource#' + N + '] log err:', e && e.message); }
        }
        const r = orig.apply(this, arguments);
        if (N <= 12) {
          console.log('[setSource#' + N + '] post: tex._width=' + this._width + ' _levels[0]=' +
            (this._levels && this._levels[0] ? this._levels[0].constructor.name : 'null'));
        }
        return r;
      };
      TexProto.__probed = true;
      console.log('[wx-ad-bridge] hooked pc.Texture.prototype.setSource');
    } else {
      console.log('[wx-ad-bridge] cannot hook setSource — pc.Texture missing or already probed');
    }
  } catch (e) { console.log('[wx-ad-bridge] setSource hook threw:', e && e.message); }

  // 整个 IIFE 的每个顶层动作都包 try/catch；目标是 require() 一定 OK，
  // 不让任何一条 playable-libs 内部的崩溃把 bridge 整个拉下水。
  function step(label, fn) {
    try { fn(); console.log('[wx-ad-bridge] step OK:', label); }
    catch (e) { console.log('[wx-ad-bridge] step FAIL:', label, e && e.message || e); }
  }

  // 直接走 dom-shim 的 emitter（_winBus / _bus），避开任何可能被 playable-libs 重 wrap 的 addEventListener
  function winOn(type, cb) {
    if (g._winBus && typeof g._winBus.on === 'function') g._winBus.on(type, cb);
    else if (typeof win.addEventListener === 'function') win.addEventListener(type, cb);
  }
  function winEmit(type, ev) {
    if (g._winBus && typeof g._winBus.emit === 'function') g._winBus.emit(type, ev);
    else if (typeof win.dispatchEvent === 'function') win.dispatchEvent(ev);
  }

  // ---------- 资产 handler swallow ----------
  // texture handler 99/99 ok 但 _loadSimpleAssetsAsync 仍 hang →
  // 其它 handler (mesh / shader / animation_clip / video / sound …) 中某个 Promise 永不 resolve。
  // wrap Mc$.Kc$.Bundle.handlers.* 的 loadAsync, 把视觉/逻辑非关键资源 (sound/video) 失败 swallow,
  // 让 Promise.all 不挂。Bundle.configure(t, e) 每次都 `se.handlers = { 28 new instances }`,
  // 所以单次 hook 不够 — 必须包 configure 本身, 在它之后重新 wrap。
  step('hook bundle handlers (NONESSENTIAL swallow)', () => {
    // 哪些 handler 失败时不阻塞整体启动 — 视觉/逻辑非关键的资源 (声音/视频) 允许 swallow
    const NONESSENTIAL = new Set(['sound', 'video', 'audio_mixer', 'audio_mixer_snapshot']);

    function wrapHandlers(hs) {
      for (const k of Object.keys(hs)) {
        const h = hs[k];
        if (!h || typeof h.loadAsync !== 'function' || h.__wrapped) continue;
        const origLoad = h.loadAsync.bind(h);
        h.loadAsync = function () {
          let r;
          try { r = origLoad.apply(this, arguments); }
          catch (e) {
            // 同步错误: 非关键 handler 返回 resolved promise 让 Promise.all 不挂; 关键的依旧 throw
            if (NONESSENTIAL.has(k)) return Promise.resolve(null);
            throw e;
          }
          if (r && typeof r.then === 'function' && NONESSENTIAL.has(k)) {
            return r.then(v => v, _ => null); // swallow → 不阻塞 Promise.all
          }
          return r;
        };
        h.__wrapped = true;
      }
    }

    function tryHookConfigure() {
      const Bundle = g['Mc$'] && g['Mc$']['Kc$'] && g['Mc$']['Kc$'].Bundle;
      if (!Bundle || typeof Bundle.configure !== 'function' || Bundle.__configureWrapped) return false;
      const orig = Bundle.configure;
      Bundle.configure = function (t, e) {
        const r = orig.call(this, t, e);
        try { if (Bundle.handlers) wrapHandlers(Bundle.handlers); } catch (e) {}
        return r;
      };
      Bundle.__configureWrapped = true;
      // 已经存在的 handlers 也包一遍 (configure 可能在我们 hook 之前已跑过)
      if (Bundle.handlers) wrapHandlers(Bundle.handlers);
      return true;
    }
    [10, 50, 200, 500, 1500].forEach(t => setTimeout(tryHookConfigure, t));
  });

  // ---------- 启动信号 ----------
  let started = false, paused = false;
  function fireStart()  { if (started) return; started = true; winEmit('luna:start',  new g.Event('luna:start'));  }
  function fireResume() { if (!paused) return; paused = false; winEmit('luna:resume', new g.Event('luna:resume')); }
  function firePause()  { if (paused)  return; paused = true;  winEmit('luna:pause',  new g.Event('luna:pause'));  }
  function fireMute(unmute) {
    const t = unmute ? 'luna:unsafe:unmute' : 'luna:unsafe:mute';
    winEmit(t, new g.Event(t));
  }

  // ---------- 微信生命周期接入 ----------
  // 试玩 runtime 上 wx.onShow/onHide/onAudioInterruption*/canIUse 全是空 stub,
  // 调用时 wx 自己 console.error("xxx() is not implemented on wx") 而不是 throw,
  // try/catch 包不住 → 根本不调用。试玩广告也不需要这些生命周期, 直接 skip。

  // ---------- CTA: 跳转目标 (微信下走小游戏跳转, 没有就 fallback) ----------
  function doJump() {
    const cfg = (win.$environment && win.$environment.packageConfig) || {};
    // 优先支持显式微信跳转配置
    if (cfg.wxAppId) {
      wx.navigateToMiniProgram({
        appId: cfg.wxAppId,
        path: cfg.wxPath || '',
        envVersion: cfg.wxEnvVersion || 'release',
        success() { console.log('[wx-ad-bridge] navigateToMiniProgram ok'); },
        fail(e)  { console.log('[wx-ad-bridge] navigateToMiniProgram fail:', e); },
      });
      return;
    }
    // 没配 wxAppId, 试着从商店链接里抽 (用户可能后填)
    const url = cfg.androidLink || cfg.iosLink || '';
    console.log('[wx-ad-bridge] CTA 触发但没配 wxAppId; 商店链接:', url);
    // 标记给 host page; 真正的导出工程要在 packageConfig 里加 wxAppId
    if (typeof GameGlobal.endUnityGame === 'function') GameGlobal.endUnityGame();
  }

  let shouldJump = false;
  function tryJump() {
    if (!shouldJump) return;
    shouldJump = false;
    doJump();
  }

  // ---------- 与 Luna lifecycle 接线 ----------
  step('register luna:build', () => {
    winOn('luna:build', function () {
      try { if (win.pi && win.pi.logLoaded) win.pi.logLoaded(); } catch (e) {}
      fireStart();
      const Bridge = win.Bridge;
      const Luna   = win.Luna;
      const register = function () {
        if (Luna && Luna.Unity && Luna.Unity.Playable) {
          Luna.Unity.Playable.InstallFullGame = function () {
            try { if (win.pi && win.pi.logCta) win.pi.logCta(); } catch (e) {}
            shouldJump = true;
            tryJump();
          };
        } else {
          console.log('[wx-ad-bridge] Luna.Unity.Playable 未就绪');
        }
      };
      if (Bridge && typeof Bridge.ready === 'function') {
        try { Bridge.ready(register); } catch (e) { console.log('[wx-ad-bridge] Bridge.ready threw, calling register direct', e && e.message); register(); }
      } else { register(); }
    });
  });

  // ---------- 环境光兜底 (probe + fix) ----------
  // Luna URP/Lit shader 走 Unity SH 路径: unity_SHAr/Ag/Ab/Br/Bg/Bb/SHC + ambientSky/Equator/Ground。
  // 数据源是 UnityEngine.RenderSettings.ambientProbe (pc.SphericalHarmonicsL2) + ambientSkyColor 等.
  // dispatchGlobalLights 每帧从 RenderSettings 读, 我们改写 RenderSettings 即可.
  // 如果 ambientProbe / ambientSkyColor 都是零 (asset 反序列化掉了或 RenderSettings 资源没装上),
  // → URP shader 看到零环境光 → 黑屏 (但 emissive/无光 unlit 部分仍有轮廓).
  // 启动后跑一次: dump 现状, 把 zero 字段填成 sky+ground 默认.
  step('ambient lighting probe+fix', () => {
    let done = false, attempts = 0;
    function approxZero(v) { return Math.abs(v) < 1e-6; }
    function arrZero(a) { return !a || Array.from(a).every(approxZero); }
    function tryFix() {
      attempts++;
      if (done) return true;
      const RS = (win.UnityEngine && win.UnityEngine.RenderSettings) || (g.UnityEngine && g.UnityEngine.RenderSettings);
      if (!RS) return false;

      const probe = RS.ambientProbe;
      const sky   = RS.ambientSkyColor     && RS.ambientSkyColor.data;
      const eq    = RS.ambientEquatorColor && RS.ambientEquatorColor.data;
      const gr    = RS.ambientGroundColor  && RS.ambientGroundColor.data;
      const probeData = probe && probe.data ? Array.from(probe.data) : null;

      console.log('[ambient] probe.data=', probeData);
      console.log('[ambient] skyColor=', sky && Array.from(sky), 'equator=', eq && Array.from(eq), 'ground=', gr && Array.from(gr));
      const probeZero = !probe || arrZero(probe.data);
      const skyZero = arrZero(sky), eqZero = arrZero(eq), grZero = arrZero(gr);
      console.log('[ambient] zero flags: probe=', probeZero, 'sky=', skyZero, 'eq=', eqZero, 'gr=', grZero);

      // intensity 0.15 — 上一轮 0.5 把角色冲成白模,降到 1/3 给方向光留余量
      const I = 0.15;
      if (sky && skyZero) { sky[0]=I*0.50; sky[1]=I*0.60; sky[2]=I*0.80; sky[3]=1; }
      if (eq  && eqZero)  { eq[0]=I*0.45;  eq[1]=I*0.45;  eq[2]=I*0.45;  eq[3]=1; }
      if (gr  && grZero)  { gr[0]=I*0.30;  gr[1]=I*0.25;  gr[2]=I*0.20;  gr[3]=1; }

      if (probe && probeZero && typeof probe.clear === 'function' && typeof probe.addSkyGradient === 'function') {
        const Color = (win.pc && win.pc.Color) || (g.pc && g.pc.Color);
        if (Color) {
          probe.clear();
          probe.addSkyGradient(new Color(I*0.5,I*0.6,I*0.8,1), new Color(I*0.45,I*0.45,I*0.45,1), new Color(I*0.3,I*0.25,I*0.2,1));
          console.log('[ambient] forced ambientProbe = sky-gradient default (I=' + I + ')');
        } else {
          console.log('[ambient] no pc.Color, skipping SH gradient');
        }
      }

      done = true;
      console.log('[ambient] patched (attempt ' + attempts + ')');

      // ambient 跑完后 +3s 再做 lights/lightmap 深探针 — 那时 scene 完全装好
      setTimeout(deepProbe, 3000);
      return true;
    }
    function deepProbe() {
      // ---- 1. _lights ----
      try {
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const scene = pcApp && (pcApp.scene || pcApp._scene);
        const lights = scene && (scene._lights || scene.lights);
        if (!lights) {
          console.log('[deep] no scene._lights at ' + (Date.now()) + '; scene keys=', scene ? Object.keys(scene).slice(0,20) : 'no scene');
        } else {
          console.log('[deep] _lights.count=' + lights.length);
          for (let i = 0; i < Math.min(lights.length, 6); i++) {
            const L = lights[i];
            const lc = (L && L.light) || L;
            const node = L && L._node;
            console.log('[deep] light[' + i + '] name=' + (node && node.name) +
                         ' type=' + (lc && (lc.type || lc._type)) +
                         ' enabled=' + (lc && lc.enabled) +
                         ' intensity=' + (lc && lc.intensity) +
                         ' colorRGB=' + (lc && (lc._color || lc.color) && JSON.stringify({r:(lc._color||lc.color).r,g:(lc._color||lc.color).g,b:(lc._color||lc.color).b})) +
                         ' lum=' + (lc && lc._luminance) +
                         ' renderMode=' + (lc && lc._renderMode));
          }
        }
      } catch (e) { console.log('[deep] lights probe threw:', e && e.message); }

      // ---- 1.5 全局 light uniform — URP shader 真正读的 _MainLightColor / _MainLightPosition / _AdditionalLights* ----
      // Luna dispatchGlobalLights 只 dispatch ambient+reflection 没 dispatch URP main/additional light uniform
      // → URP/Lit/CausticLit shader 拿到 0 光照 → 几何体黑色剪影
      try {
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const dev = pcApp && (pcApp.graphicsDevice || pcApp._graphicsDevice);
        const scope = dev && dev.scope;
        if (!scope || typeof scope.resolve !== 'function') {
          console.log('[deep] no graphicsDevice.scope');
        } else {
          const dump = (name) => {
            try {
              const id = scope.resolve(name);
              const v = id && id.value;
              if (v == null) return name + '=NULL';
              if (typeof v === 'number') return name + '=' + v;
              if (v.length != null) return name + '=arr[' + v.length + ']:' + Array.from(v).slice(0,4).map(x=>typeof x==='number'?x.toFixed(3):x).join(',');
              return name + '=obj';
            } catch (e) { return name + '=ERR:' + e.message; }
          };
          const urpKeys = [
            '_MainLightPosition', '_MainLightColor',
            '_AdditionalLightsCount',
            'unity_SHAr', 'unity_SHAg', 'unity_SHAb', 'unity_SHBr', 'unity_SHBg', 'unity_SHBb', 'unity_SHC',
            // FOG — 水下场景嫌疑最大
            'unity_FogColor', 'unity_FogParams', 'fog_color', 'fog_params',
            // 后处理/曝光/伽马
            'unity_Exposure', '_Exposure', 'unity_AmbientIntensity',
          ];
          console.log('[deep] URP/Unity light uniforms:');
          for (const k of urpKeys) console.log('[deep]  ' + dump(k));
        }
      } catch (e) { console.log('[deep] uniform probe threw:', e && e.message); }

      // ---- 1.6 scene 级 fog/exposure/gamma 配置 ----
      try {
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const scene = pcApp && (pcApp.scene || pcApp._scene);
        if (scene) {
          const fogInfo = {
            fog: scene.fog,
            _fog: scene._fog,
            fogColor: scene.fogColor && {r:scene.fogColor.r,g:scene.fogColor.g,b:scene.fogColor.b,a:scene.fogColor.a},
            fogStart: scene.fogStart, fogEnd: scene.fogEnd, fogDensity: scene.fogDensity,
            exposure: scene.exposure, _exposure: scene._exposure,
            gammaCorrection: scene.gammaCorrection, toneMapping: scene.toneMapping,
          };
          console.log('[deep] scene fog/exposure:', JSON.stringify(fogInfo));
        }
      } catch (e) { console.log('[deep] scene-config probe threw:', e && e.message); }

      // ---- 1.7 检查 sample MI 贴图实际上传状态 (_width/_height/gpuTexture) ----
      try {
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const scene = pcApp && (pcApp.scene || pcApp._scene);
        if (scene && scene._renderers) {
          let firstFew = [];
          for (const rr of scene._renderers) {
            const mis = rr && (rr._meshInstances || rr.meshInstances);
            if (mis) for (const m of mis) { firstFew.push(m); if (firstFew.length >= 3) break; }
            if (firstFew.length >= 3) break;
          }
          for (let i = 0; i < firstFew.length; i++) {
            const mat = firstFew[i] && firstFew[i].material;
            const params = mat && mat.parameters;
            if (!params) continue;
            const texInfo = {};
            for (const k of ['_MainTex', '_BaseMap', '_Normal', '_NormalMap']) {
              const p = params[k];
              const tex = p && p.data;
              if (!tex) continue;
              const src = tex._source;
              const lvls = tex._levels;
              texInfo[k] = {
                w: tex._width, h: tex._height, fmt: tex._format,
                keys: Object.keys(tex).filter(x=>!x.startsWith('__')).slice(0,15),
                src: src ? {
                  type: (src.constructor && src.constructor.name) || typeof src,
                  w: src.width, h: src.height,
                  url: src.src && String(src.src).slice(-40),
                  complete: src.complete,
                } : null,
                lvls: lvls ? { len: lvls.length, l0: lvls[0] && ((lvls[0].constructor && lvls[0].constructor.name) || typeof lvls[0]) } : null,
                needsUpload: tex._needsUpload, loaded: tex._loaded, _gpuSize: tex._gpuSize,
                impl: tex._impl ? Object.keys(tex._impl).slice(0,8) : (tex.impl ? Object.keys(tex.impl).slice(0,8) : null),
              };
            }
            console.log('[deep] tex MI[' + i + ']: ' + JSON.stringify(texInfo));
          }
        }
      } catch (e) { console.log('[deep] tex probe threw:', e && e.message); }

      // ---- 1.8 全局注册表盘点 ----
      try {
        // (a) dom-shim 注册的 img 元素 (asset-inject 写入)
        const doc = g.document;
        const elems = doc && (doc._elements || doc.elements);
        if (elems) {
          const ids = Object.keys(elems);
          let imgCnt = 0, withWH = 0, sample = [];
          for (const id of ids) {
            const el = elems[id];
            if (!el) continue;
            if (el.tagName === 'IMG' || (el.constructor && el.constructor.name === 'Image')) {
              imgCnt++;
              if (el.width > 0) withWH++;
              if (sample.length < 3) sample.push({id: id.slice(0,30), w: el.width, h: el.height, complete: el.complete, src: (el.src||'').slice(-30)});
            }
          }
          console.log('[deep] doc._elements: total=' + ids.length + ' img=' + imgCnt + ' withWH=' + withWH);
          console.log('[deep] doc._elements sample:', JSON.stringify(sample));
        } else {
          console.log('[deep] no doc._elements');
        }

        // (b) graphicsDevice.textures — 真实创建的 GL 纹理
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const dev = pcApp && (pcApp.graphicsDevice || pcApp._graphicsDevice);
        const scene = pcApp && (pcApp.scene || pcApp._scene);
        const texs = dev && (dev.textures || dev._textures);
        if (texs) {
          let total = 0, real = 0, named = {};
          for (const t of texs) {
            total++;
            if (t && t._width > 4) real++;
            if (t && t.name) named[t.name] = (named[t.name] || 0) + 1;
          }
          const namedKeys = Object.keys(named);
          console.log('[deep] gd.textures: total=' + total + ' realW>4=' + real + ' uniqueNames=' + namedKeys.length);
          console.log('[deep] gd.textures top names:', JSON.stringify(namedKeys.slice(0, 10).map(n => n + ':' + named[n])));
        }

        // (c) 看其中一个真实 width>4 的 tex 的 name/glTex 状态
        if (texs) {
          let bigTex = null;
          for (const t of texs) if (t && t._width > 16) { bigTex = t; break; }
          if (bigTex) {
            console.log('[deep] sample big tex: name=' + bigTex.name + ' w=' + bigTex._width + 'x' + bigTex._height +
                         ' src=' + (bigTex._source ? (bigTex._source.constructor && bigTex._source.constructor.name) : 'null') +
                         ' lvl0=' + (bigTex._levels && bigTex._levels[0] ? (bigTex._levels[0].constructor && bigTex._levels[0].constructor.name) : 'null') +
                         ' impl=' + !!bigTex._impl);
          } else {
            console.log('[deep] NO texture in gd.textures has width > 16 — all are 4x4 placeholders');
          }
        }

        // (d) sample MI 的 _MainTex.name/$id
        if (scene && scene._renderers) {
          let firstFew = [];
          for (const rr of scene._renderers) {
            const mis = rr && (rr._meshInstances || rr.meshInstances);
            if (mis) for (const m of mis) { firstFew.push(m); if (firstFew.length >= 3) break; }
            if (firstFew.length >= 3) break;
          }
          for (let i = 0; i < firstFew.length; i++) {
            const params = firstFew[i] && firstFew[i].material && firstFew[i].material.parameters;
            if (!params) continue;
            const mt = params._MainTex && params._MainTex.data;
            const nm = params._Normal && params._Normal.data;
            console.log('[deep] tex-id MI[' + i + ']: _MainTex.name="' + (mt && mt.name) + '" $id=' + (mt && mt.$id) +
                         ' / _Normal.name="' + (nm && nm.name) + '" $id=' + (nm && nm.$id));
          }
        }
      } catch (e) { console.log('[deep] registry probe threw:', e && e.message); }

      // ---- 1.9 测试 doc.getElementById 是否返回 asset-inject 注册的 wx.Image ----
      try {
        const doc = g.document;
        if (doc && typeof doc.getElementById === 'function') {
          // 试几个 manifest 里的 image id
          const probeIds = [
            'assets/bundles/-1/-1015042.png',
            'assets/bundles/-1/105042.jpeg',
            'assets/bundles/-1/2128.png',
          ];
          for (const id of probeIds) {
            const el = doc.getElementById(id);
            if (!el) {
              console.log('[deep] getElementById("' + id.slice(-30) + '")=NULL');
            } else {
              console.log('[deep] getElementById("' + id.slice(-30) + '"): w=' + el.width + ' h=' + el.height + ' complete=' + el.complete + ' tag=' + el.tagName + ' ctor=' + (el.constructor && el.constructor.name));
            }
          }
          // 计数: 遍历 manifest, 多少 id 能找到
          try {
            const fs = wx.getFileSystemManager();
            const mf = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
            const imgs = (mf.assets || []).filter(a => a.tag === 'img');
            let found = 0, withWH = 0;
            for (const a of imgs) {
              const e = doc.getElementById(a.id);
              if (e) { found++; if (e.width > 0) withWH++; }
            }
            console.log('[deep] manifest img total=' + imgs.length + ' getElementById-found=' + found + ' withWH=' + withWH);
          } catch (e) { console.log('[deep] manifest-walk threw:', e && e.message); }
        }
        // _decode122Promise 状态
        const p = g._decode122Promise;
        if (p) {
          console.log('[deep] _decode122Promise present (Promise instance:' + (p.constructor && p.constructor.name) + ')');
        } else {
          console.log('[deep] _decode122Promise=NULL');
        }

        // ---- 1.9a 各 _bus 已注册的事件类型 (找 PC TouchDevice 实际监听在哪) ----
        try {
          function busDump(bus) {
            if (!bus) return 'NULL';
            if (typeof bus._stats === 'function') return JSON.stringify(bus._stats());
            if (typeof bus._types === 'function') {
              const types = bus._types();
              const out = {};
              for (const t of types) out[t] = typeof bus._count === 'function' ? bus._count(t) : 1;
              return JSON.stringify(out);
            }
            return 'no-stats-api';
          }
          const doc = g.document;
          console.log('[deep] canvas._bus=' + busDump(g.canvas && g.canvas._bus));
          console.log('[deep] doc._bus=' + busDump(doc && doc._bus));
          console.log('[deep] body._bus=' + busDump(doc && doc.body && doc.body._bus));
          console.log('[deep] docEl._bus=' + busDump(doc && doc.documentElement && doc.documentElement._bus));
          console.log('[deep] win._bus=' + busDump(g._winBus));

          // 监听器源码 dump — 区分真 PC 处理器 vs playable-libs 注入的 dummy stub
          // 关键 mouse 事件: mousedown/mousemove/mouseup; 也看 touchstart/end 看 PC TouchDevice 注没注册
          function srcDump(bus, type) {
            if (!bus || typeof bus._listSources !== 'function') return type + '=N/A';
            const arr = bus._listSources(type);
            if (!arr.length) return type + '=NONE';
            return type + ' x' + arr.length + ': [' + arr.map((s, i) => '#' + i + ':' + s.replace(/\s+/g, ' ')).join(' ||| ') + ']';
          }
          for (const t of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchend']) {
            console.log('[deep] win._bus ' + srcDump(g._winBus, t));
          }
          for (const t of ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mousemove', 'mouseup']) {
            console.log('[deep] canvas._bus ' + srcDump(g.canvas && g.canvas._bus, t));
          }
          // body 上有 touchstart/click/keydown/keyup — PC TouchDevice/Keyboard 跑到 body 去了, 这是关键
          for (const t of ['touchstart', 'touchmove', 'touchend', 'click', 'keydown', 'keyup', 'mousedown']) {
            console.log('[deep] body._bus ' + srcDump(doc && doc.body && doc.body._bus, t));
          }
          // 把 bus 引用挂到 GameGlobal, dom-shim 里第一次真触摸后再 dump 一次
          g.__busesForRedump = {
            win: g._winBus,
            canvas: g.canvas && g.canvas._bus,
            body: doc && doc.body && doc.body._bus,
          };

          // app.mouse / app.touch 初始状态
          try {
            const pcMod = g.pc;
            const pcApp = (pcMod && pcMod.Application && pcMod.Application.getApplication && pcMod.Application.getApplication()) || g.app;
            if (pcApp) {
              const m = pcApp.mouse, t = pcApp.touch, k = pcApp.keyboard;
              console.log('[deep] app.mouse=' + (m ? ('en=' + m._enabled + ' tgt=' + (m._target && m._target.constructor && m._target.constructor.name) + ' btns=' + JSON.stringify(m._buttons || []) + ' lastBtns=' + JSON.stringify(m._lastbuttons || [])) : 'NULL'));
              console.log('[deep] app.touch=' + (t ? ('en=' + t._enabled + ' el=' + (t._element && t._element.constructor && t._element.constructor.name) + ' tn=' + (t._touches ? t._touches.length : 'no-_touches') + ' keys=' + Object.keys(t).slice(0,15).join(',')) : 'NULL'));
              console.log('[deep] app.keyboard=' + (k ? ('en=' + k._enabled + ' tgt=' + (k._target && k._target.constructor && k._target.constructor.name)) : 'NULL'));
            } else {
              console.log('[deep] no pcApp for input probe');
            }
          } catch (e) { console.log('[deep] input probe threw:', e && e.message); }

          // UnityEngine.Input 状态 (Luna Bridge.NET emulation)
          try {
            const UE = (g.UnityEngine || (g.win && g.win.UnityEngine));
            const UI = UE && UE.Input;
            if (UI) {
              console.log('[deep] UnityEngine.Input keys=' + Object.keys(UI).slice(0, 30).join(','));
              const tc = (typeof UI.touchCount === 'function') ? UI.touchCount() : UI.touchCount;
              console.log('[deep] UnityEngine.Input.touchCount=' + tc);
              if (UI.mousePosition) {
                try {
                  const mp = (typeof UI.mousePosition === 'function') ? UI.mousePosition() : UI.mousePosition;
                  console.log('[deep] UnityEngine.Input.mousePosition=' + JSON.stringify({x: mp && mp.x, y: mp && mp.y}));
                } catch (e2) {}
              }
              if (typeof UI.GetMouseButton === 'function') {
                console.log('[deep] UnityEngine.Input.GetMouseButton(0)=' + UI.GetMouseButton(0));
              }
              // 全 keys 的 type/value, 看 mangled 里哪个是 touches/mouseButtons
              const fullKeys = Object.keys(UI);
              console.log('[deep] UI fullKeysCount=' + fullKeys.length);
              const samples = [];
              for (const k of fullKeys) {
                let v;
                try { v = UI[k]; } catch (e) { samples.push(k + '=GET_THREW'); continue; }
                if (typeof v === 'function') continue;
                if (v == null) { samples.push(k + '=' + String(v)); continue; }
                if (typeof v === 'number' || typeof v === 'boolean') samples.push(k + '=' + v);
                else if (typeof v === 'string') samples.push(k + '=str:' + v.slice(0, 20));
                else if (Array.isArray(v)) samples.push(k + '=arr[' + v.length + ']');
                else if (typeof v === 'object') {
                  try { samples.push(k + '=obj{' + Object.keys(v).slice(0,4).join(',') + '}'); }
                  catch (_) { samples.push(k + '=obj?'); }
                } else samples.push(k + '=' + typeof v);
              }
              console.log('[deep] UI nonFn fields: ' + samples.join(' | '));

              // 留 snapshot 函数给 dispatchTouch diff 用
              g.__UI_snapshotFn = function () {
                const out = {};
                for (const k of Object.keys(UI)) {
                  let v;
                  try { v = UI[k]; } catch (e) { out[k] = '<threw>'; continue; }
                  if (typeof v === 'function') continue;
                  if (v == null) { out[k] = String(v); continue; }
                  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = String(v).slice(0,30);
                  else if (Array.isArray(v)) out[k] = 'arr[' + v.length + ']';
                  else if (typeof v === 'object') { try { out[k] = 'obj{' + Object.keys(v).slice(0,5).join(',') + '}'; } catch (_) { out[k] = 'obj?'; } }
                }
                return out;
              };
              g.__UI_snapshot_initial = g.__UI_snapshotFn();

              // 关键字段的 property descriptor — 是 plain field 还是 getter/setter
              const descKeys = ['touches', 'X$', 'V$', 'W$', 'z$', 'A$', 'B$', 'multiTouchEnabled', 'anyKey', 'mousePosition'];
              const descs = {};
              for (const k of descKeys) {
                const d = Object.getOwnPropertyDescriptor(UI, k);
                if (!d) { descs[k] = 'NONE'; continue; }
                descs[k] = (d.get ? 'GET' : '') + (d.set ? 'SET' : '') + (d.value !== undefined ? 'V:' + typeof d.value : '') + (d.writable ? '|w' : '') + (d.configurable ? '|c' : '');
              }
              console.log('[deep] UI descriptors: ' + JSON.stringify(descs));

              // 字段内容详情
              try { console.log('[deep] UI.W$ value=' + JSON.stringify(UI.W$ && {x: UI.W$.x, y: UI.W$.y, _data: UI.W$._data && Array.from(UI.W$._data)})); } catch (e) {}
              try { console.log('[deep] UI.z$ value=' + JSON.stringify(Array.from(UI.z$ || []))); } catch (e) {}
              try { console.log('[deep] UI.A$ value=' + JSON.stringify(Array.from(UI.A$ || []))); } catch (e) {}
              try { console.log('[deep] UI.B$ value=' + JSON.stringify(Array.from(UI.B$ || []))); } catch (e) {}
              try {
                const Z = UI.Z$;
                if (Z) console.log('[deep] UI.Z$ keys=' + Object.keys(Z).slice(0,20).join(',') + ' values: ' + JSON.stringify(Object.fromEntries(Object.entries(Z).slice(0,10).map(([k,v])=>[k, typeof v === 'function' ? 'fn' : (v == null ? String(v) : (typeof v === 'object' ? (v.constructor && v.constructor.name)+':'+Object.keys(v).slice(0,4).join(',') : v))]))));
              } catch (e) {}
              try {
                const C = UI.C$;
                if (C) console.log('[deep] UI.C$ keys=' + Object.keys(C).slice(0,20).join(',') + ' isClass=' + ('$init' in C) + ' name=' + (C.$$name || C.$$fullname || '?'));
              } catch (e) {}

              // 检查 window/document/canvas 上的 ontouchstart 直赋值 (不走 addEventListener)
              const onTouchStarts = {
                'win.ontouchstart':    typeof g.ontouchstart,
                'doc.ontouchstart':    g.document && typeof g.document.ontouchstart,
                'body.ontouchstart':   g.document && g.document.body && typeof g.document.body.ontouchstart,
                'canvas.ontouchstart': g.canvas && typeof g.canvas.ontouchstart,
                'win.ontouchmove':     typeof g.ontouchmove,
                'win.ontouchend':      typeof g.ontouchend,
              };
              console.log('[deep] ontouch* properties: ' + JSON.stringify(onTouchStarts));

              // UnityEngine.Touch 类 (用于构造真 Touch 实例)
              const TC = (g.UnityEngine && g.UnityEngine.Touch);
              if (TC) {
                console.log('[deep] UnityEngine.Touch exists, keys=' + Object.keys(TC).slice(0, 25).join(','));
              } else {
                console.log('[deep] no UnityEngine.Touch');
              }
            } else {
              console.log('[deep] no UnityEngine.Input');
            }
          } catch (e) { console.log('[deep] UE.Input probe threw:', e && e.message); }

          // pc.platform 检查 — touch=false 会让 PC 不创建 TouchDevice
          try {
            const pcMod = g.pc;
            console.log('[deep] pc.platform=' + JSON.stringify({
              touch: pcMod && pcMod.platform && pcMod.platform.touch,
              touchEnabled: pcMod && pcMod.platform && pcMod.platform.touchEnabled,
              mobile: pcMod && pcMod.platform && pcMod.platform.mobile,
              workers: pcMod && pcMod.platform && pcMod.platform.workers,
            }));
            const pcApp = (pcMod && pcMod.Application && pcMod.Application.getApplication && pcMod.Application.getApplication()) || g.app;
            if (pcApp) {
              console.log('[deep] pcApp touch/input/mouse fields: ' + Object.keys(pcApp).filter(k => /touch|input|mouse|keyboard/i.test(k)).join(','));
              const m = pcApp.mouse;
              if (m && m.events) {
                const ev = m.events;
                const cb = ev._callbacks || ev._events;
                console.log('[deep] mouse.events.types=' + (cb ? Object.keys(cb).slice(0,15).join(',') : 'no _callbacks'));
              }
            }
          } catch (e) { console.log('[deep] platform probe threw:', e && e.message); }
        } catch (e) { console.log('[deep] bus stats threw:', e && e.message); }

        // ---- 1.9b 验证 instanceof HTMLImageElement 是否被 dom-shim 的 Symbol.hasInstance 拦截 ----
        try {
          const HIE = g.HTMLImageElement;
          console.log('[deep] HTMLImageElement defined=' + (typeof HIE) + ' name=' + (HIE && HIE.name) +
                       ' hasSymbolHasInstance=' + (HIE && Object.getOwnPropertyDescriptor(HIE, Symbol.hasInstance) ? 'YES' : 'NO'));
          // 拿一个真实的 wx.Image 测一下
          const sample = doc && doc.getElementById('assets/bundles/-1/-1015042.png');
          if (sample) {
            console.log('[deep] sample wxImg: ctor=' + (sample.constructor && sample.constructor.name) +
                         ' src=' + (typeof sample.src) + ' tagName=' + sample.tagName +
                         ' w/h=' + typeof sample.width + '/' + typeof sample.height);
            console.log('[deep] wxImg instanceof HTMLImageElement=' + (sample instanceof HIE) +
                         ' instanceof HTMLCanvasElement=' + (sample instanceof g.HTMLCanvasElement) +
                         ' instanceof HTMLVideoElement=' + (sample instanceof g.HTMLVideoElement));
          } else {
            console.log('[deep] no sample wxImg for instanceof test');
          }
          // 看 PC 是否还认 ArrayBuffer (确认 setSource 走的是哪个分支)
          const buf = new ArrayBuffer(4);
          console.log('[deep] new ArrayBuffer(4) instanceof ArrayBuffer=' + (buf instanceof ArrayBuffer));
        } catch (e) { console.log('[deep] hasInstance probe threw:', e && e.message); }

        // ---- 1.9c 找 pc.Texture.prototype.setSource, hook 它打印每次调用看 t 是什么类型 ----
        try {
          const pcMod = g.pc || (typeof pc !== 'undefined' ? pc : null);
          const TexProto = pcMod && pcMod.Texture && pcMod.Texture.prototype;
          if (TexProto && typeof TexProto.setSource === 'function' && !TexProto.__probed) {
            const orig = TexProto.setSource;
            let cnt = 0;
            TexProto.setSource = function (t) {
              if (cnt < 8) {
                cnt++;
                try {
                  const isImg = (g.HTMLImageElement && t instanceof g.HTMLImageElement);
                  const isCanvas = (g.HTMLCanvasElement && t instanceof g.HTMLCanvasElement);
                  const isVideo = (g.HTMLVideoElement && t instanceof g.HTMLVideoElement);
                  const isAB = (t instanceof ArrayBuffer);
                  console.log('[setSource] this.name=' + this.name + ' arg.ctor=' + (t && t.constructor && t.constructor.name) +
                               ' isImg=' + isImg + ' isCanvas=' + isCanvas + ' isVideo=' + isVideo + ' isAB=' + isAB +
                               ' tag=' + (t && t.tagName) + ' src=' + (t && typeof t.src));
                } catch (e) {}
              }
              const r = orig.apply(this, arguments);
              if (cnt < 8) {
                console.log('[setSource] post: this._width=' + this._width + ' _levels[0]=' + (this._levels && this._levels[0] ? this._levels[0].constructor.name : 'null'));
              }
              return r;
            };
            TexProto.__probed = true;
            console.log('[deep] hooked pc.Texture.prototype.setSource');
          } else {
            console.log('[deep] cannot hook setSource (already probed or no pc.Texture)');
          }
        } catch (e) { console.log('[deep] setSource hook threw:', e && e.message); }
      } catch (e) { console.log('[deep] elem-lookup probe threw:', e && e.message); }

      // ---- 2. lightmaps (核心嫌疑) ----
      try {
        const LMS = (win.UnityEngine && win.UnityEngine.LightmapSettings) || (g.UnityEngine && g.UnityEngine.LightmapSettings);
        if (!LMS) {
          console.log('[deep] no LightmapSettings');
        } else {
          const mgr = LMS.manager;
          const mgrLM = mgr && mgr.lightmaps;
          console.log('[deep] LightmapSettings.manager.lightmaps.length=' + (mgrLM ? mgrLM.length : 'undefined'));
          if (mgrLM) {
            for (let i = 0; i < mgrLM.length; i++) {
              const e = mgrLM[i];
              if (!e) { console.log('[deep] lm[' + i + ']=null/undefined (slot empty)'); continue; }
              const sub = e.lightmaps || [];
              console.log('[deep] lm[' + i + '] sub.length=' + sub.length + ' custom=' + e.custom);
              for (let j = 0; j < Math.min(sub.length, 4); j++) {
                const L = sub[j];
                console.log('[deep] lm[' + i + '][' + j + '] color=' + (L && !!L.lightmapColor) +
                             ' colorHandle=' + (L && L.lightmapColor && !!L.lightmapColor.handle) +
                             ' dir=' + (L && !!L.lightmapDirection));
              }
            }
          }
        }
      } catch (e) { console.log('[deep] lightmap probe threw:', e && e.message); }

      // ---- 3. 数 mesh instance 用 lightmap 的占比 + 自动 fallback ----
      try {
        const pc = win.pc || g.pc;
        const pcApp = (pc && pc.Application && typeof pc.Application.getApplication === 'function') ? pc.Application.getApplication() : (win.app || g.app);
        const scene = pcApp && (pcApp.scene || pcApp._scene);
        // MI 不在 scene 上, 在 scene._renderers[i]._meshInstances 上
        let MIs = null;
        if (scene && scene._renderers) {
          MIs = [];
          for (const rr of scene._renderers) {
            const rmis = rr && (rr._meshInstances || rr.meshInstances);
            if (rmis && rmis.length) for (const m of rmis) MIs.push(m);
          }
          console.log('[deep] scene._renderers.length=' + scene._renderers.length + ' collected MIs=' + MIs.length);
        }
        if (!MIs || MIs.length === 0) {
          console.log('[deep] no MIs (renderers=' + (scene && scene._renderers ? scene._renderers.length : 'N/A') + ')');
        } else {
          let withLM = 0, withoutLM = 0, sceneIdxSet = new Set();
          for (const m of MIs) {
            if (m && typeof m.lightmapIndex === 'number' && m.lightmapIndex >= 0) {
              withLM++;
              sceneIdxSet.add(m.lightmapSceneIndex);
            } else {
              withoutLM++;
            }
          }
          console.log('[deep] MI total=' + MIs.length + ' withLightmap=' + withLM + ' without=' + withoutLM +
                       ' sceneIdxs=' + JSON.stringify([...sceneIdxSet]));

          // 兜底: 如果有 mesh 引用 lightmap 但 manager 没有该 scene 的 lightmap 数据 → 强制 lightmapIndex=-1
          // 让 shader 走 LIGHTMAP_OFF 分支(用 ambient probe), 至少环境不再是纯黑.
          const LMS = (win.UnityEngine && win.UnityEngine.LightmapSettings) || (g.UnityEngine && g.UnityEngine.LightmapSettings);
          const mgr = LMS && LMS.manager;
          // Lightmap manager 是空的 → 强制所有 MI 走 LIGHTMAP_OFF
          // 不查 sub.lightmapColor.handle 那条已确认全空, 直接全部切
          let forcedOff = 0;
          const noLMData = !mgr || !mgr.lightmaps || mgr.lightmaps.length === 0;
          if (withLM > 0 && noLMData) {
            for (const m of MIs) {
              if (m && typeof m.lightmapIndex === 'number' && m.lightmapIndex >= 0) {
                m.lightmapIndex = -1;
                if (typeof m._shaderDefs === 'number') {
                  m._shaderDefs &= ~0x4;     // SHADERDEF_LM
                  m._shaderDefs &= ~0x8;     // SHADERDEF_DIRLM
                  m._shader = null;          // 清缓存的编译 shader, 强制重 link
                }
                forcedOff++;
              }
            }
          }
          console.log('[deep] LM-fallback: noLMData=' + noLMData + ' forced=' + forcedOff + ' / withLM=' + withLM);

          // ---- 4. shader 程序链接状态 (核心嫌疑) ----
          // 前期 probe: CausticLit "ready=true has impl=false has program=false" → GL program 没 link.
          // 看 498 个 MI 里 material/shader 健康度.
          const shaderState = {};   // shaderName → {total, hasMat, hasShader, hasImpl, hasProgram, linkOK}
          const samples = [];
          for (let mi_idx = 0; mi_idx < MIs.length; mi_idx++) {
            const m = MIs[mi_idx];
            const mat = m && m.material;
            const sh = mat && (mat._shader || mat.shader);
            // material 实际编译出的程序在 mi._shader (per-variant cache) 或 sh._impl._programs
            const miSh = m && (m._shader || m.shader);
            const program = miSh && (miSh._impl || miSh.impl) && (miSh._impl._program || miSh.impl._program);
            const linked = program && (typeof program.gl !== 'undefined' || program._linked === true || program.ready === true);

            const name = (sh && (sh.name || sh._name)) || (mat && mat.shaderName) || (mat && mat.shader && mat.shader.name) || '?';
            if (!shaderState[name]) shaderState[name] = { total:0, hasMat:0, hasShader:0, hasMiShader:0, hasImpl:0, hasProgram:0 };
            shaderState[name].total++;
            if (mat) shaderState[name].hasMat++;
            if (sh) shaderState[name].hasShader++;
            if (miSh) shaderState[name].hasMiShader++;
            if (miSh && (miSh._impl || miSh.impl)) shaderState[name].hasImpl++;
            if (program) shaderState[name].hasProgram++;

            if (mi_idx < 6) {
              const params = (mat && mat.parameters) || {};
              const paramSummary = {};
              for (const k of Object.keys(params).slice(0, 30)) {
                const v = params[k];
                // Luna param wrapper: {scopeId, data, passFlags}; data is the actual value/texture
                if (v && typeof v === 'object' && 'data' in v) {
                  const d = v.data;
                  if (d == null) paramSummary[k] = 'NULL';
                  else if (typeof d === 'number' || typeof d === 'boolean') paramSummary[k] = 'num:' + d;
                  else if (d instanceof Float32Array || d instanceof Int32Array || (d.length != null && typeof d !== 'string')) paramSummary[k] = 'arr[' + d.length + ']:' + Array.from(d).slice(0,4).map(x=>(typeof x==='number'?x.toFixed(2):x)).join(',');
                  else if (typeof d === 'object') {
                    // 可能是 wx 创建的 texture wrapper, 或 Luna 的 Texture 类
                    paramSummary[k] = 'tex?:' + (d.handle ? 'h:'+(d.handle.constructor && d.handle.constructor.name)
                                                : d._handle ? 'h:'+(d._handle.constructor && d._handle.constructor.name)
                                                : d.gl ? 'gl' : 'obj:' + Object.keys(d).slice(0,4).join(','));
                  } else paramSummary[k] = 'unk:' + typeof d;
                } else paramSummary[k] = String(v).slice(0,20);
              }
              samples.push({
                idx: mi_idx,
                name: m && m.node && m.node.name,
                shader: name,
                visible: m && m.visible,
                cull: m && m.cull,
                paramKeys: Object.keys(params).length,
                params: paramSummary,
              });
            }
          }
          console.log('[deep] shader state by name:', JSON.stringify(shaderState));
          console.log('[deep] sample MIs:', JSON.stringify(samples));
        }
      } catch (e) { console.log('[deep] MI probe threw:', e && e.message); }

      console.log('[deep] done');
    }

    // RenderSettings 是 startGame → app.InitializeAsync 链里反序列化, 多重试到拿到为止
    const tick = () => {
      if (tryFix() || attempts >= 40) return;
      setTimeout(tick, 500);
    };
    setTimeout(tick, 1500);
  });

  // canvas touchend 兜底 — 走 dom-shim 注册的 _bus，避免任何 wrap
  step('canvas touchend', () => {
    const c = g.canvas;
    if (!c) return;
    if (c._bus && typeof c._bus.on === 'function') c._bus.on('touchend', tryJump);
    else if (typeof c.addEventListener === 'function') c.addEventListener('touchend', tryJump);
  });

})();
