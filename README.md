# dsh-dashboard · DeepSeek Harness 会话控制台插件

本地 AI 会话的实时控制面：**按会话动态调节上下文预算、工具白名单、清空上下文**，并为新会话/子 agent 设定**默认模式**（思考档位 / 最大上下文 / 工具白名单）。支持 DSH 内嵌浮窗与**透明置顶桌宠窗**两种形态。

## 归属与许可

- **作者/维护者**：longjincf（[longjincf](https://github.com/longjincf)）
- **仓库**：https://github.com/longjincf/dsh-dashboard
- **协议**：MIT（见 [LICENSE](./LICENSE)）
- 本插件是 longjincf 的"本地 AI 部署"系列（02 系列，设计文档见 [localAgent-learing](https://github.com/longjincf/localAgent-learing) 仓库 `docs/02.0.1/02.0.2`）的组成部分。

## 借鉴与致谢

- 插件 bundle 形态（package.json + cordis.patch.yml + 宿主/客户端两半、`__ModuleLoader__` 零构建）与 **desktop-helper 独立 Electron 进程机制**：借鉴 [ALKAERR/dsh-pet](https://github.com/ALKAERR/dsh-pet)（鲸鱼娘女仆长）与 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)；
- 插件市场索引格式（format-1 index.json）：参照 [Feahter/dsh-plugins](https://github.com/Feahter/dsh-plugins)。
- 以上项目均为 MIT 开源，本仓库在形态与机制上的借鉴已在代码注释与设计文档中注明。

## 功能

| 能力 | 说明 |
|---|---|
| 上下文预算（动态） | 每个会话独立 token 预算（1K~32K），下一轮请求即生效 |
| 工具白名单（动态） | 按会话过滤发给模型的 tools 数组，改动即生效 |
| 清空上下文 | 一键清（摘要缓存/归档/预算状态归位），二次确认 |
| 默认模式 | 新会话/子 agent 自动继承：思考档位 / 预算 / 白名单 |
| 内嵌浮窗 | DSH Web UI 内可拖拽浮窗（默认右上角胶囊，单击开外窗，双击展开） |
| 透明置顶桌宠窗 | 独立 Electron 窗（transparent/frameless/alwaysOnTop，位置记忆，独立下载 Electron） |

## 依赖（前置）

本插件是控制面，数据面在 **llama_proxy 的 /admin API**（本地 llama.cpp 常驻代理，含记忆压缩/采样守卫/事实注入）。代理代码与部署说明见 [localAgent-learing/scripts/llama_proxy.py](https://github.com/longjincf/localAgent-learing/blob/main/scripts/llama_proxy.py)。

默认控制面地址：`http://192.168.0.71:8080`（可在 cordis.patch.yml 的 `config.adminBase` 修改）。

## 安装

```bash
# 方式 A：本地链接开发
dsh plugin --profile <profile> add link:<本仓库绝对路径>
# 方式 B：GitHub 直装
dsh plugin --profile <profile> add github:longjincf/dsh-dashboard
```

装完重启 `dsh web`（桌面端重启应用）并刷新页面。

## 配置（cordis.patch.yml 内 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `adminBase` | `http://192.168.0.71:8080` | llama_proxy /admin 控制面 |
| `pollMs` | `5000` | 前端轮询间隔（毫秒） |
| `enabled` | `true` | 总开关（设置→插件 也可开关） |

## 架构

```
DSH 插件（宿主）                      控制面
├─ 内嵌浮窗（client/client.js，shell.overlay 槽）
├─ 设置页（settings.section 槽："会话控制台"）
├─ 路由中继 /dsh-dashboard/* → llama_proxy /admin/*
└─ 桌宠窗 helper（独立进程，低耦合）：
     ├─ Electron 独立下载（npmmirror → ~/.dsh/electron，一次下载复用）
     ├─ 自带 HTTP 服务器（127.0.0.1:8792，端口占满自动换口）
     ├─ 直连 llama_proxy /admin（不依赖 DSH webServer）
     └─ BrowserWindow：transparent/frame:false/alwaysOnTop/位置记忆
```

## 目录

```
dsh-dashboard/
├── package.json          # DSH bundle 元数据（dsh.bundle/dsh.client）
├── cordis.patch.yml      # 挂载声明 + config
├── lib/index.js          # 宿主：中继路由 / Electron 下载与拉起 / 清理旧实例
├── client/
│   ├── client.js         # 内嵌浮窗（React，__ModuleLoader__ 零构建）
│   └── standalone.html   # 独立页（桌宠窗加载，原生 JS）
└── runtime/helper/       # 桌宠窗独立进程（main.js/preload.js/页面副本）
```
