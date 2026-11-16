/**
 * dsh-dashboard — 会话控制台（浏览器端）。
 * shell.overlay 浮窗：可拖拽、可折叠，轮询宿主 /dsh-dashboard/* 控制会话预算/白名单/清空。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dashboard',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const { useState, useEffect, useRef, useCallback } = react
    const h = react.createElement

    const NS = 'dsh-dashboard'
    const STYLE_ID = 'dshdash-css'
    const LS_POS = 'dshdash:pos'
    const API = {
      status: '/dsh-dashboard/status',
      sessions: '/dsh-dashboard/sessions',
      context: '/dsh-dashboard/context',
      tools: '/dsh-dashboard/tools',
      clear: '/dsh-dashboard/clear',
      defaults: '/dsh-dashboard/defaults',
    }
    const ALL_TOOLS = ['read','bash','grep','glob','write','edit','run_mac_command','mac_memory_top10','web_search','ask_user_question']
    const PRESETS = [8192, 20480, 32768]

    function post(path, body) {
      return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(r => r.json())
    }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const css = `
.dshdash-root{position:fixed;-webkit-app-region:no-drag;z-index:2147483000;width:384px;font:13px/1.5 -apple-system,"PingFang SC",sans-serif;
  color:#e8ecf4;border-radius:14px;background:rgba(18,21,28,.88);backdrop-filter:blur(20px) saturate(1.2);
  border:1px solid rgba(255,255,255,.09);box-shadow:0 18px 50px rgba(0,0,0,.5);overflow:hidden;user-select:none}
.dshdash-head{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid rgba(255,255,255,.09);cursor:grab}
.dshdash-head:active{cursor:grabbing}
.dshdash-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dshdash-dot.on{background:#3ecf8e;box-shadow:0 0 8px #3ecf8e}
.dshdash-dot.off{background:#e0606c;box-shadow:0 0 8px #e0606c}
.dshdash-title{font-weight:600;font-size:14px;letter-spacing:.5px}
.dshdash-sub{font-size:11px;color:#8b93a5}
.dshdash-sp{flex:1}
.dshdash-ib{width:24px;height:24px;border-radius:7px;border:1px solid rgba(255,255,255,.09);background:transparent;color:#8b93a5;cursor:pointer;font-size:12px;line-height:1}
.dshdash-ib:hover{color:#e8ecf4;background:rgba(255,255,255,.06)}
.dshdash-tabs{display:flex;padding:8px 10px 0;gap:6px}
.dshdash-tab{flex:1;text-align:center;padding:7px 0;border-radius:9px;font-size:12.5px;color:#8b93a5;cursor:pointer;border:1px solid transparent}
.dshdash-tab.on{color:#9db9f5;background:rgba(79,140,255,.12);border-color:#4f8cff}
.dshdash-list{padding:8px 10px;display:flex;flex-direction:column;gap:6px;max-height:170px;overflow:auto}
.dshdash-sess{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:1px solid transparent;cursor:pointer}
.dshdash-sess:hover{background:rgba(255,255,255,.04)}
.dshdash-sess.on{border-color:#4f8cff;background:rgba(79,140,255,.10)}
.dshdash-av{width:30px;height:30px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(79,140,255,.15);color:#4f8cff;font-weight:700}
.dshdash-meta{flex:1;min-width:0}
.dshdash-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdash-meta2{font-size:11px;color:#8b93a5;display:flex;gap:8px}
.dshdash-detail{padding:12px 13px 10px;border-top:1px solid rgba(255,255,255,.09);background:rgba(28,32,42,.72)}
.dshdash-sec{font-size:11px;color:#8b93a5;letter-spacing:1.5px;margin:8px 0 6px;display:flex;align-items:center;gap:6px}
.dshdash-sec::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.09)}
.dshdash-slider{display:flex;align-items:center;gap:10px}
.dshdash-slider input{flex:1;accent-color:#4f8cff}
.dshdash-kv{font-size:13px;font-weight:700;color:#9db9f5;width:52px;text-align:right}
.dshdash-presets{display:flex;gap:6px;margin-top:8px}
.dshdash-preset{flex:1;padding:5px 0;border-radius:8px;border:1px solid rgba(255,255,255,.09);background:transparent;color:#8b93a5;font-size:12px;cursor:pointer}
.dshdash-preset.on{background:rgba(79,140,255,.15);color:#9db9f5;border-color:#4f8cff}
.dshdash-tools{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dshdash-tool{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.02);cursor:pointer}
.dshdash-tool .t{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdash-tool.off .t{color:#8b93a5}
.dshdash-sw{width:28px;height:16px;border-radius:99px;background:rgba(255,255,255,.14);position:relative;flex:none;transition:.2s}
.dshdash-sw::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.2s}
.dshdash-tool.on .dshdash-sw{background:#4f8cff}
.dshdash-tool.on .dshdash-sw::after{left:14px}
.dshdash-note{font-size:11px;color:#8b93a5;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:8px;padding:7px 9px;margin-top:6px}
.dshdash-clear{width:100%;margin-top:10px;padding:9px;border-radius:9px;border:1px solid rgba(224,96,108,.35);background:rgba(224,96,108,.08);color:#f0a0a8;font-size:12.5px;cursor:pointer}
.dshdash-clear.arm{background:#e0606c;color:#fff;border-color:#e0606c}
.dshdash-foot{display:flex;align-items:center;gap:10px;padding:9px 13px;border-top:1px solid rgba(255,255,255,.09);font-size:11px;color:#8b93a5}
.dshdash-menu{position:absolute;-webkit-app-region:no-drag;z-index:2147483001;min-width:180px;border-radius:10px;background:rgba(22,26,35,.96);
  border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 34px rgba(0,0,0,.5);padding:5px;font-size:12.5px}
.dshdash-menu .mi{padding:7px 10px;border-radius:7px;cursor:pointer;color:#d8dde8}
.dshdash-menu .mi:hover{background:rgba(79,140,255,.15)}
.dshdash-menu .mi.current{color:#9db9f5;font-weight:600}
.dshdash-menu .mi.hint{color:#8b93a5;cursor:default;font-size:11.5px}
.dshdash-menu .mi.hint:hover{background:transparent}
.dshdash-sec{cursor:pointer}
.dshdash-sec:hover{color:#c8cdd8}
.dshdash-caret{margin-right:2px;display:inline-block;transition:transform .15s}
.dshdash-caret.open{transform:rotate(90deg)}
.dshdash-restore{position:fixed;-webkit-app-region:no-drag;z-index:2147483000;right:18px;bottom:18px;width:34px;height:34px;border-radius:50%;
  background:rgba(18,21,28,.9);border:1px solid rgba(255,255,255,.16);cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:15px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.dshdash-pill{position:fixed;-webkit-app-region:no-drag;right:18px;top:18px;padding:8px 14px;border-radius:99px;
  background:rgba(18,21,28,.88);border:1px solid rgba(255,255,255,.12);color:#e8ecf4;font-size:12.5px;
  cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.4);display:flex;gap:8px;align-items:center}
.dshdash-cloud{color:#8b93a5;font-size:12px;padding:14px;text-align:center}
`
      const st = document.createElement('style')
      st.id = STYLE_ID
      st.textContent = css
      document.head.appendChild(st)
    }

    function Dash() {
      const [sessions, setSessions] = useState([])
      const [online, setOnline] = useState(false)
      const [tab, setTab] = useState('local')
      const [cur, setCur] = useState(null)
      const [folded, setFolded] = useState(true)
      const [armed, setArmed] = useState(false)
      const [pos, setPos] = useState(() => {
        try { return JSON.parse(localStorage.getItem(LS_POS)) } catch { return null }
      })
      const [menu, setMenu] = useState(null)
      const [hidden, setHidden] = useState(false)
      const [toolsOpen, setToolsOpen] = useState(false)
      const [defaults, setDefaults] = useState(null)
      const [defaultsOpen, setDefaultsOpen] = useState(false)
      const dragRef = useRef(null)
      const movedRef = useRef(false)

      const reloadDefaults = useCallback(() => {
        fetch(API.defaults).then(r => r.json()).then(d => setDefaults(d.defaults || null)).catch(() => {})
      }, [])
      const saveDefaults = useCallback((partial) => {
        post(API.defaults, partial).then(d => setDefaults(d.defaults || null))
      }, [])

      const reload = useCallback(() => {
        fetch(API.sessions).then(r => r.json()).then(d => {
          setOnline(true)
          const list = (d.sessions || []).map(s => ({ ...s, allowSet: s.allow === null ? ALL_TOOLS.slice() : s.allow }))
          setSessions(list)
          setCur(prev => prev && list.some(s => s.conv === prev.conv) ? list.find(s => s.conv === prev.conv) : (list[0] || null))
        }).catch(() => setOnline(false))
      }, [])

      useEffect(() => {
        reload()
        reloadDefaults()
        const t = setInterval(reload, 5000)
        return () => clearInterval(t)
      }, [reload, reloadDefaults])

      const startDrag = (e) => {
        // 阻断冒泡：DSH 壳有自己的窗口拖拽处理，不拦会把整个 DSH 拖走
        e.preventDefault()
        e.stopPropagation()
        // 按钮（⚙/—/⌂）不启动拖动
        if (e.target && e.target.tagName === 'BUTTON') return
        const el = dragRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const base = pos || { x: rect.left, y: rect.top }
        const sx = e.clientX - base.x, sy = e.clientY - base.y
        movedRef.current = false
        const clamp = (x, y) => ({
          x: Math.min(Math.max(x, 4), window.innerWidth - 48),
          y: Math.min(Math.max(y, 4), window.innerHeight - 48),
        })
        const move = (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) movedRef.current = true
          setPos(clamp(ev.clientX - sx, ev.clientY - sy))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          try { localStorage.setItem(LS_POS, JSON.stringify(pos)) } catch {}
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      const onDrag = startDrag

      const setLimit = (limit) => {
        if (!cur) return
        post(API.context, { conv: cur.conv, limit }).then(reload)
      }
      const toggleTool = (t) => {
        if (!cur) return
        const on = cur.allowSet.includes(t)
        const next = on ? cur.allowSet.filter(x => x !== t) : cur.allowSet.concat(t)
        post(API.tools, { conv: cur.conv, allow: next }).then(reload)
      }
      const callOpenExternal = () => {
        try { localStorage.setItem('dshdash:hidden', '1') } catch {}
        setHidden(true)
        fetch('/dsh-dashboard/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(r => r.json()).then(d => {
          if (d.starting) {
            alert(d.message || '首次启动需准备 Electron，完成后自动弹出，请稍后再次点击')
          } else if (!d.opened) {
            alert('启动失败：' + (d.error || '未知原因'))
            try { localStorage.setItem('dshdash:hidden', '0') } catch {}
            setHidden(false)
          }
        }).catch(() => {
          alert('启动请求失败')
          try { localStorage.setItem('dshdash:hidden', '0') } catch {}
          setHidden(false)
        })
      }

      const clearNow = () => {
        if (!cur) return
        if (!armed) { setArmed(true); return }
        setArmed(false)
        post(API.clear, { conv: cur.conv }).then(reload)
      }

      if (hidden) {
        return h('div', { className: 'dshdash-restore', title: '打开会话控制台',
          onClick: () => { try { localStorage.setItem('dshdash:hidden', '0') } catch {} setHidden(false) } }, '⚙')
      }

      if (folded) {
        return h('div', {
          className: 'dshdash-pill',
          ref: dragRef,
          onMouseDown: startDrag,
          title: '单击：打开独立窗口 / 双击：展开内嵌面板',
          style: pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' } : null,
          onClick: () => { if (movedRef.current) { movedRef.current = false; return } callOpenExternal() },
          onDoubleClick: () => { if (movedRef.current) { movedRef.current = false; return } setFolded(false) } },
          h('span', { className: 'dshdash-dot ' + (online ? 'on' : 'off') }), '会话控制台')
      }

      const listNodes = (tab === 'local' ? sessions : []).map(s => h('div', {
        className: 'dshdash-sess' + (cur && cur.conv === s.conv ? ' on' : ''),
        onClick: () => { setCur(s); setArmed(false) },
        key: s.conv,
      },
        h('div', { className: 'dshdash-av' }, (s.conv || '#')[0]),
        h('div', { className: 'dshdash-meta' },
          h('div', { className: 'dshdash-name' }, s.conv),
          h('div', { className: 'dshdash-meta2' },
            h('span', null, (s.limit || 20000) / 1024 + 'K'),
            h('span', null, (s.allowSet ? s.allowSet.length : ALL_TOOLS.length) + ' 工具'),
            h('span', null, (s.last_active || '').slice(11) || '—')))))

      const THINK_OPTS = [
        ['ds', '思考：跟随 DSH', null],
        ['off', '思考：off', { enabled: false }],
        ['minimal', '思考：minimal', { enabled: true, effort: 'min' }],
        ['low', '思考：low', { enabled: true, effort: 'low' }],
        ['medium', '思考：medium', { enabled: true, effort: 'med' }],
        ['high', '思考：high', { enabled: true, effort: 'high' }],
        ['max', '思考：max', { enabled: true, effort: 'max' }],
      ]
      const dNow = defaults || { limit: 20000, allow: null, thinking: null }
      const dAllow = dNow.allow === null ? ALL_TOOLS.slice() : dNow.allow
      const thinkKey = THINK_OPTS.find(o => JSON.stringify(o[2]) === JSON.stringify(dNow.thinking))
      const thinkLabel = thinkKey ? thinkKey[1] : '思考：跟随 DSH'
      let defaultsPanel = null
      if (tab === 'local') {
        defaultsPanel = h('div', { className: 'dshdash-detail', style: { borderBottom: '1px solid rgba(255,255,255,.09)' } },
          h('div', { className: 'dshdash-sec', onClick: () => setDefaultsOpen(o => !o) },
            h('span', { className: 'dshdash-caret' + (defaultsOpen ? ' open' : '') }, '\u25B8'),
            '默认模式（新会话/子agent）\u00B7 ' + (dNow.limit / 1024) + 'K \u00B7 ' + dAllow.length + ' 工具 \u00B7 ' + thinkLabel.slice(3)),
          defaultsOpen ? h('div', null,
            h('div', { className: 'dshdash-slider' },
              h('input', { type: 'range', min: 1024, max: 32768, step: 1024, value: dNow.limit,
                onChange: e => saveDefaults({ limit: +e.target.value }) }),
              h('span', { className: 'dshdash-kv' }, (dNow.limit / 1024) + 'K')),
            h('select', {
              style: { width: '100%', marginTop: 8, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,.09)', background: 'rgba(255,255,255,.04)', color: '#e8ecf4', fontSize: 12.5 },
              value: thinkKey ? thinkKey[0] : 'ds',
              onChange: e => { const o = THINK_OPTS.find(x => x[0] === e.target.value); saveDefaults({ thinking: o ? o[2] : null }) },
            }, THINK_OPTS.map(o => h('option', { value: o[0], key: o[0] }, o[1]))),
            h('div', { className: 'dshdash-tools', style: { marginTop: 8 } }, ALL_TOOLS.map(t => {
              const on = dAllow.includes(t)
              return h('div', { className: 'dshdash-tool ' + (on ? 'on' : 'off'), key: t, onClick: () => {
                const next = on ? dAllow.filter(x => x !== t) : dAllow.concat(t)
                saveDefaults({ allow: next })
              } }, h('span', { className: 't' }, t), h('span', { className: 'dshdash-sw' }))
            })),
          ) : null)
      }

      let detail = h('div', { className: 'dshdash-detail' },
        h('div', { className: 'dshdash-sec' }, '未选择会话'))
      if (tab === 'cloud') {
        detail = h('div', { className: 'dshdash-detail' },
          h('div', { className: 'dshdash-sec' }, '云端 · DeepSeek'),
          h('div', { className: 'dshdash-cloud' }, '云端数据源待接入 DSH 会话 API（M3）。当前仅本地（A机 Qwen）会话可控。'))
      } else if (cur) {
        const kv = cur.limit || 20000
        detail = h('div', { className: 'dshdash-detail' },
          h('div', { className: 'dshdash-sec' }, '上下文预算（动态）'),
          h('div', { className: 'dshdash-slider' },
            h('input', { type: 'range', min: 1024, max: 32768, step: 1024, value: kv,
              onChange: e => setLimit(+e.target.value) }),
            h('span', { className: 'dshdash-kv' }, (kv / 1024) + 'K')),
          h('div', { className: 'dshdash-presets' }, PRESETS.map(p => h('button', {
            className: 'dshdash-preset' + (p === kv ? ' on' : ''), key: p, onClick: () => setLimit(p),
          }, p === 8192 ? '8K' : p === 20480 ? '20K' : '32K'))),
          h('div', { className: 'dshdash-sec', onClick: () => setToolsOpen(o => !o) },
            h('span', { className: 'dshdash-caret' + (toolsOpen ? ' open' : '') }, '▸'),
            '工具白名单（' + cur.allowSet.length + '/' + ALL_TOOLS.length + ' 已启用）'),
          toolsOpen ? h('div', { className: 'dshdash-tools' }, ALL_TOOLS.map(t => {
            const on = cur.allowSet.includes(t)
            return h('div', { className: 'dshdash-tool ' + (on ? 'on' : 'off'), key: t, onClick: () => toggleTool(t) },
              h('span', { className: 't' }, t), h('span', { className: 'dshdash-sw' }))
          })) : null,
          h('button', { className: 'dshdash-clear' + (armed ? ' arm' : ''), onClick: clearNow },
            armed ? '再点一次确认清空（摘要+归档+预算归位）' : '清空该会话上下文'))
      }

      const menuNode = menu ? h('div', {
        className: 'dshdash-menu',
        style: { left: Math.min(menu.x, window.innerWidth - 200) + 'px', top: menu.y + 'px' },
        onMouseLeave: () => setMenu(null),
      },
        h('div', { className: 'mi current' }, '显示位置：DSH 内（当前）'),
        h('div', { className: 'mi', onClick: () => { setMenu(null); callOpenExternal() } }, '弹出独立窗口（DSH 外）'),
        h('div', { className: 'mi hint', onClick: () => { setMenu(null); try { navigator.clipboard.writeText(location.origin + '/dsh-dashboard/standalone') } catch {} } }, '弹窗被拦？点此复制地址用浏览器打开'),
        h('div', { className: 'mi', onClick: () => { setMenu(null); try { localStorage.setItem('dshdash:hidden', '1') } catch {} setHidden(true) } }, '隐藏浮窗'),
        h('div', { className: 'mi', onClick: () => { setMenu(null); try { localStorage.removeItem(LS_POS) } catch {} setPos(null) } }, '恢复默认位置'),
        h('div', { className: 'mi hint' }, '完全关闭：设置 → 插件 → 关闭 dsh-dashboard'),
      ) : null

      return h('div', {
        className: 'dshdash-root',
        ref: dragRef,
        style: pos ? { left: pos.x + 'px', top: pos.y + 'px' } : { right: '18px', bottom: '18px' },
        onContextMenu: (e) => {
          e.preventDefault()
          const rr = dragRef.current ? dragRef.current.getBoundingClientRect() : { left: 0, top: 0 }
          setMenu({ x: Math.min(Math.max(8, e.clientX - rr.left), 384 - 208), y: e.clientY - rr.top })
        },
      },
        h('div', { className: 'dshdash-head', onMouseDown: onDrag },
          h('span', { className: 'dshdash-dot ' + (online ? 'on' : 'off') }),
          h('span', { className: 'dshdash-title' }, '会话控制台'),
          h('span', { className: 'dshdash-sub' }, sessions.length + ' 会话'),
          h('span', { className: 'dshdash-sp' }),
          h('button', { className: 'dshdash-ib', onClick: () => setFolded(true) }, '—'),
          h('button', { className: 'dshdash-ib', onClick: (e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const rr = dragRef.current ? dragRef.current.getBoundingClientRect() : { left: 0, top: 0 }
            setMenu({ x: Math.min(Math.max(8, r.right - rr.left - 200), 384 - 208), y: r.bottom - rr.top + 6 })
          } }, '⚙'),
          h('button', { className: 'dshdash-ib', onClick: () => { try { localStorage.removeItem(LS_POS) } catch {} setPos(null) } }, '⌂')),
        h('div', { className: 'dshdash-tabs' },
          h('div', { className: 'dshdash-tab' + (tab === 'local' ? ' on' : ''), onClick: () => setTab('local') }, '本地 · A机 Qwen'),
          h('div', { className: 'dshdash-tab' + (tab === 'cloud' ? ' on' : ''), onClick: () => setTab('cloud') }, '云端 · DeepSeek')),
        h('div', { className: 'dshdash-list' },
          listNodes.length ? listNodes : h('div', { className: 'dshdash-cloud' }, '暂无会话（发一条消息后出现）')),
        defaultsPanel,
        detail,
        menuNode,
        h('div', { className: 'dshdash-foot', onMouseDown: startDrag, style: { cursor: 'grab' } },
          h('span', null, online ? 'A机控制面在线' : '控制面离线'),
          h('span', { className: 'dshdash-sp' }),
          h('span', null, 'llama_proxy /admin')))
    }

    function SettingsSection() {
      return h('div', { style: { padding: '16px 20px', fontSize: 13, lineHeight: 1.7, color: '#e8ecf4' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 8 } }, '会话控制台'),
        h('div', { style: { color: '#8b93a5' } },
          '管理本地（A机 Qwen）会话的上下文预算、工具白名单与清空操作；新会话自动继承默认模式。'),
        h('div', { style: { marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.09)' } },
          h('div', null, '控制面：', h('b', null, ' http://192.168.0.71:8080/admin')),
          h('div', null, '轮询间隔：5 秒'),
          h('div', { style: { color: '#8b93a5', marginTop: 6, fontSize: 12 } }, '完全关闭：在本页禁用 dsh-dashboard 插件；重新开启即恢复。')),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      injectStyle()
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: NS,
        label: () => NS,
      }, Dash)), NS + ': shell overlay')
      ctx.effect(() => ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: 'dshdash-config',
          order: 31,
          label: () => '会话控制台',
          inject: () => ({}),
        }, SettingsSection)
      }), NS + ': settings section')
    }

    exports.name = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
