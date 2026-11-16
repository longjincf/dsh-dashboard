# dsh-dashboard · 会话控制台

DSH 插件：双模式会话控制台，直连 [llama_proxy](http://192.168.0.71:8080) 的 `/admin/*` 控制面。

## 形态

- **① ⚙ 小齿轮**：DSH 窗口内右下角白色齿轮（34px，可拖、位置记忆）。单击弹窗：打开外窗 / 关闭控制台（红）/ 说明。
- **② 外窗**：透明置顶桌宠窗（独立 Electron helper 进程）：会话列表（DSH 会话标题）/ 预算滑块 + 8K/20K/32K 预设 / 工具白名单（默认折叠）/ 清空上下文（二次确认）/ 默认模式（默认折叠）。

## 总开关与设置页

- 总开关 OFF：两模式全消失 + 杀 helper；**唯一开启入口 = 设置 → 控制台设置**。
- 设置页（settings.section，label「控制台设置」）：总开关 + 打开外窗 + 信息区（控制面地址 / 轮询间隔 / 硬关闭提示）；浅色主题用深色字（主题 token）。

## 架构要点

- helper 自带 HTTP 服务器 `127.0.0.1:8792`（端口被占自动 +1 ×10）：serve `standalone.html` + `/api/*` 反代 llama_proxy `/admin/*`（不依赖 DSH webServer）。
- 独立 Electron 下载：npmmirror `electron-v<宿主版本>-darwin-<arch>.zip`（SHASUMS256 校验）→ **私有目录 `~/.dsh/dsh-dashboard/electron/`**（与 dsh-pet 的 `~/.dsh/electron` 隔离，避免版本互盖）。
- 外窗 URL 由宿主自拼（`http://127.0.0.1:<helper端口>/standalone.html`），客户端永不拼 URL。
- 生命周期：DSH 正常退出 → 宿主 dispose 钩子杀 helper；DSH 崩溃 → helper 看门狗每 3s 探测父进程（env `DSH_DASH_HOST_PID`）→ 消失即自尽；端口随进程退出释放。
- 外窗 ✕ 只关窗口、保留 helper（快速复现）；仅总开关 OFF / DSH 退出才杀进程。

## 会话标题映射（全链路）

- 代理为新会话播种 `first_user`（首条用户消息前 30 字）；
- DSH 重命名会话 → title-gen 请求被代理捕获 → 新标题写入 `__titles__`；
- 宿主轮询补写：DSH 标题 ≠ 代理标题时 `POST /admin/titles`（代理拒收恒等映射），代理无该会话时 `POST /admin/backfill` 兜底；
- 显示回退链：`__titles__[first_user]` → `first_user` → conv 指纹。

## 安装

手工 profile 安装（当前 profile：`~/.dsh/profiles/desktop`）：

1. `node_modules/dsh-dashboard` 链接到本仓库目录；
2. `package.json` 的 `dsh.profile.bundles` 加入 `dsh-dashboard`；
3. `cordis.patch.yml` 插入干净行（adminBase / pollMs / enabled）。

首次安装 HMR 生效；替换安装需重启 DSH。

## 归属

作者/维护者：longjincf ｜ MIT ｜ 形态借鉴 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（ALKAERR/PC2005-cloud）与 [dsh-plugins](https://github.com/Feahter/dsh-plugins)（Feahter）。

> 本文档是对 02.0.5 执行提示词副本的勘误版：外窗 URL 由宿主自拼时使用 **helper 实际端口**（而非 `webServer.port`，那是历史迭代的旧拼法，勿照抄）。
