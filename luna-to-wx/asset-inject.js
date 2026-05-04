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
      } else if (asset.tag === 'video' || asset.tag === 'audio') {
        // 媒体不预加载, 仅登记元数据; 真正播放走 luna-to-wx/{video,audio}.js (Phase 2)
        // Luna 的 InlineResources.GetVideoAsync 流程:
        //   n.onloadeddata = function(t){ e.b$(n); }, n.load(), return e.task;
        // 没 .load() 整条 _loadSimpleAssetsAsync rejects → InitializeAsync 永不 resolve。
        // 这里 load() 直接 async fire onloadeddata 让 task complete。
        const proxy = {
          tagName: asset.tag.toUpperCase(),
          id: asset.id,
          src: url,
          dataset: {}, style: {},
          // 元数据兜底, 后面 video texture upload phase 真要播再换 wx 视频实例
          duration: 0, currentTime: 0, paused: true, muted: true, autoplay: false, loop: false,
          videoWidth: 0, videoHeight: 0,
          readyState: 4,           // HAVE_ENOUGH_DATA — 让 PlayCanvas 认为已可用
          networkState: 1,
          onloadeddata: null, oncanplay: null, onerror: null,
          getAttribute(k) { return k === 'src' ? url : null; },
          setAttribute() {},
          addEventListener() {}, removeEventListener() {},
          load() {
            // 异步触发 onloadeddata, 模拟视频元素加载完成
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
})();
