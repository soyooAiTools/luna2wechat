// HTTP probe: dual-channel console redirect for wx 试玩 runtime
//
// 用法: 在 game.js 顶部 require('./luna-to-wx/http-probe.js') 作为第一行。
// 把 console.log/warn/error/info 都接管, 通过 wx.createImage().src 同时打到:
//   1. LAN probe (PROBE_HOST): in-LAN 设备走这条, 无 rate limit, 走 wx-build:53117
//   2. 公网 HTTPS probe (PROBE_PUBLIC): 不在 LAN 的 iPhone (iOS 高版本经常不在 LAN) 兜底用,
//      推荐 webhook.site 一次性 token 或自建 nginx + Let's Encrypt
//
// 必要性: 试玩 runtime 没 vConsole UI, wx.request 受白名单+throwing stub, 唯一可发出去的通道
// 是 wx.createImage().src (Image transport, 无白名单, fire-and-forget)。
// dom-shim 后段也 silence 了 wx.request stub, 不会污染日志。
//
// 配置: 改下面两个常量为你的 probe endpoint。
//   - PROBE_HOST: LAN IPv4 + 端口, 不要用 Tailscale 100.x (手机不在 tailnet)
//   - PROBE_PUBLIC: HTTPS endpoint, 如 https://webhook.site/<uuid>; 设为 '' 关闭公网通道
//
// 启动期 burst 实测: 5 行/20ms = 250/秒, 在 LAN 没问题; webhook.site 免费版会丢超过 50/min 的;
// 自建 endpoint 没此限。

(function attachHttpProbe() {
  try {
    var PROBE_HOST = '192.168.1.3:53117';
    var PROBE_PUBLIC = '';  // 例: 'https://webhook.site/<your-uuid>' 或自建; '' = 不发公网
    var _origLog  = console.log  ? console.log.bind(console)  : function(){};
    var _origWarn = console.warn ? console.warn.bind(console) : _origLog;
    var _origErr  = console.error? console.error.bind(console): _origLog;
    var _origInfo = console.info ? console.info.bind(console) : _origLog;
    var _spamPatterns = [/escapeGuideCount/, /Skipping event sample/, /^\[XXAUDIO\] gain#/];
    var _buf = [];
    var _seq = 0;
    function fireOne(line) {
      _seq++;
      var enc = encodeURIComponent(line.slice(0, 1500));
      // LAN probe (LAN 设备主路, 无 rate limit)
      try {
        var img1 = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage() : null;
        if (img1) img1.src = 'http://' + PROBE_HOST + '/log?m=' + enc;
      } catch (e) {}
      // 公网 probe (off-LAN 设备兜底; webhook.site 等)
      if (PROBE_PUBLIC) {
        try {
          var img2 = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage() : null;
          if (img2) img2.src = PROBE_PUBLIC + '?seq=' + _seq + '&m=' + enc;
        } catch (e) {}
      }
    }
    setInterval(function () { var n = 5; while (n-- > 0 && _buf.length > 0) fireOne(_buf.shift()); }, 20);
    function fmt(args) {
      try {
        return Array.prototype.map.call(args, function (a) {
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
        var msg = '[' + level + '] ' + fmt(args);
        for (var i = 0; i < _spamPatterns.length; i++) { if (_spamPatterns[i].test(msg)) return; }
        if (_buf.length < 10000) _buf.push(msg);
      } catch (e) {}
    }
    console.log   = function () { send('L', arguments); _origLog.apply(null, arguments); };
    console.warn  = function () { send('W', arguments); _origWarn.apply(null, arguments); };
    console.error = function () { send('E', arguments); _origErr.apply(null, arguments); };
    console.info  = function () { send('I', arguments); _origInfo.apply(null, arguments); };
    // 全局 onerror / unhandledrejection: iOS 上早期 promise reject 经常是黑屏根因
    try {
      if (typeof GameGlobal !== 'undefined' && GameGlobal.addEventListener) {
        GameGlobal.addEventListener('error', function (e) {
          send('UNCAUGHT', ['onerror', e && e.message, (e && e.error && e.error.stack) || '']);
        });
        GameGlobal.addEventListener('unhandledrejection', function (e) {
          send('REJECT', ['unhandledrejection', e && e.reason && (e.reason.message || e.reason), (e && e.reason && e.reason.stack) || '']);
        });
      }
    } catch (e) {}
    try { if (typeof wx !== 'undefined' && wx.onError) wx.onError(function (msg) { send('WX_ERR', [msg]); }); } catch (e) {}
    try { if (typeof wx !== 'undefined' && wx.onUnhandledRejection) wx.onUnhandledRejection(function (r) { send('WX_REJECT', [r && r.reason]); }); } catch (e) {}
    console.log('[probe] HTTP probe attached → LAN=' + PROBE_HOST + ' public=' + (PROBE_PUBLIC || 'OFF') + ' (boot ' + new Date().toISOString() + ')');
  } catch (e) {
    try { console.error('[probe] attach failed:', e && e.message); } catch (_) {}
  }
})();
