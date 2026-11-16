// dsh-dashboard 桌宠窗 helper（完全独立）：
// 自带 HTTP 服务器（serve 页面 + 直连 llama_proxy /admin），窗口只依赖本进程。
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ADMIN = process.env.DSH_DASH_ADMIN || 'http://192.168.0.71:8080'
const HTML = fs.readFileSync(path.join(__dirname, 'standalone.html'), 'utf8')

const stateDir = path.join(os.homedir(), '.dsh', 'dsh-dashboard')
const stateFile = path.join(stateDir, 'window-state.json')
const pidFile = path.join(stateDir, 'helper.pid')
try { fs.mkdirSync(stateDir, { recursive: true }) } catch {}
try { fs.writeFileSync(pidFile, String(process.pid)) } catch {}

// 防崩溃弹窗：任何未捕获异常静默退出
process.on('uncaughtException', () => { try { app.exit(0) } catch {} })

let PORT = Number(process.env.DSH_DASH_PORT || 8792)

// ---------- 迷你服务器：页面 + llama_proxy /admin 中继 ----------
const TABLE = {
  'GET /': '/admin/status',
  'GET /standalone': null,               // 页面
  'GET /dsh-dashboard/standalone': null,
  'GET /sessions': '/admin/sessions',
  'GET /status': '/admin/status',
  'GET /defaults': '/admin/defaults',
  'POST /defaults': '/admin/defaults',
  'POST /context': '/admin/context',
  'POST /tools': '/admin/tools',
  'POST /clear': '/admin/clear',
  // 与 DSH 内嵌浮窗同路径别名，保证内外行为一致
  'GET /dsh-dashboard/status': '/admin/status',
  'GET /dsh-dashboard/sessions': '/admin/sessions',
  'GET /dsh-dashboard/defaults': '/admin/defaults',
  'POST /dsh-dashboard/defaults': '/admin/defaults',
  'POST /dsh-dashboard/context': '/admin/context',
  'POST /dsh-dashboard/tools': '/admin/tools',
  'POST /dsh-dashboard/clear': '/admin/clear',
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://local')
    const key = req.method + ' ' + u.pathname
    if (TABLE[key] === null) {
      send(res, 200, HTML, 'text/html; charset=utf-8')
      return
    }
    const target = TABLE[key]
    if (!target) { send(res, 404, JSON.stringify({ ok: false, error: 'not found' })); return }
    const body = req.method === 'POST' ? await new Promise((rs, rj) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => rs(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', rj)
    }) : undefined
    const up = await fetch(ADMIN + target, {
      method: req.method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      signal: AbortSignal.timeout(10000),
    })
    send(res, up.status, await up.text())
  } catch (e) {
    send(res, 502, JSON.stringify({ ok: false, error: String(e && e.message || e) }))
  }
})
function listenRetry(tries) {
  if (tries <= 0) { app.exit(0); return }
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') { PORT += 1; listenRetry(tries - 1) }
    else { app.exit(0) }
  })
  server.listen(PORT, '127.0.0.1')
}
listenRetry(10)

// ---------- 窗口 ----------
let win = null
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null } }
function saveState() {
  if (!win) return
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    const [x, y] = win.getPosition()
    const { width, height } = win.getBounds()
    fs.writeFileSync(stateFile, JSON.stringify({ x, y, width, height }))
  } catch {}
}

app.whenReady().then(() => {
  const st = loadState() || {}
  const display = screen.getPrimaryDisplay().workArea
  const width = st.width || 420
  const height = st.height || 640
  let x = st.x !== undefined ? st.x : display.x + display.width - width - 24
  let y = st.y !== undefined ? st.y : display.y + 24
  x = Math.min(Math.max(x, display.x), display.x + display.width - 80)
  y = Math.min(Math.max(y, display.y), display.y + display.height - 80)

  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadURL('http://127.0.0.1:' + PORT + '/standalone')

  win.on('move', saveState)
  win.on('resize', saveState)
  win.on('close', () => { saveState() })
  win.on('closed', () => { server.close(); app.quit() })
  app.on('quit', () => { try { fs.rmSync(pidFile, { force: true }) } catch {} })
})

ipcMain.on('dshdash-close', () => { if (win) win.close() })
ipcMain.on('dshdash-hide', () => { if (win) win.hide() })

app.on('window-all-closed', () => app.quit())
