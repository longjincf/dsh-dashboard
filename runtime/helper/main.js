/**
 * dsh-dashboard 外窗 helper 运行时（main.js）
 *
 * 运行方式（三种情况 HTTP 服务器都必须工作）：
 *  1. GUI 模式：由宿主下载好的 Electron 二进制直接执行本文件，
 *     require('electron') 返回对象且含 app / BrowserWindow → 提供透明置顶外窗。
 *  2. 纯 HTTP 模式：普通 node 执行，或 ELECTRON_RUN_AS_NODE=1 时
 *     require('electron') 返回二进制路径字符串（非对象）→ 仅起 HTTP 服务器。
 *  3. require('electron') 抛错（未安装 Electron 包）→ 同样仅起 HTTP 服务器。
 *
 * 环境变量契约（宿主注入，勿改）：
 *   DSH_DASH_HOST_PID    宿主进程 pid（看门狗探测目标）
 *   DSH_DASH_HOST_ORIGIN 宿主 webServer 源，如 http://127.0.0.1:49692（/api/* 数据源）
 *   DSH_DASH_TOKEN       随机鉴权 token（/__ctl 校验；转发 /api/* 时作为 x-dsh-dash-token 头）
 *   DSH_DASH_PORT        首选端口（8792 起）
 *   DSH_DASH_URL        外窗 URL 模板 http://127.0.0.1:<端口>/standalone.html
 *   DSH_DASH_STATE_DIR  状态目录（存 window-state.json）
 *   DSH_DASH_LOG        日志文件路径
 *   （号池用量 /pool-balance 经 /dsh-dashboard/pool-balance 由宿主反代，helper 不直连网关）
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

/* ================= Electron 探测 ================= */

let guiMode = false;       // 是否 GUI 模式
let electronApp = null;    // Electron app 对象
let BrowserWindow = null;  // Electron BrowserWindow 构造器
let electronScreen = null; // Electron screen 模块

try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.app && e.BrowserWindow) {
    // GUI 模式：由 Electron 二进制作为主进程执行本文件
    guiMode = true;
    electronApp = e.app;
    BrowserWindow = e.BrowserWindow;
    electronScreen = e.screen;
  } else {
    // 纯 HTTP 模式：ELECTRON_RUN_AS_NODE=1 或普通 node 下 require('electron') 返回二进制路径字符串
    console.warn('[dsh-dashboard] 未运行在 Electron GUI 环境（require("electron") 返回字符串），仅启动 HTTP 服务器。');
  }
} catch (err) {
  // 纯 HTTP 模式：require('electron') 抛错（未安装 Electron 包）
  console.warn('[dsh-dashboard] 未检测到 Electron 环境（' + (err && err.message) + '），仅启动 HTTP 服务器。');
}

/* ================= 全局状态 ================= */

let server = null;         // HTTP 服务器实例
let actualPort = 0;        // 实际监听端口
let mainWindow = null;     // 当前窗口（✕ 关闭后置 null，进程保留）
let watchdogTimer = null;  // 看门狗定时器
let saveStateTimer = null; // 窗口状态防抖写回定时器
let exiting = false;       // 防止重复退出

/* ================= 日志 ================= */

// 日志失败静默，不影响主流程
function log(msg) {
  try {
    const file = process.env.DSH_DASH_LOG;
    if (!file) return;
    fs.appendFileSync(file, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    /* 忽略 */
  }
}

/* ================= 通用响应 ================= */

function sendJson(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ================= HTTP 服务器 ================= */

// 从 DSH_DASH_PORT 开始尝试监听 127.0.0.1，EADDRINUSE 自动 +1，最多 10 次
function startServer() {
  return new Promise((resolve, reject) => {
    let port = parseInt(process.env.DSH_DASH_PORT, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) port = 8792;
    let attempts = 0;

    const tryListen = () => {
      attempts += 1;
      if (attempts > 10) {
        reject(new Error('连续 10 个端口均被占用，无法启动 HTTP 服务器'));
        return;
      }
      const srv = http.createServer(handleRequest);
      srv.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          // 端口被占用：自动 +1 重试（最多 10 次）
          log('端口 ' + port + ' 被占用，尝试 ' + (port + 1));
          port += 1;
          tryListen();
        } else {
          reject(err);
        }
      });
      srv.listen(port, '127.0.0.1', () => {
        server = srv;
        actualPort = port;
        console.log('DASHBOARD_PORT=' + port); // 监听成功后向 stdout 打印实际端口
        log('HTTP 服务器已启动 127.0.0.1:' + port);
        resolve();
      });
    };

    tryListen();
  });
}

function handleRequest(req, res) {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && urlPath === '/__health') {
    // 健康检查：不校验 token
    return sendJson(res, 200, { ok: true, port: actualPort });
  }
  if (req.method === 'POST' && urlPath === '/__ctl') {
    return handleCtl(req, res);
  }
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/standalone.html')) {
    return serveStandalone(res);
  }
  if (req.method === 'GET' && urlPath === '/pool-balance') {
    // 号池用量：helper 进程受沙箱限制不能直连 7862，经宿主反代（带 token）
    const force = (req.url || '').includes('force=1');
    return proxyToHost(req, res, '/dsh-dashboard/api/pool-balance' + (force ? '?force=1' : ''));
  }
  if (urlPath.startsWith('/api')) {
    return proxyToHost(req, res);
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
}

/* ================= /__ctl 控制接口 ================= */

function handleCtl(req, res) {
  const token = req.headers['x-dsh-dash-token'];
  const expected = process.env.DSH_DASH_TOKEN || '';
  if (!expected || token !== expected) {
    log('ctl 拒绝：token 不匹配（' + req.socket.remoteAddress + '）');
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'bad request' });
    }
    const action = body.action;
    log('ctl 指令：' + action);

    if (action === 'show') {
      // 有窗口则 show+focus；无窗口则重建窗口
      if (guiMode) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          log('ctl：显示并聚焦已有窗口');
        } else {
          createWindow();
          log('ctl：窗口不存在，已重建');
        }
      } else {
        log('ctl：纯 HTTP 模式无窗口，忽略 show');
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'close') {
      // 销毁窗口，但进程继续运行（服务器保留）
      if (guiMode && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        log('ctl：已销毁窗口，服务器继续运行');
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'quit') {
      sendJson(res, 200, { ok: true });
      log('ctl：收到 quit，退出进程');
      setTimeout(() => exitApp(0), 50); // 先让响应送达客户端再退出
      return;
    }

    sendJson(res, 400, { ok: false, error: 'unknown action' });
  });
}

/* ================= 静态页面 ================= */

function serveStandalone(res) {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'standalone.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store' // 页面每次全新拉取，避免 Electron HTTP 缓存串旧版本
    });
    res.end(html);
  } catch (err) {
    sendJson(res, 404, { ok: false, error: 'standalone.html not found' });
  }
}

/* ================= /api/* 反向代理（→ DSH 宿主） ================= */

// 剥掉 /api 前缀后拼 DSH_DASH_HOST_ORIGIN + "/dsh-dashboard/api" + 剩余路径；
// 追加 x-dsh-dash-token 头；透传方法与请求体；10s 超时；不可达返回 502。
function proxyToHost(req, res, targetPath) {
  const startedAt = Date.now()
  const reqLine = req.method + ' ' + (req.url || '/')
  const base = (process.env.DSH_DASH_HOST_ORIGIN || '').trim().replace(/\/+$/, '');
  if (!base) {
    log('代理失败：未配置 DSH_DASH_HOST_ORIGIN');
    return sendJson(res, 502, { ok: false, error: '数据源不可达' });
  }

  let target;
  try {
    // targetPath 显式给定时直接用（如 /dsh-dashboard/pool-balance?force=1）；
    // 否则按 /api 语义：剥掉 /api 前缀拼 /dsh-dashboard/api + 剩余路径（含 query）
    const suffix = targetPath !== undefined
      ? targetPath
      : '/dsh-dashboard/api' + ((req.url || '/').replace(/^\/api/, '') || '/');
    target = new URL(base + suffix);
  } catch (err) {
    log('代理失败：DSH_DASH_HOST_ORIGIN 解析出错 ' + err.message);
    return sendJson(res, 502, { ok: false, error: '数据源不可达' });
  }

  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    if (k === 'host') continue; // host 用目标地址
    if (req.headers[k] !== undefined) headers[k] = req.headers[k];
  }
  headers.host = target.host;
  headers['x-dsh-dash-token'] = process.env.DSH_DASH_TOKEN || '';

  const upstream = mod.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers: headers,
    timeout: 30000 // 30s 超时：宿主冷启动读 281 会话标题可达 ~10s，10s 会误判数据源不可达
  }, (upRes) => {
    // 成功：透传状态码与全部响应头（保留 content-encoding！丢它会导致 gzip 体被当明文解析）
    // 仅剥除逐跳头（hop-by-hop）
    const respHeaders = {};
    for (const k of Object.keys(upRes.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade') continue;
      if (upRes.headers[k] !== undefined) respHeaders[k] = upRes.headers[k];
    }
    res.writeHead(upRes.statusCode, respHeaders);
    upRes.pipe(res);
    log('api ' + reqLine + ' → ' + upRes.statusCode + ' ' + (Date.now() - startedAt) + 'ms');
  });

  upstream.on('timeout', () => {
    log('代理超时：' + target.href);
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', (err) => {
    log('代理不可达：' + (err && err.message));
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: '数据源不可达' });
    } else {
      res.destroy();
    }
  });

  // 透传请求体（POST/PUT 等带 body 时）
  req.pipe(upstream);
}

/* ================= 窗口状态读写（仅 GUI 模式） ================= */

function stateFile() {
  const dir = process.env.DSH_DASH_STATE_DIR;
  return dir ? path.join(dir, 'window-state.json') : null;
}

function readWindowState() {
  const f = stateFile();
  if (!f) return { x: undefined, y: undefined, width: 420, height: 640 };
  try {
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      x: Number.isFinite(st.x) ? st.x : undefined,
      y: Number.isFinite(st.y) ? st.y : undefined,
      width: Number.isFinite(st.width) ? st.width : 420,
      height: Number.isFinite(st.height) ? st.height : 640
    };
  } catch (e) {
    // 文件缺失或损坏 → 用默认值
    return { x: undefined, y: undefined, width: 420, height: 640 };
  }
}

// 把窗口 clamp 进主显示器 workArea，至少露出 60px
function clampToWorkArea(st) {
  let wa;
  try {
    wa = electronScreen.getPrimaryDisplay().workArea;
  } catch (e) {
    const all = electronScreen.getAllDisplays();
    wa = (all && all[0] && all[0].workArea) || { x: 0, y: 0, width: 1280, height: 800 };
  }
  const MIN_VISIBLE = 60;
  const w = Math.max(300, Math.min(st.width, wa.width));
  const h = Math.max(300, Math.min(st.height, wa.height));
  // 默认位置：屏幕右缘留 12px 边距
  let x = Number.isFinite(st.x) ? st.x : wa.x + wa.width - w - 12;
  let y = Number.isFinite(st.y) ? st.y : wa.y + 24;
  x = Math.max(wa.x + MIN_VISIBLE - w, Math.min(x, wa.x + wa.width - MIN_VISIBLE));
  y = Math.max(wa.y + MIN_VISIBLE - h, Math.min(y, wa.y + wa.height - MIN_VISIBLE));
  return { x, y, width: w, height: h };
}

function saveWindowState() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const f = stateFile();
    if (!f) return;
    const b = mainWindow.getBounds();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
  } catch (e) {
    // 写状态失败静默
  }
}

// 'moved' / 'resized' 事件防抖 300ms 写回 window-state.json
function scheduleSaveWindowState() {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    saveWindowState();
  }, 300);
}

/* ================= BrowserWindow（仅 GUI 模式） ================= */

function createWindow() {
  if (!guiMode) return;
  const st = clampToWorkArea(readWindowState());
  const win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    transparent: true,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false, // macOS 透明窗：关闭系统圆角合成，避免边缘伪影
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;

  try {
    win.setAlwaysOnTop(true, 'screen-saver');
  } catch (e) {
    log('setAlwaysOnTop 失败：' + (e && e.message));
  }
  // macOS 隐藏 Dock 图标
  if (electronApp.dock) {
    try {
      electronApp.dock.hide();
    } catch (e) {
      /* 无 Dock 环境忽略 */
    }
  }

  // 用实际端口替换 DSH_DASH_URL 中的端口（正则替换 127.0.0.1:\d+）
  let url = (process.env.DSH_DASH_URL || '').trim() ||
    'http://127.0.0.1:' + actualPort + '/standalone.html';
  url = url.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:' + actualPort);
  // 缓存穿透：每次开窗都带新查询串，杜绝 Electron HTTP 缓存串旧页面
  url += (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
  win.loadURL(url).catch((err) => {
    log('窗口加载失败：' + (err && err.message));
  });

  win.on('moved', scheduleSaveWindowState);
  win.on('resized', scheduleSaveWindowState);
  // ✕ 只关窗口，进程与服务器继续（验收点）
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    log('窗口已关闭（✕），进程与服务器继续运行');
  });

  log('窗口已创建：' + st.width + 'x' + st.height + ' @(' + st.x + ',' + st.y + ') 加载 ' + url);
}

/* ================= 看门狗（核心验收点） ================= */

// 每 3s 探测宿主进程：ESRCH（进程不存在）→ 记日志并退出；
// EPERM 表示进程存在但无权限发信号 → 视为存活。
function startWatchdog() {
  const raw = process.env.DSH_DASH_HOST_PID;
  const hostPid = Number(raw);
  if (!raw || !Number.isFinite(hostPid) || hostPid <= 0) {
    log('看门狗未启动：缺少有效的 DSH_DASH_HOST_PID');
    return;
  }
  log('看门狗已启动，监测宿主 pid=' + hostPid);
  watchdogTimer = setInterval(() => {
    try {
      process.kill(hostPid, 0); // 仅探测，不发送信号
    } catch (err) {
      if (err && err.code === 'ESRCH') {
        log('看门狗：宿主进程 ' + hostPid + ' 已不存在，helper 退出');
        exitApp(0);
      }
      // EPERM 等其它错误：进程存在，视为存活
    }
  }, 3000);
  if (watchdogTimer.unref) watchdogTimer.unref(); // 不阻止事件循环退出
}

/* ================= 退出 ================= */

function exitApp(code) {
  if (exiting) return;
  exiting = true;
  log('进程退出，code=' + code);
  try {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (saveStateTimer) clearTimeout(saveStateTimer);
  } catch (e) { /* 忽略 */ }
  try {
    if (server) server.close();
  } catch (e) { /* 忽略 */ }
  if (guiMode && electronApp && typeof electronApp.exit === 'function') {
    try {
      electronApp.exit(code);
      return;
    } catch (e) {
      /* 回落到 process.exit */
    }
  }
  process.exit(code);
}

// SIGTERM / SIGINT 优雅退出：清定时器、关服务器、退出
process.on('SIGTERM', () => {
  log('收到 SIGTERM，优雅退出');
  exitApp(0);
});
process.on('SIGINT', () => {
  log('收到 SIGINT，优雅退出');
  exitApp(0);
});

/* ================= 启动 ================= */

(async function main() {
  log('helper 启动 pid=' + process.pid + ' 模式=' + (guiMode ? 'GUI' : 'HTTP') + ' node=' + process.version);

  // 启动顺序：先起 HTTP 服务器 → app.whenReady → 建窗口
  try {
    await startServer();
  } catch (err) {
    const msg = 'HTTP 服务器启动失败：' + (err && err.message);
    console.error('[dsh-dashboard] ' + msg);
    log(msg);
    process.exit(1);
  }

  startWatchdog();

  if (guiMode) {
    // ✕ 只关窗口：window-all-closed 不退出进程
    electronApp.on('window-all-closed', () => {
      log('所有窗口已关闭，进程继续运行');
    });
    electronApp.whenReady().then(() => {
      log('Electron 就绪，创建窗口');
      createWindow();
    }).catch((err) => {
      log('Electron ready 失败：' + (err && err.message));
    });
  }
})();
