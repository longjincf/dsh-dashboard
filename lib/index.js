/**
 * dsh-dashboard — 会话控制台（宿主端）。
 *
 * 只做薄中继：把浏览器端的控制请求转发到 llama_proxy 的 /admin 控制面
 * （A机 8080），会话状态、预算、白名单、清空全在后端执行。
 *
 * 路由（prefix /dsh-dashboard）：
 *   GET  /dsh-dashboard/status     -> /admin/status
 *   GET  /dsh-dashboard/sessions   -> /admin/sessions
 *   POST /dsh-dashboard/context    -> /admin/context
 *   POST /dsh-dashboard/tools      -> /admin/tools
 *   POST /dsh-dashboard/clear      -> /admin/clear
 */


import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'

const HOST_DIR = dirname(fileURLToPath(import.meta.url))
const STANDALONE_HTML = join(HOST_DIR, '..', 'client', 'standalone.html')
const HELPER_DIR = join(HOST_DIR, '..', 'runtime', 'helper')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DASH_DIR = join(DSH_HOME, 'dsh-dashboard')
const HELPER_PORT = 8792

let helperProc = null
let electronPromise = null
let masterOn = true

function loadMaster() {
  try {
    const d = JSON.parse(readFileSync(join(DASH_DIR, 'master.json'), 'utf8'))
    masterOn = d.on !== false
  } catch {}
}
function saveMaster() {
  try {
    mkdirSync(DASH_DIR, { recursive: true })
    writeFileSync(join(DASH_DIR, 'master.json'), JSON.stringify({ on: masterOn }))
  } catch {}
}
loadMaster()

function dashLog(msg) {
  try {
    mkdirSync(DASH_DIR, { recursive: true })
    appendFileSync(join(DASH_DIR, 'electron.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}

function electronBin() {
  if (process.platform === 'darwin') {
    return join(DSH_HOME, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(DSH_HOME, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
}

async function ensureElectron() {
  if (!process.versions.electron) return null
  const bin = electronBin()
  if (existsSync(bin)) return bin
  const version = process.versions.electron
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch
  const zipName = 'electron-v' + version + '-' + platform + '-' + arch + '.zip'
  const url = 'https://npmmirror.com/mirrors/electron/' + version + '/' + zipName
  dashLog('download electron ' + url)
  try {
    mkdirSync(join(DSH_HOME, 'electron'), { recursive: true })
    const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) })
    if (!res.ok) throw new Error('http ' + res.status)
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = join(DSH_HOME, 'electron', zipName)
    writeFileSync(zipPath, buf)
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', join(DSH_HOME, 'electron')], { stdio: 'ignore' })
    rmSync(zipPath, { force: true })
    dashLog('electron ready ' + bin)
    return existsSync(bin) ? bin : null
  } catch (e) {
    dashLog('electron download failed: ' + String(e && e.message || e))
    return null
  }
}

function killStaleHelper() {
  try {
    const pidPath = join(DASH_DIR, 'helper.pid')
    if (existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8'))
      try { process.kill(pid) } catch {}
    }
  } catch {}
}

function spawnDesktopWindow() {
  if (!process.versions.electron) return { desktop: false, error: '非桌面宿主' }
  if (helperProc && helperProc.exitCode === null) return { desktop: true }
  killStaleHelper()   // 旧 helper 可能占着端口：先按 pid 清掉，防止 EADDRINUSE
  try {
    const bin = process.env.DSH_DASH_ELECTRON_BIN && existsSync(process.env.DSH_DASH_ELECTRON_BIN)
      ? process.env.DSH_DASH_ELECTRON_BIN
      : electronBin()
    if (!existsSync(bin)) return { desktop: false, error: 'electron 未就绪' }
    const env = { ...process.env, DSH_DASH_PORT: String(HELPER_PORT), DSH_DASH_ADMIN: adminBaseForSpawn(), DSH_DASH_HOST_PID: String(process.pid) }
    delete env.ELECTRON_RUN_AS_NODE   // DSH 运行时会注入此变量，漏给 helper 会退化成纯 Node 模式
    helperProc = spawn(bin, [join(HELPER_DIR, 'main.js')], {
      detached: true,
      stdio: 'ignore',
      env,
    })
    helperProc.on('exit', () => { helperProc = null })
    helperProc.unref()
    dashLog('helper spawned pid=' + helperProc.pid)
    return { desktop: true }
  } catch (e) {
    return { desktop: false, error: String(e && e.message || e) }
  }
}

let adminBaseForSpawn = () => 'http://192.168.0.71:8080'

export const name = 'dsh-dashboard'

const DEFAULT_ADMIN_BASE = 'http://192.168.0.71:8080'

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const TABLE = {
  'GET /dsh-dashboard/status': '/admin/status',
  'GET /dsh-dashboard/sessions': '/admin/sessions',
  'GET /dsh-dashboard/defaults': '/admin/defaults',
  'POST /dsh-dashboard/defaults': '/admin/defaults',
  'POST /dsh-dashboard/context': '/admin/context',
  'POST /dsh-dashboard/tools': '/admin/tools',
  'POST /dsh-dashboard/clear': '/admin/clear',
}

function openExternal(url) {
  // 1) Electron shell（桌面宿主若可解析）
  try {
    const { createRequire } = require('node:module')
    const req = createRequire(import.meta.url)
    const { shell } = req('electron')
    if (shell && typeof shell.openExternal === 'function') {
      shell.openExternal(url)
      return true
    }
  } catch {
    // 插件运行时里 electron 不可解析：继续降级
  }
  // 2) macOS/linux/win 的系统打开命令
  try {
    const { execFileSync } = require('node:child_process')
    if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' })
      return true
    }
    if (process.platform === 'linux') {
      execFileSync('xdg-open', [url], { stdio: 'ignore' })
      return true
    }
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
      return true
    }
  } catch {
    // 全部失败：交给客户端复制地址
  }
  return false
}

function makeRoutes(config, getPort, getSessionQuery) {
  const adminBase = (config.adminBase || DEFAULT_ADMIN_BASE).replace(/\/$/, '')
  adminBaseForSpawn = () => adminBase
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    if (req.method === 'GET' && url.pathname === '/dsh-dashboard/standalone') {
      try {
        const html = await readFile(STANDALONE_HTML, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/dsh-dashboard/master') {
      try {
        const raw = await readBody(req)
        const body = raw ? JSON.parse(raw) : {}
        if (typeof body.on === 'boolean') {
          masterOn = body.on
          saveMaster()
          if (!masterOn && helperProc && helperProc.exitCode === null) {
            try { helperProc.kill() } catch {}
          }
        }
        sendJson(res, 200, { ok: true, masterOn })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/dsh-dashboard/switch-to-internal') {
      try {
        if (helperProc && helperProc.exitCode === null) {
          try { helperProc.kill() } catch {}
        }
        dashLog('switch to internal: helper killed')
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/dsh-dashboard/debug-titles') {
      try {
        const q = getSessionQuery ? getSessionQuery() : null
        const out = { sessionQueryAvailable: Boolean(q), hasList: Boolean(q && typeof q.listSessions === 'function') }
        if (q && typeof q.listSessions === 'function') {
          const list = (await q.listSessions()) || []
          out.listCount = list.length
          out.sample = list.slice(0, 3).map(x => ({ id: x && x.id, keys: x ? Object.keys(x) : [] }))
          const ids = list.map(x => (x && x.id)).filter(Boolean)
          try {
            const snaps = (await q.readTitleSnapshots(ids)) || []
            out.snapCount = snaps.length
            out.snapSample = snaps.slice(0, 3)
          } catch (e2) { out.snapError = String(e2 && e2.message || e2) }
        }
        sendJson(res, 200, out)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
      return
    }
    if (req.method === 'POST' && url.pathname === '/dsh-dashboard/open-external') {
      try {
        const r = spawnDesktopWindow()
        if (r.desktop) {
          sendJson(res, 200, { ok: true, opened: true, desktop: true, starting: false })
          return
        }
        // 首次启动：后台下载 Electron 完成后自动拉起
        if (!electronPromise) {
          electronPromise = ensureElectron().then(bin => {
            if (bin) return spawnDesktopWindow()
            return { desktop: false, error: 'electron 下载失败' }
          })
        }
        const outcome = await Promise.race([
          electronPromise,
          new Promise(rs => setTimeout(() => rs(null), 4000)),
        ])
        if (outcome && outcome.desktop) {
          sendJson(res, 200, { ok: true, opened: true, desktop: true, starting: false })
        } else if (outcome && outcome.error) {
          sendJson(res, 200, { ok: true, opened: false, desktop: false, starting: false, error: outcome.error })
        } else {
          sendJson(res, 200, { ok: true, opened: false, desktop: false, starting: true,
            message: '首次启动需下载 Electron（约 100MB），完成后自动弹出；请稍后再次点击查看' })
        }
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      }
      return
    }
    const hit = TABLE[req.method + ' ' + url.pathname]
    if (!hit) {
      sendJson(res, 404, { ok: false, error: 'not found: ' + url.pathname })
      return
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined
      const up = await fetch(adminBase + hit, {
        method: req.method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
        signal: AbortSignal.timeout(10000),
      })
      const data = await up.json().catch(() => ({}))
      // 注入桌宠窗状态与总开关，供内嵌浮窗自动"切回"与隐藏
      if (url.pathname === '/dsh-dashboard/status' || url.pathname === '/dsh-dashboard/sessions') {
        if (data && typeof data === 'object') {
          data.desktop = Boolean(helperProc && helperProc.exitCode === null)
          data.masterOn = masterOn
        }
      }
      // 会话标题对齐：first_user -> DSH Session Title（写回代理 + 本响应）
      if (url.pathname === '/dsh-dashboard/sessions' && data && Array.isArray(data.sessions)) {
        try {
          const q = getSessionQuery ? getSessionQuery() : null
          if (q && typeof q.listSessions === 'function') {
            const list = (await q.listSessions()) || []
            const ids = list.map(x => (x && x.id)).filter(Boolean)
            let snaps = []
            try { snaps = (await q.readTitleSnapshots(ids)) || [] } catch { snaps = [] }
            const titleById = {}
            for (const x of snaps) {
              const id = x && (x.id || x.sessionId)
              if (id) titleById[id] = (x && (x.title || x.text)) || ''
            }
            const titles = new Map()
            for (const it of list) {
              const t = String(titleById[it.id] || '').trim()
              if (t) titles.set(t.slice(0, 30), t)
            }
            const map = {}
            for (const sess of data.sessions) {
              if (sess.first_user) {
                const hit = titles.get(sess.first_user)
                if (hit) { map[sess.first_user] = hit; continue }
                for (const [k, v] of titles) {
                  if (v.indexOf(sess.first_user) === 0 || sess.first_user.indexOf(k) === 0) { map[sess.first_user] = v; break }
                }
              }
            }
            if (Object.keys(map).length) {
              fetch(adminBase + '/admin/titles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ map }),
              }).catch(() => {})
              for (const sess of data.sessions) {
                if (sess.first_user && map[sess.first_user]) sess.title = map[sess.first_user]
              }
            }
          }
        } catch {}
      }
      sendJson(res, up.status, data)
    } catch (error) {
      sendJson(res, 502, { ok: false, error: String(error && error.message || error) })
    }
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const route = {
    kind: 'prefix',
    path: '/dsh-dashboard',
    handler: makeRoutes(
      config,
      () => (ctx.webServer && ctx.webServer.port) || 0,
      () => { try { return ctx.get('sessionQuery') } catch { return null } },
    ),
  }
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => hostCtx.webServer.register(route), 'dsh-dashboard: http routes')
    // DSH 退出/插件卸载：回收 helper（外窗关闭、端口释放）
    hostCtx.effect(() => () => {
      if (helperProc && helperProc.exitCode === null) {
        try { helperProc.kill() } catch {}
      }
    }, 'dsh-dashboard: dispose cleanup')
  })
}

export default { name, apply }
