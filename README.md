# dsh-dashboard · 会话控制台（独立 DSH 原生插件）

DSH 插件：双模式会话控制台。**v3 起完全独立**——数据面为 DSH 宿主本身，不依赖任何外部项目（无 llama_proxy、无 localAgent 耦合）。

## 形态

- **① ⚙ 小齿轮**：DSH 窗口内右下角白色齿轮（34px，可拖、位置记忆）。单击弹窗：打开外窗 / 关闭控制台（红）/ 说明。
- **② 外窗**：透明置顶桌宠窗（独立 Electron helper 进程）：DSH 会话列表（标题实时随工作区重命名同步）/ 工具白名单（真执法）/ 清空上下文（立即压缩）。

## 数据面（全部 DSH 原生）

| 功能 | 实现 |
|---|---|
| 会话列表 | `ctx.sessionQuery.listSessions()`——DSH 会话 id 唯一，**同首消息的多会话结构性区分**（无指纹合并问题） |
| 会话标题 | `readTitleSnapshots`——与 DSH 工作区一致，重命名 ≤5s 自动同步 |
| **Token 预算** | 每会话预算（8K/20K/32K/自定义）：`agent/pre-step` 用量达阈值时自动 `compaction.compactNow`（等价于原代理记忆层阈值压缩）；当前用量实时显示（`ctx.tokenMeter.measure`） |
| 工具白名单 | `agent.ctx.tools.restrict({allow})`——作用域真执法（默认白名单 + 每会话白名单，改即生效） |
| 清空上下文 | `ctx.compaction.compactNow(agent)`——与官方 /compact 同一实现（仅活动会话；冷会话提示先打开） |

## 架构要点

- helper 自带 HTTP 服务器 `127.0.0.1:8792`（端口被占自动 +1 ×10）：serve `standalone.html`；`/api/*` 反代回 **DSH 宿主**（`/dsh-dashboard/api/*`，共享 token 校验），页面数据不经过任何第三方。
- 独立 Electron 下载：npmmirror `electron-v<宿主版本>-darwin-<arch>.zip`（SHASUMS256 校验）→ 私有目录 `~/.dsh/dsh-dashboard/electron/`（与 dsh-pet 隔离）。
- 外窗 URL 由宿主自拼（`http://127.0.0.1:<helper端口>/standalone.html`），客户端永不拼 URL。
- 生命周期：DSH 正常退出 → 宿主 dispose 钩子杀 helper；DSH 崩溃 → helper 看门狗每 3s 探测父进程（env `DSH_DASH_HOST_PID`）→ 消失即自尽；端口随进程退出释放。
- 外窗 ✕ 只关窗口、保留 helper（快速复现）；仅总开关 OFF / DSH 退出才杀进程。
- 插件状态存 `~/.dsh/dsh-dashboard/console.json`（默认白名单 + 每会话白名单）；总开关存 `master.json`。

## 总开关与设置页

- 总开关 OFF：两模式全消失 + 杀 helper；唯一开启入口 = 设置 → 控制台设置。
- 设置页（settings.section，label「控制台设置」）：总开关 + 打开外窗 + 信息区（外窗地址 / 数据源说明 / 硬关闭提示）；浅色主题深色字（主题 token）。

## 安装

`plugin_manager` → `install_bundle`，target 为本仓库目录（本地目录安装为链接式，仓库改动即时生效）；替换安装需重启 DSH。

## 归属

作者/维护者：longjincf ｜ MIT ｜ 形态借鉴 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（ALKAERR/PC2005-cloud）与 [dsh-plugins](https://github.com/Feahter/dsh-plugins)（Feahter）。
