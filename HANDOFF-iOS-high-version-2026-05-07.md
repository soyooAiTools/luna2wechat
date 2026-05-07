# iOS 高版本黑屏调试 HANDOFF — 2026-05-07

## 当前状态（已完成）

3 个根因已定位 + 修复，**LAN-connected iOS 18.7.8 设备 v4 后 scene._renderers=428 / MIs=501，跟 Android 几乎一致，frame loop 在跑**：

| 根因 | 修复 | 影响 |
|------|------|------|
| `_wasmFiles[168336]` 缺映射 | dom-shim.js 加 `168336: 'box2d.wasm.br'` 双映射 | iOS 高版本不再 Aborted |
| 缺 web globals (CustomEvent/EventTarget/URL/Blob/FormData/queueMicrotask) | dom-shim.js 顶部加 polyfill + 同步进 `_mirror` 数组 mirror 到 globalThis | luna scene init `new CustomEvent()` 不再 ReferenceError |
| 单 LAN probe 抓不到 off-LAN iOS | 加 webhook.site 公网兜底 + globals-dump 探针 | iOS 26.2 / 任意网络都能拿日志 |

源码已 commit + push 到 `soyooAiTools/luna2wechat`。

## 待验证（用户操作）

**v5 QR 已生成**（关掉 `wx.setEnableDebug` + 所有 v4 polyfill），等用户用 iOS 18.7.8 (高版本) 扫一次：
- 出画面 → 根因 = vConsole / setEnableDebug 跟 wx canvas surface 在 iOS 高版本抢合成
- 还黑屏 → 进入下一阶段排查（见下方）

## 当前矛盾

iOS 18.7.8 的 LAN 273 行日志显示：
- ✅ scene._renderers = **428** (Android 425)
- ✅ MIs = **501** (Android 498)
- ✅ frame loop 在跑（escapeGuideCount 每帧 spam）
- ✅ canvas touchend 用户已点 1 次
- ❌ 用户屏幕**实际显示黑屏**

→ luna 在画但 wx canvas surface 没把 backbuffer 提交到屏幕。

## 下一 session 排查方向

### 假设 1：vConsole / setEnableDebug 抢合成（v5 测试中）

`game.js` 顶部的 `wx.setEnableDebug({enableDebug:true})` 已被注释。等用户 iOS 18.7.8 扫 v5 QR 结果。

### 假设 2：wx canvas surface 在 iOS 18.7.8 + WeChat 8.0.72 已知 bug

如果 v5 还黑屏，需要：
- 在 dom-shim 加 GL state probe（每秒检查 `gl.getError()` / `gl.getParameter(gl.FRAMEBUFFER_BINDING)`，确认 luna PC 在 default framebuffer 渲染而不是某个 RenderTarget）
- 加 `gl.flush()` + `gl.finish()` 强制提交，看是否触发 surface 显示
- 微信社区提 issue 反馈 iOS 18.7.8 + WeChat 8.0.72 + playable-libs 2.0.15 + 高分辨率 canvas (1242×2688) 黑屏

### 假设 3：canvas size / dpr 错位（低概率）

iOS canvas 1242×2688 css=414×896 dpr=3。Android 1316×2835 css=400×862 dpr=3.29。物理像素都正确，但 wx 试玩在 iOS 高版本可能要 **css 像素**而非物理像素作为后备 buffer 尺寸。试 `g.canvas.width = w` 而不是 `w * dpr` 看是否出画面。

### 假设 4：iOS 端 first-screen.js 跟 luna 抢 GL ctx

LAN log 显示 `[first-screen] skeleton — Phase 2 to implement` —— first-screen 没真画。但 first-screen.js 启动时 `getContext('webgl')` 可能 acquire ctx 让 luna PC 第二次 getContext 拿不到（Android 上 getContext 重复调返回同一 ctx，iOS 可能不一致）。试在 first-screen 完全跳过 getContext 调用看是否好转。

## wx-build 上的状态

- **probe server 53117** 在跑 (schtasks `ProbeServer53117`，PID 17168)，listen 0.0.0.0:53117，写日志到 `C:\Users\Nick\probe-53117.log`
- **公网 webhook UUID**: `5c59d878-0d27-4083-8670-df2000bdc686`，view URL `https://webhook.site/#!/view/5c59d878-0d27-4083-8670-df2000bdc686`（**24 小时后可能过期**，需要重建）
- **luna-wx-test 工程** appId 已恢复到试玩 `wx21647eaf197e9b58`，`luna-wx-debug` 副本（小游戏 appId `wxd87d1823bc3810ae` + 砍到 518 KB）保留备用
- **Apple Mobile Device Support 19.4.0.10** 已装在 wx-build (USB iPhone 调试用，但发现普通小游戏 iOS USB 选项灰色 = 多端应用专属，**该路径走不通**)
- **Microsoft Store iTunes 已卸载**（之前会清理标准 AMDS）
- **微信开发者工具登录态** 当前 OK（cli `islogin = true`）

## v5 QR 复测步骤

```bash
# 在你侧
ssh wx-build 'cmd /c "del C:\Users\Nick\probe-53117.log 2>nul & C:\Users\Nick\wxcli.bat preview --project C:/Users/Nick/luna-wx-test --qr-format image --qr-output C:/Users/Nick/preview.png"'
scp wx-build:C:/Users/Nick/preview.png /tmp/preview.png
# Read tool 看 QR

# iOS 18.7.8 扫码后
scp wx-build:C:/Users/Nick/probe-53117.log /tmp/probe.log
# 或 webhook.site
curl -s 'https://webhook.site/token/5c59d878-0d27-4083-8670-df2000bdc686/requests?per_page=100&sorting=newest'
```

## 关键文件

| 路径 | 作用 |
|------|------|
| `/tmp/luna2wechat-repo/luna-to-wx/dom-shim.js` | skill 源（已合并修复） |
| `/tmp/luna2wechat-repo/luna-to-wx/http-probe.js` | 新文件，dual-channel 模板 |
| `~/.claude/skills/luna2wechat/luna-to-wx/dom-shim.js` | skill 本地副本（commit 后同步） |
| `wx-build:C:/Users/Nick/luna-wx-test/` | 用 cli preview 的工程，含 v4 patches + http-probe |

## 已知物理边界

- **HTTP probe 在 iOS 试玩 runtime 用 `wx.createImage`，启动期 burst 250/秒**
- **webhook.site 免费版限 50 条/token** —— 启动期前 50 条到 WASM 加载就被截，看不到 scene init 之后
- **wx 试玩广告 runtime 没 vConsole UI**，dom-shim console wrap 是真机日志唯一通道
- **微信开发者工具 真机调试 2.0** 不支持试玩广告项目类型（普通小游戏 + iOS 也只走 USB 多端应用通道，灰色不可选）

参考 memory：
- `[iOS 高版本 brotli box2d 多 2 字节](project_ios_brotli_168336_2026-05-07.md)`
- `[iOS 18 + WeChat 8.0.72 web globals 缺失](project_ios_18_web_globals_missing_2026-05-07.md)`
- `[HTTP probe 双通道 LAN+公网](project_http_probe_dual_channel_2026-05-07.md)`
- `[先 globals-dump 后补 polyfill](feedback_globals_dump_diagnostic.md)`
