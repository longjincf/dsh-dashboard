// dsh-dashboard 宿主插件 v3：完全独立的 DSH 原生控制台
//
// 数据面 = DSH 宿主本身，不依赖任何外部项目（无 llama_proxy /admin 耦合）：
//   - 会话列表/标题：ctx.sessionQuery（DSH 会话 id 唯一 → 同首消息多会话结构性区分）
//   - 工具白名单：agent.ctx.tools.restrict 作用域真执法（默认白名单 + 每会话白名单）
//   - 清空上下文：ctx.compaction.compactNow（与官方 /compact 命令同一实现）
//   - 外窗 helper：仅窗口控制/看门狗/健康检查；页面数据经 helper 反代回本宿主（token 校验）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DashboardHelper } from './helper.js'

export const name = 'dsh-dashboard'
// compaction 为可选服务（web 组合默认禁用 compaction-basic）：软取，缺失时清空功能返回明确提示
export const inject = ['webServer', 'sessionQuery', 'tools']

const ROUTE = '/dsh-dashboard'
const STATE_FILE = 'console.json'

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh')
}

function stateDirOf(home) {
  return join(home, 'dsh-dashboard')
}

export function apply(ctx, config = {}) {
  const home = dshHome()
  const stateDir = stateDirOf(home)
  const masterPath = join(stateDir, 'master.json')
  const consolePath = join(stateDir, STATE_FILE)
  mkdirSync(stateDir, { recursive: true })
  if (!existsSync(masterPath)) writeFileSync(masterPath, JSON.stringify({ on: false }))

  const log = (m) => {
    try { ctx.logger?.info?.(`[dsh-dashboard] ${m}`) } catch { /* 静默 */ }
  }

  // ---- 插件状态（console.json：默认白名单 + 每会话白名单）----
  const readState = () => {
    try {
      const v = JSON.parse(readFileSync(consolePath, 'utf8'))
      return {
        defaults: { allow: null, ...(v.defaults || {}) },
        sessions: v.sessions || {}
      }
    } catch {
      return { defaults: { allow: null }, sessions: {} }
    }
  }
  const writeState = (s) => writeFileSync(consolePath, JSON.stringify(s, null, 2))
  const readMaster = () => {
    try { return Boolean(JSON.parse(readFileSync(masterPath, 'utf8')).on) } catch { return false }
  }
  const writeMaster = (on) => writeFileSync(masterPath, JSON.stringify({ on: Boolean(on) }))

  // ---- 活 agent 跟踪：sessionId → agent / restrict 清理器 ----
  const liveAgents = new Map()
  const liveRestricts = new Map()

  const applyAllow = (sessionId, allow) => {
    const old = liveRestricts.get(sessionId)
    try { old?.() } catch { /* 已随 agent 释放 */ }
    liveRestricts.delete(sessionId)
    const agent = liveAgents.get(sessionId)
    if (!agent) return
    if (allow === null || allow === undefined) return // 不限制（全部可用）
    const list = Array.isArray(allow) ? allow : []
    try {
      const disposer = agent.ctx.tools.restrict({ allow: list })
      liveRestricts.set(sessionId, disposer)
    } catch (e) {
      log(`restrict 失败 session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent || !agent.ctx || !agent.session) return
    const sid = agent.session.id
    liveAgents.set(sid, agent)
    const st = readState()
    const allow = (st.sessions[sid] && st.sessions[sid].allow !== undefined)
      ? st.sessions[sid].allow
      : (st.defaults.allow !== undefined ? st.defaults.allow : null)
    applyAllow(sid, allow)
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    const sid = agent && agent.session && agent.session.id
    if (!sid) return
    liveAgents.delete(sid)
    try { liveRestricts.get(sid)?.() } catch { /* 静默 */ }
    liveRestricts.delete(sid)
  })

  // ---- 会话数据负载（helper 反代取数用）----
  const sessionsPayload = async () => {
    const st = readState()
    const records = await ctx.sessionQuery.listSessions()
    const ids = (records || []).map((r) => r && r.header && r.header.id).filter(Boolean)
    let snaps = []
    try {
      snaps = await ctx.sessionQuery.readTitleSnapshots(ids)
    } catch {
      snaps = []
    }
    const titleOf = new Map()
    for (const s of snaps || []) {
      if (s && s.status === 'fulfilled' && s.value) {
        titleOf.set(s.value.session && s.value.session.id, (s.value.title && s.value.title.title) || '')
      }
    }
    return {
      sessions: (records || []).map((r) => {
        const h = r.header || {}
        return {
          id: h.id,
          title: titleOf.get(h.id) || '',
          live: Boolean(r.live),
          persisted: Boolean(r.persisted),
          allow: (st.sessions[h.id] && st.sessions[h.id].allow !== undefined) ? st.sessions[h.id].allow : null
        }
      }),
      defaultAllow: st.defaults.allow
    }
  }

  // ---- HTTP 控制面 ----
  const token = randomBytes(16).toString('hex')
  const helper = new DashboardHelper({ ctx, dshHome: home, stateDir, token })
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

        // 外窗数据面（helper 反代携带共享 token）
        if (rest.startsWith('api/')) {
          if ((req.headers['x-dsh-dash-token'] || '') !== token) {
            return sendJson(res, 403, { ok: false, error: 'forbidden' })
          }
          const api = rest.slice(4)
          if (method === 'GET' && api === 'sessions') {
            return sendJson(res, 200, await sessionsPayload())
          }
          if (method === 'GET' && api === 'tools') {
            try {
              const known = ctx.tools.view(undefined).restrictableNames
              return sendJson(res, 200, { tools: [...known].sort() })
            } catch (e) {
              return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          }
          if (method === 'POST' && api === 'allow') {
            let body = {}
            try {
              body = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'invalid body' })
            }
            const sid = String(body.sessionId || '')
            const allow = body.allow === null
              ? null
              : Array.isArray(body.allow) ? body.allow.map(String) : null
            if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId 必填' })
            const st = readState()
            st.sessions = st.sessions || {}
            st.sessions[sid] = { ...(st.sessions[sid] || {}), allow }
            writeState(st)
            applyAllow(sid, allow)
            return sendJson(res, 200, { ok: true, sessionId: sid, allow })
          }
          if (method === 'POST' && api === 'clear') {
            let body = {}
            try {
              body = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'invalid body' })
            }
            const sid = String(body.sessionId || '')
            const compaction = ctx.get('compaction')
            if (compaction === undefined) {
              return sendJson(res, 200, { ok: false, error: '当前 DSH 组合未挂载压缩服务（compaction-basic 被禁用），清空不可用' })
            }
            const agent = liveAgents.get(sid)
            if (!agent) {
              return sendJson(res, 200, { ok: false, error: '会话未挂载（需先打开该会话）' })
            }
            try {
              const result = await compaction.compactNow(agent, undefined, 'dsh-dashboard')
              if (result === null) return sendJson(res, 200, { ok: true, compacted: 0, tokens: 0, message: '无可压缩历史' })
              return sendJson(res, 200, {
                ok: true,
                compacted: result.shadowedSeqs ? result.shadowedSeqs.length : 0,
                tokens: result.shadowedTokenCount || 0
              })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          }
          return sendJson(res, 404, { ok: false, error: 'not found' })
        }

        // 页面内控制（同源；无 token）
        if (method === 'GET' && rest === 'state') {
          return sendJson(res, 200, { on: readMaster(), port: helper.port, downloading: helper.downloading })
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

  // ---- 生命周期：插件卸载 / DSH 退出 → 杀 helper（崩溃由 helper 看门狗兜底）----
  ctx.effect(() => () => {
    helper.stop('dsh-dispose')
  })

  log('已启动（独立数据面：DSH 会话 / tools.restrict / compaction）')
}
