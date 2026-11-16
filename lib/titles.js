// dsh-dashboard 宿主侧：会话标题映射同步
//
// 链路（02.0.5 §2.5，代理侧已实证部署）：
//   代理为新会话播种 first_user（首条用户消息前 30 字）；
//   DSH 重命名 → title-gen 请求被代理捕获 → 新标题写入 __titles__；
//   宿主轮询：DSH 标题 ≠ 代理标题 → POST /admin/titles（代理拒收恒等映射，宿主再过滤一道）；
//             代理无该会话 → POST /admin/backfill 兜底（指纹反查）。
//   显示回退链（代理 /admin/sessions 已算好）：__titles__[first_user] → first_user → conv。

/** 与代理 msg_text 一致：text 块用 "\n" 连接。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text')
      .map((p) => p.text || '')
      .join('\n')
  }
  return ''
}

/** readSession 事件流里取首条用户消息文本。 */
function firstUserOf(events) {
  for (const ev of events || []) {
    if (ev && ev.type === 'user/message') {
      const text = contentText(ev.data && ev.data.content)
      if (text) return text
    }
  }
  return null
}

async function postJson(baseUrl, path, body) {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000)
  })
  return r
}

export function startTitleSync({ ctx, adminBase, pollMs, onDegraded, logger }) {
  let timer = null
  let inFlight = false
  const log = (m) => { try { logger?.info?.(`[dsh-dashboard] ${m}`) } catch { /* 静默 */ } }

  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      // 1. 代理侧会话表
      let proxyList = []
      const proxyResp = await fetch(adminBase + '/admin/sessions', { signal: AbortSignal.timeout(4000) })
      if (!proxyResp.ok) throw new Error(`proxy HTTP ${proxyResp.status}`)
      const proxyJson = await proxyResp.json()
      proxyList = Array.isArray(proxyJson.sessions) ? proxyJson.sessions : []
      onDegraded?.(false)

      const proxyByFirst = new Map()
      for (const s of proxyList) {
        const fu = String(s.first_user || '').trim()
        if (fu) proxyByFirst.set(fu, s)
      }

      // 2. DSH 侧：全部会话标题 + 首条用户消息
      const records = await ctx.sessionQuery.listSessions()
      const ids = (records || []).map((r) => r && r.header && r.header.id).filter(Boolean)
      if (!ids.length) return
      const snaps = await ctx.sessionQuery.readTitleSnapshots(ids)
      const titleMap = {}
      const backfills = []
      for (const snap of snaps || []) {
        if (!snap || snap.status !== 'fulfilled' || !snap.value) continue
        const header = snap.value.session
        const title = snap.value.title && snap.value.title.title
        const sessionId = header && header.id
        if (!sessionId || !title) continue
        let firstUser = null
        try {
          const { events } = await ctx.sessionQuery.readSession(sessionId)
          firstUser = firstUserOf(events)
        } catch {
          continue
        }
        if (!firstUser) continue
        firstUser = firstUser.slice(0, 30)
        const proxyEntry = proxyByFirst.get(firstUser)
        if (proxyEntry) {
          // 恒等映射是噪音：代理拒收 key==value；宿主侧再过滤一道（双保险）
          if (title !== firstUser && proxyEntry.title !== title) titleMap[firstUser] = title
        } else if (title !== firstUser) {
          // 恒等值不入 __titles__：显示回退链本就落到 first_user，写回是噪音
          backfills.push({ first_user: firstUser, title })
        }
      }

      // 3. 写回 / 回填（失败静默，下轮重试）
      const mapKeys = Object.keys(titleMap)
      if (mapKeys.length) {
        try {
          const r = await postJson(adminBase, '/admin/titles', { map: titleMap })
          if (!r.ok) log(`titles 写回失败 HTTP ${r.status}`)
        } catch (e) {
          log(`titles 写回异常：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      for (const b of backfills) {
        try {
          const r = await postJson(adminBase, '/admin/backfill', b)
          if (!r.ok) log(`backfill 失败 HTTP ${r.status}`)
        } catch (e) {
          log(`backfill 异常：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      // 代理不可达 / DSH 查询异常：静默降级，不重试风暴
      onDegraded?.(true)
      try { logger?.debug?.(`[dsh-dashboard] 轮询降级：${e instanceof Error ? e.message : String(e)}`) } catch { /* 静默 */ }
    } finally {
      inFlight = false
    }
  }

  timer = setInterval(tick, pollMs)
  timer.unref?.()
  tick()
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
