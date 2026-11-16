// dsh-dashboard 宿主插件：master 总开关 / helper 生命周期 / HTTP 控制面 / 标题映射
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DashboardHelper } from './helper.js'
import { startTitleSync } from './titles.js'

export const name = 'dsh-dashboard'
export const inject = ['webServer', 'sessionQuery']

const ROUTE = '/dsh-dashboard'
const DEFAULT_ADMIN_BASE = 'http://192.168.0.71:8080'
const DEFAULT_POLL_MS = 5000

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
}

function stateDirOf(home) {
  return join(home, 'dsh-dashboard')
}

function masterPathOf(home) {
  return join(stateDirOf(home), 'master.json')
}

export function apply(ctx, config = {}) {
  const adminBase = typeof config.adminBase === 'string' && config.adminBase.trim()
    ? config.adminBase.trim().replace(/\/+$/, '')
    : DEFAULT_ADMIN_BASE
  const pollMs = Number.isFinite(Number(config.pollMs)) && Number(config.pollMs) >= 1000
    ? Number(config.pollMs)
    : DEFAULT_POLL_MS

  const home = dshHome()
  const stateDir = stateDirOf(home)
  const masterPath = masterPathOf(home)
  mkdirSync(stateDir, { recursive: true })
  if (!existsSync(masterPath)) writeFileSync(masterPath, JSON.stringify({ on: false }))

  const readMaster = () => {
    try {
      return Boolean(JSON.parse(readFileSync(masterPath, 'utf8')).on)
    } catch {
      return false
    }
  }
  const writeMaster = (on) => writeFileSync(masterPath, JSON.stringify({ on: Boolean(on) }))

  const helper = new DashboardHelper({ ctx, adminBase, pollMs, dshHome: home, stateDir })
  const log = (m) => {
    try { ctx.logger?.info?.(`[dsh-dashboard] ${m}`) } catch { /* 静默 */ }
  }

  // ---- HTTP 控制面（客户端经相对路径 fetch；外窗页面由 helper 自带服务器提供，不依赖此路由）----
  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }
  const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        const rest = decodeURIComponent(url.pathname.slice(ROUTE.length + 1))
        const method = req.method || 'GET'
        if (method === 'GET' && rest === 'state') {
          return sendJson(res, 200, {
            on: readMaster(),
            port: helper.port,
            adminBase,
            pollMs,
            degraded: helper.degraded,
            downloading: helper.downloading
          })
        }
        if (method === 'POST' && rest === 'open') {
          return sendJson(res, 200, await helper.open())
        }
        if (method === 'POST' && rest === 'close-window') {
          return sendJson(res, 200, await helper.closeWindow())
        }
        if (method === 'POST' && rest === 'set-master') {
          let body = {}
          try {
            body = JSON.parse((await readBody(req)) || '{}')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid body' })
          }
          const on = Boolean(body.on)
          writeMaster(on)
          if (!on) helper.stop('master-off')
          log(`master ${on ? 'ON' : 'OFF'}`)
          return sendJson(res, 200, { ok: true, on })
        }
        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        if (!res.writableEnded) {
          sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }
  }), 'dsh-dashboard: http routes')

  // ---- 会话标题映射轮询（代理不可达时静默降级）----
  const stopTitles = startTitleSync({
    ctx,
    adminBase,
    pollMs,
    onDegraded: (d) => { helper.degraded = d },
    logger: ctx.logger
  })

  // ---- 生命周期：插件卸载 / DSH 正常退出 → 杀 helper（崩溃场景由 helper 看门狗兜底）----
  ctx.effect(() => () => {
    stopTitles()
    helper.stop('dsh-dispose')
  })

  log(`已启动：adminBase=${adminBase} pollMs=${pollMs} master=${readMaster()}`)
}
