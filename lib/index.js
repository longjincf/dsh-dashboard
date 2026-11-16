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
export const inject = ['webServer', 'sessionQuery', 'tools', 'tokenMeter']

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

  // ---- 插件状态（console.json：默认预算/白名单 + 每会话预算/白名单）----
  const readState = () => {
    try {
      const v = JSON.parse(readFileSync(consolePath, 'utf8'))
      return {
        defaults: { allow: null, budget: null, ...(v.defaults || {}) },
        sessions: v.sessions || {},
        selectedSessionId: typeof v.selectedSessionId === 'string' ? v.selectedSessionId : null
      }
    } catch {
      return { defaults: { allow: null, budget: null }, sessions: {}, selectedSessionId: null }
    }
  }
  const writeState = (s) => writeFileSync(consolePath, JSON.stringify(s, null, 2))
  const readMaster = () => {
    try { return Boolean(JSON.parse(readFileSync(masterPath, 'utf8')).on) } catch { return false }
  }
  const writeMaster = (on) => writeFileSync(masterPath, JSON.stringify({ on: Boolean(on) }))

  // ---- 活 agent 跟踪：sessionId → agent / restrict+guard 清理器 ----
  const liveAgents = new Map()
  const liveRestricts = new Map()

  // agent 解析：优先本次插件生命周期内创建的；兜底从 agents 注册表取（覆盖插件加载前已存在的 agent）
  const resolveAgent = (sid) => {
    if (liveAgents.has(sid)) return liveAgents.get(sid)
    try {
      const registry = ctx.get('agents')
      const agent = registry && registry.get(sid)
      if (agent) liveAgents.set(sid, agent)
      return agent || null
    } catch {
      return null
    }
  }

  const applyAllow = (sessionId, allow) => {
    const old = liveRestricts.get(sessionId)
    try { old?.() } catch { /* 已随 agent 释放 */ }
    liveRestricts.delete(sessionId)
    const agent = resolveAgent(sessionId)
    if (!agent) return
    if (allow === null || allow === undefined) return // 不限制（全部可用）
    const list = Array.isArray(allow) ? allow.map(String) : []
    const disposers = []
    // 1) 全局工具：restrict 隐藏未入选的全局工具（own 注册豁免 restrict，须过滤名字防抛错）
    try {
      const view = agent.ctx.tools.view(agent)
      const restrictable = [...view.restrictableNames]
      const globalPart = list.filter((n) => restrictable.includes(n))
      disposers.push(agent.ctx.tools.restrict({ allow: globalPart }))
    } catch (e) {
      log(`restrict 失败 session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // 2) 全部工具（含 agent 作用域注册的 read/write/bash 等）：执行期 guard 拒止
    try {
      disposers.push(agent.ctx.tools.guard((exec) => {
        const n = exec && exec.name
        if (!n) return undefined
        return list.includes(n) ? undefined : '被会话白名单禁用（dsh-dashboard）'
      }))
    } catch (e) {
      log(`guard 失败 session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    }
    liveRestricts.set(sessionId, () => {
      for (const d of disposers) {
        try { d() } catch { /* 静默 */ }
      }
    })
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

  // 启动清扫：给插件加载前已存在的 agent 套用已存白名单（agents 注册表 list）
  const sweepAgents = () => {
    try {
      const registry = ctx.get('agents')
      const list = registry && registry.list ? registry.list() : []
      for (const agent of list || []) {
        const sid = agent && agent.session && agent.session.id
        if (!sid) continue
        if (!liveAgents.has(sid)) liveAgents.set(sid, agent)
        const st = readState()
        const allow = (st.sessions[sid] && st.sessions[sid].allow !== undefined)
          ? st.sessions[sid].allow
          : (st.defaults.allow !== undefined ? st.defaults.allow : null)
        if (allow !== null && allow !== undefined) applyAllow(sid, allow)
      }
    } catch { /* 注册表不可用则跳过 */ }
  }
  setTimeout(sweepAgents, 0)

  // ---- 每会话 token 预算：pre-step 超限自动压缩（DSH 原生等价于代理记忆层阈值）----
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      const sid = agent && agent.session && agent.session.id
      if (!sid) return next()
      const st = readState()
      const budget = (st.sessions[sid] && st.sessions[sid].budget !== undefined)
        ? st.sessions[sid].budget
        : (st.defaults.budget !== undefined ? st.defaults.budget : null)
      if (!budget) return next()
      const compaction = ctx.get('compaction')
      if (compaction === undefined) return next() // 无压缩服务：预算仅作展示
      const measurement = ctx.tokenMeter.measure(agent.session)
      if (!measurement || typeof measurement.totalTokens !== 'number') return next()
      if (measurement.totalTokens >= budget) {
        log(`预算触发：session=${sid} ${measurement.totalTokens} >= ${budget} → compactNow`)
        await compaction.compactNow(agent, signal, 'dsh-dashboard-budget')
      }
    } catch {
      // 预算检查失败不阻断步骤
    }
    return next()
  })

  // ---- 会话数据负载（helper 反代取数用；4s 缓存：281 会话标题折叠冷读 ~10s，不能每 5s 全量重算）----
  let payloadCache = null // { payload, at }
  const sessionsPayload = async () => {
    const now = Date.now()
    if (payloadCache && now - payloadCache.at < 4000) return payloadCache.payload
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
    const payload = {
      sessions: (records || []).map((r) => {
        const h = r.header || {}
        return {
          id: h.id,
          title: titleOf.get(h.id) || '',
          live: Boolean(r.live),
          persisted: Boolean(r.persisted),
          allow: (st.sessions[h.id] && st.sessions[h.id].allow !== undefined) ? st.sessions[h.id].allow : null,
          budget: (st.sessions[h.id] && st.sessions[h.id].budget !== undefined) ? st.sessions[h.id].budget : null
        }
      }),
      defaultAllow: st.defaults.allow,
      defaultBudget: st.defaults.budget,
      selectedSessionId: st.selectedSessionId
    }
    payloadCache = { payload, at: Date.now() }
    return payload
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
          if (method === 'GET' && api.startsWith('tools')) {
            // 目录：多源并集（显示层尽力完整；执法不依赖此目录）
            //  - 全局 view 可见工具
            //  - 指定活会话：该 agent 作用域 view（含 read/write/bash 等 own 注册）+ 会话请求头 tools
            //  - 未指定会话：并集全部活 agent 的工具（默认白名单区可用完整目录）
            const sid = String(url.searchParams.get('sessionId') || '')
            try {
              const names = new Set()
              const gv = ctx.tools.view(undefined)
              for (const n of gv.visible.keys()) names.add(n)
              const collectAgent = (agent) => {
                if (!agent) return
                try {
                  const av = agent.ctx.tools.view(agent)
                  for (const n of av.visible.keys()) names.add(n)
                } catch { /* 忽略来源 */ }
                try {
                  const hdr = agent.session.requestHeader && agent.session.requestHeader()
                  const t = hdr && hdr.tools
                  if (Array.isArray(t)) {
                    for (const x of t) names.add(typeof x === 'string' ? x : (x && x.name))
                  }
                } catch { /* 忽略来源 */ }
              }
              if (sid) {
                collectAgent(resolveAgent(sid))
              } else {
                try {
                  const registry = ctx.get('agents')
                  const list = registry && registry.list ? registry.list() : []
                  for (const agent of list || []) collectAgent(agent)
                } catch { /* 注册表不可用 */ }
              }
              return sendJson(res, 200, { tools: [...names].filter(Boolean).sort() })
            } catch (e) {
              return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          }
          if (method === 'GET' && api.startsWith('usage')) {
            const sid = String(url.searchParams.get('sessionId') || '')
            let session = null
            const agent = resolveAgent(sid)
            if (agent) {
              session = agent.session
            } else {
              // 兜底：live 但暂无活跃 agent 的会话（agent 创建于插件加载前）也能测用量
              try { session = ctx.get('sessions')?.get(sid) || null } catch { session = null }
            }
            if (!session) return sendJson(res, 200, { ok: false, error: '会话未挂载（需先打开该会话）' })
            try {
              const measurement = ctx.tokenMeter.measure(session)
              const st = readState()
              const budget = (st.sessions[sid] && st.sessions[sid].budget !== undefined)
                ? st.sessions[sid].budget
                : (st.defaults.budget !== undefined ? st.defaults.budget : null)
              return sendJson(res, 200, {
                ok: true,
                tokens: measurement ? measurement.totalTokens : null,
                budget
              })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          }
          if (method === 'POST' && api === 'budget') {
            let body = {}
            try {
              body = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'invalid body' })
            }
            const sid = String(body.sessionId || '')
            const budget = body.budget === null
              ? null
              : (Number.isInteger(body.budget) && body.budget >= 1024 && body.budget <= 1048576 ? body.budget : undefined)
            if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId 必填' })
            if (budget === undefined) return sendJson(res, 400, { ok: false, error: 'budget 需为 1024~1048576（1M）整数或 null' })
            const st = readState()
            st.sessions = st.sessions || {}
            st.sessions[sid] = { ...(st.sessions[sid] || {}), budget }
            writeState(st)
            return sendJson(res, 200, { ok: true, sessionId: sid, budget })
          }
          if (method === 'POST' && api === 'select') {
            // 齿轮弹窗输入框：按会话 ID（精确/前缀）或标题（包含）匹配，持久化选中
            let body = {}
            try {
              body = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'invalid body' })
            }
            const q = String(body.query || '').trim()
            const cached = payloadCache && (Date.now() - payloadCache.at < 4000)
              ? payloadCache.payload
              : await sessionsPayload()
            const list = cached.sessions || []
            let match = null
            if (q) {
              match = list.find((s) => s.id === q)
                || list.find((s) => s.id.startsWith(q))
                || list.find((s) => s.title && s.title.includes(q))
            }
            if (!match) return sendJson(res, 200, { ok: false, error: '未匹配到会话（请按标题或 ID 输入）' })
            const st = readState()
            st.selectedSessionId = match.id
            writeState(st)
            return sendJson(res, 200, { ok: true, id: match.id, title: match.title || '' })
          }
          if (method === 'POST' && api === 'defaults') {
            let body = {}
            try {
              body = JSON.parse((await readBody(req)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'invalid body' })
            }
            const st = readState()
            if ('allow' in body) {
              st.defaults.allow = body.allow === null ? null : (Array.isArray(body.allow) ? body.allow.map(String) : st.defaults.allow)
            }
            if ('budget' in body) {
              const b = body.budget
              if (b === null) st.defaults.budget = null
              else if (Number.isInteger(b) && b >= 1024 && b <= 1048576) st.defaults.budget = b
              else return sendJson(res, 400, { ok: false, error: 'budget 需为 1024~1048576（1M）整数或 null' })
            }
            writeState(st)
            return sendJson(res, 200, { ok: true, defaults: st.defaults })
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
          const st = readState()
          let selected = null
          if (st.selectedSessionId) {
            try {
              const snap = await ctx.sessionQuery.readTitleSnapshot(st.selectedSessionId)
              selected = { id: st.selectedSessionId, title: snap && snap.title ? snap.title.title : '' }
            } catch {
              selected = { id: st.selectedSessionId, title: '' }
            }
          }
          return sendJson(res, 200, { on: readMaster(), port: helper.port, downloading: helper.downloading, selected })
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
