# dsh-dashboard · 重做执行提示词（02.0.5）

> 本文件是新会话/新 agent 的唯一执行依据。**不要参考 `wasted` 分支的实现细节**——它是历史迭代存档（机制已通、代码脏乱，含大量调试补丁）。
> 从本文件 + localAgent-learing/docs/02.0.4 出发，**从零干净实现**。

## 0. 分支说明

| 分支 | 内容 | 规则 |
|---|---|---|
| `main` | 空基线（仅本文件） | 从零实现，最终代码落这里 |
| `wasted` | 历史全部迭代（功能均通但代码脏） | 只作存档，**禁止照抄/沿用其结构** |

## 1. A机（192.168.0.71）状况

- **网络**：宿舍 3F 网段；Mac 必须与它同网（2F 网段连不到）。断连先 ping。
- **SSH**：`ssh longjincf@192.168.0.71`（密钥认证）。助手脚本 `<workspace>/ssh071 '<命令>'`（sudo 用 `-s`；**sudo 密码在脚本内，禁止提交仓库**）。
- **硬件**：RX 9070 GRE 12GB（ROCm）、12 核、39GB 内存。
- **模型**：Qwen3-14B，`llama-server`（127.0.0.1:8081，systemd user 服务 `llama-server.service`）。
- **llama_proxy**（0.0.0.0:8080 → 8081）：记忆层（THRESHOLD_TOKENS=20000 / SINGLE_MSG_TOKENS=8000 / KEEP_TURNS=3）、采样守卫、思考守卫、runtime-facts 注入、`/admin/*` 控制面、状态 `~longjincf/amdGPU/memory/sessions.json`。
- 重启：`export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart llama-proxy`。
- 代理源文件：`localAgent-learing/scripts/llama_proxy.py`。

## 2. 插件最终设计（以 02.0.4 为准，此处为已实证要点）

### 2.1 双模式
- **⚙ 小齿轮**：DSH 内右下角白色齿轮（34px，可拖、位置记忆）。单击弹窗：**打开外窗 / 关闭控制台（红）/ 说明**。
- **外窗**：透明置顶桌宠窗（Electron helper 独立进程），完整控制面（会话列表/预算/白名单/清空/默认模式，白名单与默认模式**默认折叠**）。

### 2.2 总开关与设置页
- 总开关 OFF：两模式全消失 + 杀 helper；**唯一开启入口 = 设置 → 控制台设置**。
- 设置页（settings.section，label "控制台设置"）：总开关 + 打开外窗 + 信息区；**浅色主题用深色字**。

### 2.3 外窗（helper）架构
- 独立 Electron 下载：npmmirror `electron-v<宿主版本>-darwin-<arch>.zip` → `~/.dsh/electron`。
- helper 自带 HTTP 服务器 `127.0.0.1:8792`（端口被占自动 +1 ×10）：serve 页面 + 直连 llama_proxy `/admin/*`（**不依赖 DSH webServer**）。
- BrowserWindow：transparent / frame:false / alwaysOnTop('screen-saver') / skipTaskbar / 位置记忆（`~/.dsh/dsh-dashboard/window-state.json`）。

### 2.4 必须遵守的坑
1. **`ELECTRON_RUN_AS_NODE=1`** 会被 DSH 运行时注入环境——spawn helper 前必须 `delete`，否则 helper 纯 Node 启动秒崩；
2. DSH 页面跑在 `dsh-app://app` 协议——外窗 URL 必须**由宿主自拼**（`http://127.0.0.1:<webServer.port>/...`），禁止客户端用 `location.origin` 拼；
3. spawn 传 `helper/main.js` **文件路径**（目录形式退化成 Node 语义）。

### 2.5 会话标题映射（已实证全链路）
- 代理为新会话播种 `first_user`（首条用户消息前 30 字）；
- DSH 重命名会话时发 title-gen 请求（提示词固定格式：`Generate the session title from this JSON array of human messages:\n[{seq,text}...]`）——**代理解析数组取首条消息、流式累积回复得新标题**，写入 `__titles__`；
- `/admin/titles` **拒收恒等映射**（key==value 的写回是噪音）；
- 显示回退链：`__titles__[first_user]` → `first_user` → conv 指纹。

### 2.6 生命周期
- DSH 正常退出：宿主 dispose 钩子 kill helper；
- DSH 崩溃：helper 看门狗每 3s 探测父进程（env `DSH_DASH_HOST_PID`）→ 消失即自尽；
- 端口随进程退出释放。

### 2.7 已实证的 DSH 内部 API（宿主侧）
- `ctx.sessionQuery.listSessions()`：条目 id 在 **`header.id`**；
- `readTitleSnapshots(ids)`：返回 **PromiseSettledResult 风格数组** `{status, sessionId, value:{session, title:{title}}}`（过滤 rejected）；
- `readSession(id)`：事件形状 `{type:'user/message', data:{content:[{type:'text',text}]}}`；
- 插件 bundle 形态：`package.json`（`dsh.bundle.cordis.patch.yml` + `dsh.client.platform:web` + `exports["./client"]`）+ 宿主 `lib/index.js` + 客户端 `client/`。

### 2.8 归属
作者/维护者：longjincf；MIT；形态借鉴 dsh-pet（ALKAERR/PC2005-cloud）与 dsh-plugins（Feahter）。

## 3. 执行要求

1. **先给完整执行方案**（分步、依赖、每步验证点、风险），交用户审核；
2. 审核通过后再动代码；全部**本地提交**；
3. **推远端必须用户明示**；
4. 验收标准：① ⚙→外窗→关闭→设置页重开全链路；② 杀 DSH 外窗 3s 自尽、端口释放；③ 新会话标题与 DSH 工作区一致且随重命名自动更新。
