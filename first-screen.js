// 启动期 splash: dom-shim 之后 luna 出画面要 ~3-4s, 这段不能黑屏.
//
// **设计原则 (SKILL §启动期性能 坑 3 实证)**:
//   只画 1 帧, 不 setTimeout/setInterval/RAF — 任何持续 timer 都会和 luna PC InitializeAsync
//   抢 GPU 队列, 拖慢启动 (实测 setInterval+50ms 拖 600ms+).
//
// **三步绘制**:
//   step 1 (同步): 立刻画进度条 + 深底, 用户启动即看到反馈
//   step 2 (异步, 单 onload 回调): logo 从 manifest 选 + wx.createImage 加载完后 GL 画 1 次
//   step 3 (luna 接管): luna 第一次 setSource 时 dom-shim 给 GameGlobal._splashStopped=true,
//                     之后 PC 自己每帧 clear 覆盖 splash
//
// 颜色取自原 HTML CSS (`.loading-wrapper` background:#171717, `.loading-bar-inner` rgb(78,189,210)).
(function bootSplash() {
  const g = GameGlobal;
  let c = g.canvas;
  if (!c) { try { c = g.canvas = wx.createCanvas(); } catch (e) { console.log('[first-screen] no canvas, abort'); return; } }
  let gl = null;
  try { gl = c.getContext('webgl2') || c.getContext('webgl'); } catch (e) {}
  if (!gl) { console.log('[first-screen] no gl context, abort'); return; }
  console.log('[first-screen] init canvas=' + c.width + 'x' + c.height);

  const sysInfo = (wx.getSystemInfoSync && wx.getSystemInfoSync()) || {};
  const dpr = sysInfo.pixelRatio || 2;
  const W = (sysInfo.windowWidth  || 400) * dpr;
  const H = (sysInfo.windowHeight || 800) * dpr;
  if (typeof c.width  === 'number' && c.width  < W) c.width  = W;
  if (typeof c.height === 'number' && c.height < H) c.height = H;

  // ---- step 1: 静态背景 + 进度条 (clear + scissor, 不开 image pipeline) ----
  function drawBackdropAndBar() {
    try {
      gl.viewport(0, 0, c.width, c.height);
      // 背景: #171717 ≈ (0.09, 0.09, 0.09)
      gl.clearColor(0.09, 0.09, 0.09, 1.0);
      gl.disable(gl.SCISSOR_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // 进度条 (居中, 0% → 80% 静态片段, 取 40% 为视觉中点)
      // GL scissor 坐标系: 左下角原点, Y 越大越靠上.
      // barY = H * 0.18 = 距屏幕底部 18% = 从顶部数 82% (屏幕下方靠下).
      // 之前 0.62 算反了 (62% 距底部 = 38% 从顶部 = 屏幕中上, 跟 logo 重叠).
      const barFullW = Math.floor(W * 0.50);
      const barH = Math.max(6, Math.floor(H * 0.008));
      const barX = Math.floor((W - barFullW) / 2);
      const barY = Math.floor(H * 0.18);

      gl.enable(gl.SCISSOR_TEST);
      // 进度条槽 (深灰)
      gl.scissor(barX, barY, barFullW, barH);
      gl.clearColor(0.10, 0.10, 0.10, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // 已填充部分 (品牌蓝 rgb(78,189,210) ≈ (0.306, 0.741, 0.824))
      const fillW = Math.floor(barFullW * 0.40);
      gl.scissor(barX, barY, fillW, barH);
      gl.clearColor(0.306, 0.741, 0.824, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      // 强制 GL 提交到 swap chain — 单帧 splash 不靠 RAF, 必须 flush 才能上屏 (wx 试玩 runtime 实证).
      try { gl.flush(); } catch (e) {}
    } catch (e) { console.log('[first-screen] drawBackdrop err:', e && e.message); }
  }
  drawBackdropAndBar();
  // **swap chain present**: wx 试玩 runtime 上单帧 GL.clear 不直接上屏 — backbuffer 要等 RAF 才 swap.
  // 用 1 次 RAF 触发 swap (luna PC 第一次 RAF 之前显示给用户), 不持续重绘 (setInterval 50ms 实测拖 luna 2.7s).
  // 第二个 RAF 再画一次防止首帧丢 (有些设备首 RAF 在 GL state 未稳态时触发).
  const _raf = (typeof requestAnimationFrame === 'function')
              ? requestAnimationFrame
              : (c.requestAnimationFrame ? c.requestAnimationFrame.bind(c) : null);
  if (_raf) {
    _raf(function () {
      if (g.__lunaSplashStop) return;
      drawBackdropAndBar();
      _raf(function () {
        if (g.__lunaSplashStop) return;
        drawBackdropAndBar();
      });
    });
  }
  console.log('[first-screen] backdrop+bar drawn (raf=' + !!_raf + ')');

  // ---- step 2: 异步加载 logo + GL 一次性绘制 ----
  // **manifest 加载坑**: 试玩 runtime 上 require('./x.json') 抛 module-not-defined.
  // 必须用 wx.getFileSystemManager().readFileSync 读包内 JSON 文本再 JSON.parse.
  function pickLogoEntry() {
    let manifest;
    try {
      const fs = wx.getFileSystemManager();
      const txt = fs.readFileSync('manifest.json', 'utf8');
      manifest = JSON.parse(txt);
    } catch (e) { console.log('[first-screen] manifest read err:', e && e.message); return null; }
    if (!manifest || !manifest.loadingLogos) { console.log('[first-screen] manifest no loadingLogos'); return null; }
    const sys = (wx.getSystemInfoSync && wx.getSystemInfoSync()) || {};
    const lang = sys.language || 'zh_CN';
    const norm = lang.replace('_', '-');
    return manifest.loadingLogos[norm]
        || manifest.loadingLogos[lang]
        || manifest.loadingLogos['zh-CN']
        || manifest.loadingLogos[Object.keys(manifest.loadingLogos)[0]];
  }

  function drawLogoImage(img) {
    if (!img) { console.log('[first-screen] logo: no img'); return; }
    // 注: luna 接管信号是 GameGlobal.__lunaSplashStop (wx-ad-bridge 在 setSource#1 时设),
    // 但 logo 加载常在 setSource#1 之前就 onload, 所以这里允许画一次 (即便 stop 已设).
    if (g.__lunaSplashStop) { console.log('[first-screen] logo: already stopped, skip'); return; }
    try {
      // 极简纹理 quad shader
      const vsrc = 'attribute vec2 p; attribute vec2 t; varying vec2 vt;' +
                   'void main(){vt=t;gl_Position=vec4(p,0.0,1.0);}';
      const fsrc = 'precision mediump float; varying vec2 vt; uniform sampler2D s;' +
                   'void main(){gl_FragColor=texture2D(s,vt);}';
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vsrc); gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fsrc); gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);

      // logo 居中, 50% 屏宽 (跟原 CSS portrait .loading-logo:width 50vw 一致)
      const imgW = img.width || 512;
      const imgH = img.height || 512;
      const targetW = W * 0.50;
      const targetH = targetW * (imgH / imgW);
      const ndcHalfW = targetW / W;          // clip space 半宽
      const ndcHalfH = targetH / H;          // clip space 半高
      const cx = 0;                          // 水平居中
      const cy = 0.10;                       // 略高于中线 (屏幕约 45% 处, 给进度条留下方空间)

      const verts = new Float32Array([
        cx - ndcHalfW, cy - ndcHalfH, 0, 1,
        cx + ndcHalfW, cy - ndcHalfH, 1, 1,
        cx - ndcHalfW, cy + ndcHalfH, 0, 0,
        cx + ndcHalfW, cy + ndcHalfH, 1, 0,
      ]);
      const vbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      const pLoc = gl.getAttribLocation(prog, 'p');
      const tLoc = gl.getAttribLocation(prog, 't');
      gl.enableVertexAttribArray(pLoc);
      gl.enableVertexAttribArray(tLoc);
      gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(tLoc, 2, gl.FLOAT, false, 16, 8);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.uniform1i(gl.getUniformLocation(prog, 's'), 0);

      // alpha blend (PNG 可能有透明度)
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // 重画背景 + 进度条作底, 再画 logo (避免 GL 状态切换后底层丢)
      drawBackdropAndBar();
      function paintLogoOnce() {
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        try { gl.flush(); } catch (e) {}
      }
      paintLogoOnce();
      gl.disable(gl.BLEND);
      console.log('[first-screen] logo drawn ' + img.width + 'x' + img.height);

      // **不要 RAF loop**: 跟 luna PC 共享 GL ctx, 持续画会污染 luna 渲染状态导致黑方块.
      // 单帧画 + 1 次 RAF 触发 swap chain present, 然后绝对不再碰 GL.
      const _rafLogo = (typeof requestAnimationFrame === 'function')
                     ? requestAnimationFrame
                     : (c.requestAnimationFrame ? c.requestAnimationFrame.bind(c) : null);
      if (_rafLogo) {
        _rafLogo(function () {
          if (g.__lunaSplashStop) return;
          // RAF 同步重画一次让首帧 logo 真上屏
          drawBackdropAndBar();
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          paintLogoOnce();
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        });
      }
    } catch (e) {
      console.log('[first-screen] drawLogo err:', e && e.message);
    }
  }

  try {
    const entry = pickLogoEntry();
    if (!entry) { console.log('[first-screen] no logo entry in manifest'); return; }
    console.log('[first-screen] logo entry:', entry.rel);
    if (entry && wx.createImage) {
      const img = wx.createImage();
      img.onload = function () { drawLogoImage(img); };
      img.onerror = function (e) { console.log('[first-screen] logo onerror:', JSON.stringify(e)); };
      img.src = entry.rel;
    } else {
      console.log('[first-screen] wx.createImage missing');
    }
  } catch (e) { console.log('[first-screen] logo load err:', e && e.message); }
})();
