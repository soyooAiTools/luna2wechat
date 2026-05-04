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
│   ├── dom-shim.may2-12-48.snapshot                # 5/2 出画面 baseline (44KB)
│   ├── dom-shim.v18-may4.snapshot                  # 5/4 v18 globalThis+轮盘 (54KB)
│   ├── dom-shim.v19c-may4-pure-b64.snapshot        # 5/4 音频跑通 (62KB)
│   ├── dom-shim.v19d-may4-mixwithother.snapshot    # 5/4 BGM 不被 SFX 抢断
│   ├── dom-shim.v19e-may4-gain-trace.snapshot      # 5/4 BGM 持续 ✅ 终态
│   └── dom-shim.may4-broken.js                     # 反面教材：26 次错链尾端 patch
├── tools/
│   ├── extract-wasm.cjs              # 从 Luna chunk 抠 \x00asm magic 出 .wasm
│   └── decode-wasm.cjs               # WASM 头部解析辅助
└── deploy/
    ├── preview-v18.ps1               # schtasks 异步预览 wrapper
    └── upload-v18.ps1                # schtasks 异步上传 wrapper
```

## v19e 当前状态（2026-05-04）— ✅ DC Dark Legion 真机全跑通

`luna-to-wx/dom-shim.js` = `snapshots/dom-shim.v19e-may4-gain-trace.snapshot`

真机验证：**画面 / 轮盘 / 松手停 / 声音 / BGM 持续** 5/5 PASS。

**v19 系列累加（基于 v18）：**
- **v19c** — `wx.createInnerAudioContext` 真桥接 + 纯 JS base64 编码器（playable-libs 的 `wx.arrayBufferToBase64` 是空 stub 返回 ArrayBuffer 自身，data URI 失效）
- **v19d** — `wx.setInnerAudioOption({mixWithOther: true, obeyMuteSwitch: false})`（iOS 默认 InnerAudioContext 互斥，BGM 听到第一个 SFX 就死）
- **v19e** — gain 链改成实时联动 `_inner.volume`，并跟踪所有挂载的 source（PlayCanvas fade 期 gain 一度为 0，原本 start 一次性读音量后锁死 → BGM 重启 vol=0 死寂）；`source.loop` 改 setter 支持 late-set

**v18 累加（基于 baseline）：**
- WASM 双载（Box2D + Mecanim）unpatch-before-call
- main-require-order JSON → .js + 取消 `wx.loadSubpackage` 全部入主包
- vConsole 强开 + HTTP probe via `Image GET` 绕 wx 域名白名单
- 5/2 baseline + LifeCycle/Analytics/Playable 占位 + Event/Mouse/Wheel/Touch shim
- `g.Audio = AudioShim` + AudioContextShim + ImageShim/VideoShim
- **globalThis 镜像** — 17 个构造器同步到 `globalThis`（eval'd 代码裸标识符走 globalThis 解析）
- **轮盘 keepalive 注入** — `_setUITouchState` + `forceGetter` Bridge.NET Touch struct + `_instrumentUIRead` 三路短路 + 16ms keepalive + 3-tick endedTickCount 释放

## 关键里程碑时间线

| 日期 | 状态 | 快照 |
|---|---|---|
| 2026-05-02 12:48 | ✅ 出画面 ×6 "进游戏了" | `dom-shim.may2-12-48.snapshot` |
| 2026-05-03 02:36 | ✅ 触控+音频 最后一次工作状态 | (baseline + 23 edits) |
| 2026-05-03 末 | ❌ 黑屏回归（26 次错链尾端 patch） | `dom-shim.may4-broken.js` |
| 2026-05-04 v17 | ✅ 回退 baseline + 3 minimal patch 出画面但轮盘+声音失效 | (baseline + 3 patch) |
| 2026-05-04 v18 | ✅ +globalThis 镜像 +轮盘 keepalive（真机 4/5 通过：声音失败） | `dom-shim.v18-may4.snapshot` |
| 2026-05-04 v19c | ✅ 真桥接 wx.createInnerAudioContext + 纯 JS base64（声音 ✅，BGM 第一次点击后失） | `dom-shim.v19c-may4-pure-b64.snapshot` |
| 2026-05-04 v19d | ✅ +setInnerAudioOption mixWithOther（BGM 出但片段后又消失） | `dom-shim.v19d-may4-mixwithother.snapshot` |
| 2026-05-04 v19e | ✅ +gain 链实时联动 + late-loop 传播（BGM 持续 ✅ 终态） | `dom-shim.v19e-may4-gain-trace.snapshot` |

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
