// 启动期 splash: dom-shim 之后 luna 出画面要 ~3-4s, 这段不能黑屏.
// **只画 1 帧, 不 setTimeout/setInterval** — 后续 wx event loop 任何 timer 都会和
// luna PC InitializeAsync 抢 GPU 队列, 拖慢启动 (实测 setInterval+50ms 拖 600ms+).
// 静态进度条 + 深蓝背景 已经能让用户看到"在加载".
(function bootSplash() {
  const g = GameGlobal;
  let c = g.canvas;
  if (!c) { try { c = g.canvas = wx.createCanvas(); } catch (e) { return; } }
  let gl = null;
  try { gl = c.getContext('webgl2') || c.getContext('webgl'); } catch (e) {}
  if (!gl) return;

  const sysInfo = (wx.getSystemInfoSync && wx.getSystemInfoSync()) || {};
  const dpr = sysInfo.pixelRatio || 2;
  const W = (sysInfo.windowWidth  || 400) * dpr;
  const H = (sysInfo.windowHeight || 800) * dpr;
  if (typeof c.width  === 'number' && c.width  < W) c.width  = W;
  if (typeof c.height === 'number' && c.height < H) c.height = H;

  try {
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.07, 0.09, 0.14, 1.0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const barFullW = Math.floor(W * 0.55);
    const barH = Math.max(6, Math.floor(H * 0.006));
    const barX = Math.floor((W - barFullW) / 2);
    const barY = Math.floor(H * 0.50);

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(barX, barY, barFullW, barH);
    gl.clearColor(0.18, 0.20, 0.26, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const fillW = Math.floor(barFullW * 0.40);
    gl.scissor(barX, barY, fillW, barH);
    gl.clearColor(0.35, 0.65, 1.00, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  } catch (e) {}
})();
