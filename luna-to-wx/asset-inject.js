/**
 * 替代 luna-runtime/_to_rewrite/16_base122_dom_bind.js
 *
 * 原逻辑: 扫描 [data-src122] DOM 元素 → base122 解码 → Blob → Object URL → 注入 src;
 *        把 <img> 的 onload 收集到 window._decode122Promise.
 * 微信版: 读 manifest.json, 解码资源到 USER_DATA_PATH, 用 wx.createImage 异步预加载,
 *        构造与原 DOM 元素接口兼容的 wrapper, 注册到 dom-shim 的 elements 表.
 *
 * 依赖:
 *   - GameGlobal._base122ToArrayBuffer  (来自 11_base122_decode.js)
 *   - GameGlobal.document._registerElement (来自 dom-shim.js)
 *   - 资源文件已被 postprocess.js 落盘到 assets/inline/{data,src122}/
 */

(function injectAssets() {
  const g = GameGlobal;
  const fs = wx.getFileSystemManager();

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  } catch (e) {
    console.warn('[asset-inject] manifest.json 读不到, 资源注入跳过:', e);
    g._decode122Promise = Promise.resolve();
    return;
  }

  const decode122 = g._base122ToArrayBuffer;
  if (!decode122 && manifest.assets.some(a => a.kind === 'src122')) {
    console.warn('[asset-inject] _base122ToArrayBuffer 未定义, src122 资源会失败');
  }

  const doc = g.document;
  const promises = [];

  for (const a of manifest.assets || []) {
    promises.push(loadOne(a).catch(e => {
      console.warn('[asset-inject] 加载失败:', a.id, e);
      // 单个资源失败不阻塞整体启动
    }));
  }

  g._decode122Promise = Promise.all(promises);

  function loadOne(asset) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        if (asset.kind === 'data') {
          // 主包/分包内的文件, 微信下用相对路径 (Image 可直接读)
          url = asset.rel;
        } else if (asset.kind === 'src122') {
          const enc = fs.readFileSync(asset.rel, 'utf8');
          const buf = decode122(enc);
          const ext = (asset.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
          const dst = `${wx.env.USER_DATA_PATH}/luna-${asset.id}.${ext}`;
          fs.writeFileSync(dst, buf);
          url = dst;
        }
      } catch (e) { return reject(e); }

      if (asset.tag === 'img') {
        // 用真实 wx.Image 注册 — PlayCanvas 在 Texture.setSource() 内部会
        // gl.texImage2D(target, level, fmt, fmt, type, image), wx WebGL 只接受真 wx.Image,
        // 不接受 plain proxy。同时 Luna 的 texture handler `$.setSource(n), n.remove(); $.mipmaps...`
        // 会调 n.remove(), 真 wx.Image 没这方法 → 直接给原型挂个 no-op。
        const img = wx.createImage();
        if (typeof img.remove !== 'function') img.remove = function () {};
        img.onload = () => {
          // **关键**: Luna InlineResources.GetImageAsync 走 `n.complete ? setResult(n) : n.onload=...`
          // wx.Image 没 .complete 属性 (或 defineProperty 锁住返 false) → 走 false 分支
          // → 它给 n.onload 重新赋值, 但 wx.Image 已 fire 过, 不会再触发 → task 永远 pending
          // → _loadSimpleAssetsAsync hang → InitializeAsync 永不 resolve → 黑屏。
          // 必须强制把 .complete 设为 true 配真值; 用 defineProperty 覆盖任何 getter。
          try {
            Object.defineProperty(img, 'complete', { value: true, writable: true, configurable: true });
          } catch (e) { try { img.complete = true; } catch (_) {} }
          // 类似处理 naturalWidth/Height — 走 instanceof HTMLImageElement 的代码路径会读
          try {
            if (img.naturalWidth  == null) Object.defineProperty(img, 'naturalWidth',  { value: img.width  || 0, writable: true, configurable: true });
            if (img.naturalHeight == null) Object.defineProperty(img, 'naturalHeight', { value: img.height || 0, writable: true, configurable: true });
          } catch (e) {}
          // 兜底字段, defineProperty 锁住的忽略
          try {
            img.tagName = 'IMG';
            img.id = asset.id;
            if (typeof img.getAttribute  !== 'function') img.getAttribute  = function (k) { return k === 'src' ? url : null; };
            if (typeof img.setAttribute  !== 'function') img.setAttribute  = function () {};
            if (typeof img.addEventListener !== 'function') img.addEventListener = function () {};
            if (typeof img.removeEventListener !== 'function') img.removeEventListener = function () {};
            if (img.dataset == null) img.dataset = {};
            if (img.style   == null) img.style   = {};
          } catch (e) {}
          if (doc && doc._registerElement) doc._registerElement(asset.id, img);
          resolve();
        };
        img.onerror = e => reject(e);
        img.src = url;
      } else if (asset.tag === 'video') {
        // 视频代理: 用 wx.createVideoDecoder() 提供逐帧 RGBA 数据,
        // dom-shim 的 GL texImage2D wrapper 检测 _isLunaVideo 后改走 9 参数 byteView 形态上传.
        // 没有 createVideoDecoder 时 fallback 到 stub (开头视频丢, 但不阻塞游戏).
        const proxy = makeVideoDecoderProxy(asset, url);
        console.log('[video-proxy] registered ' + asset.id + ' src=' + url);
        // 不要在这里 auto-load — decoder.start 会在 PC 还没建起渲染管线之前把视频跑完,
        // 表现是 "刚开头有个声音 然后黑屏"(v20.1 实测). 让 PC VideoTexture / setSource 流程触发 .load() / .play().
        if (doc && doc._registerElement) doc._registerElement(asset.id, proxy);
        resolve();
      } else if (asset.tag === 'audio') {
        // 音频不预加载, 仅登记元数据; AudioShim/AudioContextShim 走 wx.createInnerAudioContext.
        // 没 .load() 整条 _loadSimpleAssetsAsync rejects → InitializeAsync 永不 resolve。
        const proxy = {
          tagName: 'AUDIO',
          id: asset.id, src: url,
          dataset: {}, style: {},
          duration: 0, currentTime: 0, paused: true, muted: false, autoplay: false, loop: false,
          readyState: 4, networkState: 1,
          onloadeddata: null, oncanplay: null, onerror: null,
          getAttribute(k) { return k === 'src' ? url : null; },
          setAttribute() {},
          addEventListener() {}, removeEventListener() {},
          load() {
            setTimeout(() => {
              try { if (typeof proxy.onloadeddata === 'function') proxy.onloadeddata({ type: 'loadeddata' }); } catch (e) {}
              try { if (typeof proxy.oncanplay     === 'function') proxy.oncanplay({ type: 'canplay' }); } catch (e) {}
            }, 0);
          },
          play()  { return Promise.resolve(); },
          pause() {},
          remove() {},
        };
        if (doc && doc._registerElement) doc._registerElement(asset.id, proxy);
        resolve();
      } else {
        resolve();
      }
    });
  }

  // ---------- 视频代理工厂 ----------
  // wx.createVideoDecoder() 接口产出 {data: ArrayBuffer (RGBA), width, height, pkPts, pkDts}.
  // 在 dom-shim 的 GL texImage2D wrapper 里被识别 (_isLunaVideo === true), 改走 9 参数上传形态.
  //
  // PC 资源加载流程 (Network.GetVideoAsync):
  //   const tex = new VideoTexture(graphicsDevice, opts);
  //   network.GetVideoAsync(url).continueWith(e => {
  //     const n = e.result;          // 我们这里返回的 proxy
  //     tex.setSource(n);            // 内部第一次 gl.texImage2D, 此时帧数据可能还没来
  //     resolve(tex);
  //   });
  // 之后 PC 每帧 _uploadTexImage2D 时会再次取 source → 我们 _pullFrame() 给最新一帧.
  //
  // 帧延迟容忍: 第一次 setSource 调用时 _latestFrame 可能为 null (decoder.start 异步, 帧还没出);
  // GL wrapper 收到 null 直接 skip 调用 — 不 throw, 让 PC 继续; 下一帧再来.
  function makeVideoDecoderProxy(asset, url) {
    const proxy = {
      _isLunaVideo: true,
      tagName: 'VIDEO',
      id: asset.id, src: url,
      dataset: {}, style: {},
      duration: 0, currentTime: 0,
      paused: true, muted: false, autoplay: false, loop: false,
      videoWidth: 0, videoHeight: 0,
      readyState: 4, networkState: 1,
      onloadeddata: null, oncanplay: null, onerror: null, onended: null,

      getAttribute(k) { return k === 'src' ? this.src : null; },
      setAttribute() {},
      addEventListener(ev, cb) { this['on' + ev] = cb; },
      removeEventListener(ev) { this['on' + ev] = null; },

      _decoder: null,
      _latestFrame: null,
      _decoderStarted: false,
      _firstFrameSeen: false,
      _timeAdvancer: null,
      _startWallTime: 0,

      _ensureDecoder() {
        if (this._decoder) return this._decoder;
        if (typeof wx === 'undefined' || typeof wx.createVideoDecoder !== 'function') {
          console.warn('[video-proxy] wx.createVideoDecoder 不可用, 视频会静默丢');
          return null;
        }
        try {
          this._decoder = wx.createVideoDecoder();
          const self = this;
          if (typeof this._decoder.on === 'function') {
            this._decoder.on('start', (info) => {
              if (info && info.width && self.videoWidth === 0) {
                self.videoWidth  = info.width;
                self.videoHeight = info.height;
              }
              if (info && info.duration) self.duration = info.duration / 1000;
              console.log('[video-proxy] decoder start: ' + (info ? JSON.stringify(info) : ''));
            });
            this._decoder.on('ended', () => {
              self.paused = true;
              console.log('[video-proxy] decoder ended (1-shot): ' + self.id);
              if (typeof self.onended === 'function') {
                try { self.onended({ type: 'ended' }); } catch (e) {}
              }
            });
          }
        } catch (e) {
          console.warn('[video-proxy] createVideoDecoder failed:', e && e.message);
          this._decoder = null;
        }
        return this._decoder;
      },

      load() {
        const dec = this._ensureDecoder();
        if (!dec) {
          setTimeout(() => {
            try { if (typeof this.onloadeddata === 'function') this.onloadeddata({ type: 'loadeddata' }); } catch (e) {}
            try { if (typeof this.oncanplay     === 'function') this.oncanplay({ type: 'canplay' }); } catch (e) {}
          }, 0);
          return;
        }
        // **不立即 dec.start()** — 视频 duration 仅 ~1s, 但 luna:build → PC render loop spinup
        // 需要 ~800ms+. 立即启动 → ended 时 PC 才刚 upload 1 帧 → 视觉上"只一帧". 加 loop 又
        // 让内嵌音轨反复播 (用户反馈 "音频反复播放"). 唯一干净的方案: deferred start —
        // 标记 _wantsStart=true, 等 PC 真的来调 _pullFrame 时再 dec.start, 这样 video timeline
        // 起点 = PC 准备好 upload 第一帧的时刻, 1066ms 内 PC 能稳定 upload 多帧, 1-shot 完整播完.
        this._wantsStart = true;
        // _loadSimpleAssetsAsync 等 onloadeddata 才放行加载流水. 立即 fire — PC 不必等 video 真起.
        const self = this;
        setTimeout(() => {
          try { if (typeof self.onloadeddata === 'function') self.onloadeddata({ type: 'loadeddata' }); } catch (e) {}
          try { if (typeof self.oncanplay     === 'function') self.oncanplay({ type: 'canplay' }); } catch (e) {}
        }, 0);
        console.log('[video-proxy] deferred start armed: ' + this.id);
      },

      _ensureDecoderStarted() {
        if (this._decoderStarted || this._startInFlight) return;
        const dec = this._decoder;
        if (!dec) return;
        this._startInFlight = true;
        const self = this;
        try {
          // abortAudio: false — 视频内嵌音轨 (旁白/BGM) 1-shot 完整播放 1 次
          const p = dec.start({ source: this.src, mode: 0, abortAudio: false });
          const onStarted = () => {
            self._decoderStarted = true;
            self.paused = false;
            self._startWallTime = Date.now();
            if (self._timeAdvancer) clearInterval(self._timeAdvancer);
            self._timeAdvancer = setInterval(() => {
              if (!self.paused && self._decoderStarted) {
                self.currentTime = (Date.now() - self._startWallTime) / 1000;
              }
            }, 33);
            self._pollFirstFrame();
            console.log('[video-proxy] deferred-started ' + self.id + ' at PC-pull-trigger');
          };
          if (p && typeof p.then === 'function') p.then(onStarted, (e) => {
            self._startInFlight = false;
            console.warn('[video-proxy] deferred dec.start failed:', e && (e.errMsg || e.message));
          });
          else onStarted();
        } catch (e) {
          self._startInFlight = false;
          console.warn('[video-proxy] deferred dec.start threw:', e && e.message);
        }
      },

      _pollFirstFrame() {
        // onloadeddata 已在 onStarted 立即 fire (不阻塞加载); 这里只用来填首帧 videoWidth/videoHeight.
        let attempts = 0;
        const self = this;
        const tick = () => {
          attempts++;
          let fr = null;
          try { fr = self._decoder && self._decoder.getFrameData(); } catch (e) {}
          if (fr && fr.data && fr.width) {
            self._latestFrame = fr;
            self._firstFrameSeen = true;
            if (self.videoWidth === 0) { self.videoWidth = fr.width; self.videoHeight = fr.height; }
            console.log('[video-proxy] first frame ' + fr.width + 'x' + fr.height + ' attempts=' + attempts);
            return;
          }
          if (attempts >= 60) return;
          setTimeout(tick, 16);
        };
        tick();
      },

      // GL wrapper 每次 PC 上传纹理时调; 拉一帧最新数据, 没新数据就返回上一帧 (PC 复用即可).
      _pullFrame() {
        this._pullCnt = (this._pullCnt || 0) + 1;
        // **第一次 PC 来拉帧 = PC render loop ready 信号**: 这里触发 deferred dec.start(),
        // 让视频 timeline 起点对齐 PC 第一次想 upload 的时刻 — 完整 1066ms 都给 PC 用.
        if (this._wantsStart && !this._decoderStarted && !this._startInFlight) {
          console.log('[video-pull-trigger#' + this._pullCnt + '] ' + this.id + ' starting decoder on PC first pull');
          this._ensureDecoderStarted();
        }
        if (!this._decoder) {
          if (this._pullCnt === 1 || this._pullCnt === 30) {
            console.log('[video-pull#' + this._pullCnt + '] ' + this.id + ' no-decoder paused=' + this.paused);
          }
          return this._latestFrame;
        }
        let fr = null;
        if (this._decoderStarted) {
          try {
            fr = this._decoder.getFrameData();
            if (fr && fr.data && fr.width) {
              const newPts = fr.pkPts;
              this._latestFrame = fr;
              if (this.videoWidth === 0) { this.videoWidth = fr.width; this.videoHeight = fr.height; }
              this._lastPts = newPts;
              this._frameUpdates = (this._frameUpdates || 0) + 1;
            } else {
              this._frameNullPolls = (this._frameNullPolls || 0) + 1;
            }
          } catch (e) { this._frameErrs = (this._frameErrs || 0) + 1; }
        }
        if (this._pullCnt === 1 || this._pullCnt === 10 || this._pullCnt === 30 || this._pullCnt === 100 || this._pullCnt === 300) {
          console.log('[video-pull#' + this._pullCnt + '] ' + this.id +
            ' paused=' + this.paused + ' started=' + this._decoderStarted +
            ' frameUpdates=' + (this._frameUpdates || 0) +
            ' nullPolls=' + (this._frameNullPolls || 0) +
            ' errs=' + (this._frameErrs || 0) +
            ' lastPts=' + (this._lastPts || 'none') +
            ' hasLatest=' + (!!this._latestFrame));
        }
        return this._latestFrame;
      },

      play() {
        if (!this._decoder) this.load();
        this.paused = false;
        return Promise.resolve();
      },
      pause() { this.paused = true; },
      remove() {
        if (this._decoder) {
          try { this._decoder.stop(); } catch (e) {}
          try { this._decoder.remove(); } catch (e) {}
          this._decoder = null;
        }
      },
    };
    return proxy;
  }
})();
