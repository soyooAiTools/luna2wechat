# luna2wechat

把 Unity + Luna 导出的 web playable，搬到 **微信试玩广告 runtime**（`playable-libs 2.0.15`）的实操资产库。配套 skill 文档：[`SKILL.md`](./SKILL.md)。

## 仓库结构

```
luna2wechat/
├── SKILL.md                          # 完整方法论 + 错误解码表（Skill 加载入口）
├── README.md                         # 本文件
├── luna-to-wx/                       # 注入到 Luna 项目的桥接层
│   ├── dom-shim.js                   # DOM/Audio/Event/WASM shim（v18 工作版）
│   ├── asset-inject.js               # Luna 资源喂入器
│   └── wx-ad-bridge.js               # wx.onShow/onHide → Luna lifecycle
├── snapshots/                        # 关键状态快照（回归 baseline）
│   ├── dom-shim.may2-12-48.snapshot  # 5/2 出画面 baseline (44KB)
│   ├── dom-shim.v18-may4.snapshot    # 5/4 v18 完整版 (54KB)
│   └── dom-shim.may4-broken.js       # 反面教材：26 次错链尾端 patch (83KB)
├── tools/
│   ├── extract-wasm.cjs              # 从 Luna chunk 抠 \x00asm magic 出 .wasm
│   └── decode-wasm.cjs               # WASM 头部解析辅助
└── deploy/
    ├── preview-v18.ps1               # schtasks 异步预览 wrapper
    └── upload-v18.ps1                # schtasks 异步上传 wrapper
```

## v18 当前状态（2026-05-04）

`luna-to-wx/dom-shim.js` = `snapshots/dom-shim.v18-may4.snapshot` (md5 `9d3edd7d…`)

**已纳入：**
- WASM 双载（Box2D + Mecanim）unpatch-before-call
- main-require-order JSON → .js + 取消 `wx.loadSubpackage` 全部入主包
- vConsole 强开 + HTTP probe via `Image GET` 绕 wx 域名白名单
- 5/2 baseline + LifeCycle/Analytics/Playable 占位 + Event/Mouse/Wheel/Touch shim
- `g.Audio = AudioShim` + AudioContextShim + ImageShim/VideoShim
- **globalThis 镜像** —— 把 17 个构造器同步到 `globalThis`（eval'd 代码裸标识符走 globalThis 解析，仅 `GameGlobal` 不够）
- **轮盘 keepalive 注入** —— `_setUITouchState` + `forceGetter` Bridge.NET Touch struct + `_instrumentUIRead` 三路短路（`touches`/`touchCount`/`GetTouch`）+ 16ms `setInterval` keepalive + `endedTickCount` 释放序列

**剩余硬墙：**
1. **Preview/Upload CLI fork 阶段超时** —— 微信开发者工具 IDE 守护进程 fork 子进程不起来，`Stop-Process` 全杀重启同样错。备用方案见 `project_luna2wechat_preview_fork_timeout` memory（清缓存 / 升级 / IDE GUI / 重装）。
2. **真机视觉验证未完成** —— v18 已部署 `wx-build:luna-wx-mg/luna-to-wx/dom-shim.js`，但因 #1 没拿到新二维码，画面/轮盘/音频实机验证未做。
3. **`wx-ad-bridge` addEventListener 链** —— DOM 子对象 (documentElement/body/head/canvas) 缺 `addEventListener`，文件已改但需要 v18 build 上去验。

## 关键里程碑时间线

| 日期 | 状态 | 快照 |
|---|---|---|
| 2026-05-02 12:48 | ✅ 出画面 ×6 "进游戏了" | `dom-shim.may2-12-48.snapshot` |
| 2026-05-03 02:36 | ✅ 触控+音频 最后一次工作状态 | (baseline + 23 edits) |
| 2026-05-03 末 | ❌ 黑屏回归（26 次错链尾端 patch） | `dom-shim.may4-broken.js` |
| 2026-05-04 v17 | ✅ 回退 baseline + 3 minimal patch 出画面但轮盘+声音失效 | (baseline + 3 patch) |
| 2026-05-04 v18 | ✅ +globalThis 镜像 +轮盘 keepalive（未真机验） | `dom-shim.v18-may4.snapshot` |

详细事件链与教训见 `SKILL.md` 的"黑屏回归调试纪律"小节。

## 部署/预览循环

测试机：Windows tailscale 主机名 `wx-build`，AppID `wx21647eaf197e9b58`，工程路径 `C:\Users\Nick\luna-wx-mg`。

### 标准 preview 循环（IDE GUI 已启动时优先用）

```bash
# 1. 同步 dom-shim 到测试机
scp luna-to-wx/dom-shim.js wx-build:C:/Users/Nick/luna-wx-mg/luna-to-wx/dom-shim.js

# 2. 跑预览（schtasks 异步绕 ssh 阻塞）
ssh wx-build 'powershell -File C:\Users\Nick\preview-v18.ps1'

# 3. 拉二维码
scp wx-build:C:/Users/Nick/preview-qr-v18.png /tmp/preview-qr-v18.png
```

### upload 体验版（preview fork timeout 时备选）

`deploy/upload-v18.ps1` 同样 schtasks 包装 `cli.bat upload --project ... -v vXX -d desc -i info.json`。完成后从微信公众平台后台拿体验版二维码（cli 不直接出）。

详细命令、登录续期、常见错误见 `SKILL.md` 的"部署/预览循环"。

## 工作流原则

1. **先回到能 run 的最近 baseline** 再叠加 patch，每加一项验画面没坏
2. **错误链尾端 patch 多半不是真根因**——element.load 报错往往是更早 init 路径副作用
3. **黑屏第一时间走 git/snapshot diff**，比顺 stack trace 高效得多
4. **找到根因后剪掉 workaround**，专用 hack 不剪会变考古遗迹
5. **修完根因立刻 commit + push**，不要让工作目录单独承载修复

## 相关 memory（在 `/root/.claude/projects/-/memory/`）

- `project_luna2wechat_status.md` — 当前进度
- `project_luna2wechat_milestones.md` — 完整时间线
- `project_luna2wechat_dom_shim_regression.md` — 5/2 → 5/4 回归调试史
- `project_luna2wechat_touch_clone_fix.md` — Bridge.NET struct 修复
- `project_luna2wechat_audio_decision.md` — 音频桥接决策
- `project_luna2wechat_preview_fork_timeout.md` — fork timeout 备用方案
- `project_luna2wechat_autonomous_test_scope.md` — 自动手机测试边界
- `project_wx_playable_runtime_constraints.md` — playable-libs 2.0.15 阉割面
- `feedback_jsonl_session_recovery.md` — 用 sub-agent 解 JSONL 还原丢失代码
- `reference_luna2wechat_repo.md` — 本仓库归属
