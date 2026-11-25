// dsh-dashboard 宿主侧：外窗 helper 进程管理（spawn / 控制 / 回收）
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureElectron, resolveElectron } from './electron.js'

const HELPER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'helper')
const HELPER_MAIN = join(HELPER_DIR, 'main.js')
const PORT_BASE = 8792
const PORT_TRIES = 10

/** 探测一个可绑定端口（不持有）。 */
function probeFreePort(start, triesLeft = PORT_TRIES) {
  return new Promise((resolve, reject) => {
    if (triesLeft <= 0) return reject(new Error(`端口 ${PORT_BASE}~${PORT_BASE + PORT_TRIES - 1} 全被占用`))
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(probeFreePort(start + 1, triesLeft - 1)))
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export class DashboardHelper {
  constructor({ ctx, dshHome, stateDir, token }) {
    this.ctx = ctx
    this.dshHome = dshHome
    this.stateDir = stateDir
    this.child = null
    this.port = 0
    this.token = token || randomBytes(16).toString('hex')
    this.downloading = false
    this._ensurePromise = null
  }

  log(msg) {
    try { this.ctx.logger?.info?.(`[dsh-dashboard] ${msg}`) } catch { /* 静默 */ }
  }

  /** 打开外窗：首次含 Electron 定位/下载；已运行则通知 helper 重新显示窗口。 */
  async open() {
    if (!process.versions.electron) {
      return { ok: false, error: '当前宿主不是桌面应用，外窗不可用' }
    }
    const version = process.versions.electron
    if (this.child) {
      return this._ctl('show')
    }
    let exe = resolveElectron({ dshHome: this.dshHome, version })
    if (!exe) {
      if (this._ensurePromise) exe = await this._ensurePromise
      else {
        this.downloading = true
        this._ensurePromise = ensureElectron({ dshHome: this.dshHome, version, logger: this.ctx.logger })
          .finally(() => { this.downloading = false; this._ensurePromise = null })
        try {
          exe = await this._ensurePromise
        } catch (e) {
          return { ok: false, error: `Electron 下载失败：${e instanceof Error ? e.message : String(e)}` }
        }
      }
    }
    if (!this.child) {
      await this._spawn(exe)
    }
    return { ok: true, port: this.port }
  }

  async _spawn(exe) {
    mkdirSync(this.stateDir, { recursive: true })
    let port
    try {
      port = await probeFreePort(PORT_BASE)
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
    // 宿主 webServer 源（helper 页面数据面反代目标；由宿主自拼，客户端永不拼 URL）
    let hostOrigin = `http://127.0.0.1:${this.ctx.webServer?.port || 0}`
    try {
      const o = this.ctx.webServer.getOrigin()
      if (typeof o === 'string' && o) hostOrigin = o
    } catch { /* 保留端口拼法 */ }
    const env = {
      ...process.env,
      DSH_DASH_HOST_PID: String(process.pid),
      DSH_DASH_TOKEN: this.token,
      DSH_DASH_PORT: String(port),
      DSH_DASH_URL: `http://127.0.0.1:${port}/standalone.html`,
      DSH_DASH_STATE_DIR: this.stateDir,
      DSH_DASH_LOG: join(this.stateDir, 'electron.log'),
      DSH_DASH_HOST_ORIGIN: hostOrigin
    }
    // 坑：DSH 运行时注入 ELECTRON_RUN_AS_NODE=1，会让 helper 以纯 Node 语义启动秒崩——spawn 前必须删除
    delete env.ELECTRON_RUN_AS_NODE

    this.log(`spawn helper: ${exe} port=${port}`)
    const child = spawn(exe, [HELPER_MAIN], {
      cwd: this.dshHome,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows：隐藏控制台窗口，避免黑框闪现
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
    this.child = child
    this.port = port

    child.stdout.on('data', (c) => {
      const line = String(c).trim()
      // 端口握手：helper 实际绑定端口（可能因 EADDRINUSE +1 漂移）
      const m = /^DASHBOARD_PORT=(\d+)$/.exec(line)
      if (m) {
        this.port = Number(m[1])
        this.log(`helper 端口确认：${this.port}`)
        return
      }
      if (line) this.log(`helper: ${line}`)
    })
    child.stderr.on('data', (c) => {
      const line = String(c).trim()
      if (line) this.log(`helper(err): ${line}`)
    })
    child.once('error', (e) => {
      this.log(`helper spawn 失败：${e.message}`)
      if (this.child === child) { this.child = null; this.port = 0 }
    })
    child.once('exit', () => {
      if (this.child === child) { this.child = null; this.port = 0 }
    })

    // 等 helper 起服（最多 ~8s）
    for (let i = 0; i < 16; i++) {
      await sleep(500)
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/__health`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) return { ok: true, port: this.port }
      } catch {
        // 继续等
      }
      if (!this.child) return { ok: false, error: 'helper 进程提前退出' }
    }
    return { ok: true, port: this.port, warning: 'helper 健康检查超时，窗口可能稍后出现' }
  }

  /** 通知 helper：show / close（只关窗口，保留进程）。 */
  async _ctl(action) {
    if (!this.child || !this.port) return { ok: false, error: '外窗未运行' }
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/__ctl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-dash-token': this.token },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(3000)
      })
      const j = await r.json().catch(() => ({}))
      return { ok: r.ok && j.ok !== false, port: this.port, ...j }
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) }
    }
  }

  /** 外窗 ✕ 语义：只关窗口，helper 进程保留（快速复现）。 */
  closeWindow() {
    return this._ctl('close')
  }

  /** 杀 helper：总开关 OFF 或 DSH 退出。SIGTERM + 1.5s 后 SIGKILL 兜底。 */
  stop(reason = 'stop') {
    const child = this.child
    this.child = null
    this.port = 0
    if (!child) return
    this.log(`kill helper (${reason}) pid=${child.pid}`)
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, 1500)
    t.unref?.()
  }
}
