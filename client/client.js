/**
 * dsh-dashboard — 会话控制台（浏览器端壳）。
 * 唯一 UI = client/standalone.html；本壳只负责五种模式：
 * dot(小图标⚙) / pill(胶囊) / panel(内嵌 iframe) —— 外窗/外部胶囊由 helper 进程承载。
 * 与 iframe 页面经 postMessage 通信（fold / open-external / hide-dot / drag）。
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
    const LS_DOT = 'dshdash:dot-pos'
    const LS_LAST = 'dshdash:lastMode'
    const LS_DESKTOP = 'dshdash:desktop'
    const FRAME_W = 392
    const FRAME_H = 680

    function getLS(k) { try { return localStorage.getItem(k) } catch { return null } }
    function setLS(k, v) { try { localStorage.setItem(k, v) } catch {} }
    function delLS(k) { try { localStorage.removeItem(k) } catch {} }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const css = `
.dshdash-pill{position:fixed;-webkit-app-region:no-drag;z-index:2147483000;right:18px;top:18px;padding:8px 14px;border-radius:99px;
  background:rgba(18,21,28,.88);border:1px solid rgba(255,255,255,.12);color:#e8ecf4;font-size:12.5px;
  cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.4);display:flex;gap:8px;align-items:center}
.dshdash-dot{position:fixed;-webkit-app-region:no-drag;z-index:2147483000;right:18px;bottom:18px;width:34px;height:34px;border-radius:50%;
  background:rgba(18,21,28,.9);border:1px solid rgba(255,255,255,.16);cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:15px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.dshdash-dotdot{width:8px;height:8px;border-radius:50%;flex:none}
.dshdash-dotdot.on{background:#3ecf8e;box-shadow:0 0 8px #3ecf8e}
.dshdash-dotdot.off{background:#e0606c;box-shadow:0 0 8px #e0606c}
.dshdash-frame{position:fixed;-webkit-app-region:no-drag;z-index:2147482999;width:392px;height:680px;border:none;background:transparent}
.dshdash-frame{width:100%;height:100%}
.dshdash-frame{position:static}
.dshdash-framewrap{position:fixed;-webkit-app-region:no-drag;z-index:2147482999;width:392px;height:680px}
.dshdash-dragstrip{position:absolute;top:10px;left:10px;right:152px;height:38px;cursor:grab;z-index:5;background:transparent;display:flex;align-items:center}
.dshdash-dragstrip:active{cursor:grabbing}
.dshdash-dragstrip::before{content:"⠿";font-size:14px;color:rgba(255,255,255,.25);padding-left:6px}
.dshdash-popup{position:fixed;z-index:2147483001;min-width:190px;border-radius:10px;background:rgba(22,26,35,.97);
  border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 34px rgba(0,0,0,.5);padding:5px;font-size:12.5px;color:#d8dde8}
.dshdash-popup .mi{padding:7px 10px;border-radius:7px;cursor:pointer}
.dshdash-popup .mi:hover{background:rgba(79,140,255,.15)}
.dshdash-popup .mi.hint{color:#8b93a5;cursor:default;font-size:11.5px}
.dshdash-popup .mi.hint:hover{background:transparent}
`
      const st = document.createElement('style')
      st.id = STYLE_ID
      st.textContent = css
      document.head.appendChild(st)
    }

    function Dash() {
      const [mode, setMode] = useState('pill')           // dot | pill | panel
      const applyMode = (m) => {
        setMode(m)
        try { window.dispatchEvent(new CustomEvent('dshdash:mode-sync', { detail: m })) } catch {}
      }
      useEffect(() => {
        const sync = (e) => { if (e && e.detail && (e.detail === 'dot' || e.detail === 'pill' || e.detail === 'panel')) setMode(e.detail) }
        window.addEventListener('dshdash:mode-sync', sync)
        return () => window.removeEventListener('dshdash:mode-sync', sync)
      }, [])
      const loadPos = (k) => {
        try {
          const p = JSON.parse(getLS(k))
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 24 && p.y > 24 && p.x < window.innerWidth && p.y < window.innerHeight) return p
        } catch {}
        return null
      }
      const [pos, setPos] = useState(() => loadPos(LS_POS))   // panel 位置
      const [pillPos, setPillPos] = useState(() => loadPos('dshdash:pill-pos'))
      const [dotPos, setDotPos] = useState(() => { try { return JSON.parse(getLS(LS_DOT)) } catch { return null } })
      const [popup, setPopup] = useState(null)           // ⚙ 弹窗 {x,y}
      const [online, setOnline] = useState(false)
      const [masterOn, setMasterOn] = useState(true)
      const dragRef = useRef(null)
      const frameRef = useRef(null)
      const movedRef = useRef(false)
      const offsetRef = useRef(null)
      const desktopPrevRef = useRef(null)

      const lastMode = () => getLS(LS_LAST)
      const clamp = (x, y) => ({
        x: Math.min(Math.max(x, 4), window.innerWidth - 48),
        y: Math.min(Math.max(y, 4), window.innerHeight - 48),
      })

      const openExternal = useCallback(() => {
        setLS(LS_DESKTOP, '1')
        setLS(LS_LAST, 'external')
        applyMode('dot')
        fetch('/dsh-dashboard/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(r => r.json()).then(d => {
          if (d.starting) {
            alert(d.message || '首次启动需准备 Electron，完成后自动弹出，请稍后再次点击')
          } else if (!d.opened) {
            alert('启动失败：' + (d.error || '未知原因'))
            applyMode('pill')
          }
        }).catch(() => { alert('启动请求失败'); applyMode('pill') })
      }, [])

      // iframe 页面 → 壳 通信
      useEffect(() => {
        const onMsg = (e) => {
          const m = e.data
          if (!m || typeof m.type !== 'string' || m.source !== 'dshdash') return
          if (m.type === 'fold') { applyMode('pill'); setLS(LS_LAST, 'internal') }
          else if (m.type === 'open-external') openExternal()
          else if (m.type === 'hide-dot') applyMode('dot')
          else if (m.type === 'dragStart') {
            const el = frameRef.current
            const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 }
            offsetRef.current = { x: m.x - r.left, y: m.y - r.top }
          } else if (m.type === 'drag') {
            if (!offsetRef.current) return
            setPos(clamp(m.x - offsetRef.current.x, m.y - offsetRef.current.y))
          }
        }
        window.addEventListener('message', onMsg)
        return () => window.removeEventListener('message', onMsg)
      }, [pos, openExternal])

      // 轮询 desktop 状态：外窗关闭 → 自动进内嵌面板
      const reload = useCallback(() => {
        fetch('/dsh-dashboard/sessions').then(r => r.json()).then(d => {
          setOnline(true)
          if (typeof d.masterOn === 'boolean') setMasterOn(d.masterOn)
          if (typeof d.desktop === 'boolean') {
            const prev = desktopPrevRef.current
            desktopPrevRef.current = d.desktop
            if (prev === true && d.desktop === false && getLS(LS_DESKTOP) === '1') {
              delLS(LS_DESKTOP)
              setLS(LS_LAST, 'internal')
              applyMode('panel')
            }
          }
        }).catch(() => setOnline(false))
      }, [])

      useEffect(() => {
        reload()
        const t = setInterval(reload, 5000)
        return () => clearInterval(t)
      }, [reload])

      // 胶囊/⚙ 拖动（parent 侧）
      const startDrag = (e) => {
        e.preventDefault(); e.stopPropagation()
        if (e.target && e.target.tagName === 'BUTTON') return
        const el = dragRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const base = (mode === 'dot' ? dotPos : (mode === 'pill' ? pillPos : pos)) || { x: rect.left, y: rect.top }
        const sx = e.clientX - base.x, sy = e.clientY - base.y
        movedRef.current = false
        const move = (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) movedRef.current = true
          const p = clamp(ev.clientX - sx, ev.clientY - sy)
          if (!masterOn) return null   // 总开关关闭：五种模式全部消失（设置页可重新开启）

      if (mode === 'dot') { setDotPos(p); try { setLS(LS_DOT, JSON.stringify(p)) } catch {} }
          else if (mode === 'pill') { setPillPos(p); try { setLS('dshdash:pill-pos', JSON.stringify(p)) } catch {} }
          else setPos(p)
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          if (mode === 'dot') { try { setLS(LS_DOT, JSON.stringify(dotPos)) } catch {} }
          else { try { setLS(LS_POS, JSON.stringify(pos)) } catch {} }
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      const enterPanel = () => {
        // 与外窗互斥：进内嵌前杀掉 helper（若在跑）
        fetch('/dsh-dashboard/switch-to-internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {})
        setLS(LS_LAST, 'internal')
        applyMode('panel')
      }

      const dotClick = () => {
        const el = dragRef.current
        const r = el ? el.getBoundingClientRect() : { left: window.innerWidth - 60, bottom: 24 }
        setPopup({ x: Math.max(8, r.left - 190), y: r.top - 6 })
      }

      if (mode === 'dot') {
        const st = dotPos ? { left: dotPos.x + 'px', top: dotPos.y + 'px', right: 'auto', bottom: 'auto' } : null
        const popupNode = popup ? h('div', {
          className: 'dshdash-popup',
          style: { left: popup.x + 'px', top: popup.y + 'px' },
          onMouseLeave: () => setPopup(null),
        },
          h('div', { className: 'mi', onClick: () => { setPopup(null); enterPanel() } }, '进入内嵌模式'),
          h('div', { className: 'mi', onClick: () => { setPopup(null); openExternal() } }, '打开外窗'),
          h('div', { className: 'mi hint' }, '完全关闭：设置 → 插件 → 关闭 dsh-dashboard'),
        ) : null
        return h('div', null,
          h('div', { className: 'dshdash-dot', ref: dragRef, style: st, onMouseDown: startDrag, onClick: dotClick, title: '设置' }, '⚙'),
          popupNode)
      }

      if (mode === 'pill') {
        const st = pillPos ? { left: pillPos.x + 'px', top: pillPos.y + 'px', right: 'auto', bottom: 'auto' } : null
        return h('div', {
          className: 'dshdash-pill',
          ref: dragRef,
          onMouseDown: startDrag,
          style: st,
          title: '单击：外窗/内嵌（按上次模式）',
          onClick: () => {
            if (movedRef.current) { movedRef.current = false; return }
            if (lastMode() === 'internal') { enterPanel() }
            else openExternal()
          },
        }, h('span', { className: 'dshdash-dotdot ' + (online ? 'on' : 'off') }), '会话控制台')
      }

      // panel：父壳拖拽条 + iframe（拖拽逻辑在父壳，不依赖 iframe 事件转发）
      const st = pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' } : { right: '18px', bottom: '18px' }
      const panelDrag = (e) => {
        e.preventDefault(); e.stopPropagation()
        const el = frameRef.current
        const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 }
        const base = pos || { x: r.left, y: r.top }
        const sx = e.clientX - base.x, sy = e.clientY - base.y
        const move = (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          setPos(clamp(ev.clientX - sx, ev.clientY - sy))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          try { setLS(LS_POS, JSON.stringify(pos)) } catch {}
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }
      return h('div', { className: 'dshdash-framewrap', ref: frameRef, style: st },
        h('div', { className: 'dshdash-dragstrip', onMouseDown: panelDrag }),
        h('iframe', { className: 'dshdash-frame', src: '/dsh-dashboard/standalone' }))
    }

    function SettingsSection() {
      const [on, setOn] = useState(null)
      const [msg, setMsg] = useState('')
      useEffect(() => {
        fetch('/dsh-dashboard/status').then(r => r.json()).then(d => { if (typeof d.masterOn === 'boolean') setOn(d.masterOn) }).catch(() => {})
      }, [])
      const setMaster = (v) => {
        fetch('/dsh-dashboard/master', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: v }) })
          .then(r => r.json()).then(d => { setOn(d.masterOn); setMsg('') }).catch(() => setMsg('操作失败'))
      }
      const openExt = () => {
        fetch('/dsh-dashboard/open-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
          .then(r => r.json()).then(d => { if (d.starting) setMsg(d.message || '准备中') ; else if (!d.opened) setMsg('启动失败：' + (d.error || '')) ; else setMsg('') })
          .catch(() => setMsg('启动失败'))
      }
      const btn = { padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(0,0,0,.18)', background: '#2f6fe4', color: '#fff', cursor: 'pointer', fontSize: 13 }
      return h('div', { style: { padding: '16px 20px', fontSize: 13, lineHeight: 1.7, color: '#16181d' } },
        h('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 8, color: '#0e1013' } }, '控制台设置'),
        h('div', { style: { color: '#4a5160' } },
          '管理本地（A机 Qwen）会话的上下文预算、工具白名单与清空操作；新会话自动继承默认模式。'),
        h('div', { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', null, '总开关：', h('b', null, on === null ? '…' : (on ? '已开启' : '已关闭'))),
          on === true ? h('button', { style: btn, onClick: () => setMaster(false) }, '关闭控制台')
                      : h('button', { style: btn, onClick: () => setMaster(true) }, '开启控制台'),
          h('button', { style: btn, onClick: openExt }, '打开外窗')),
        h('div', { style: { marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(0,0,0,.03)', border: '1px solid rgba(0,0,0,.1)' } },
          h('div', null, '控制面：', h('b', null, ' http://192.168.0.71:8080/admin')),
          h('div', null, '轮询间隔：5 秒'),
          h('div', { style: { color: '#4a5160', marginTop: 6, fontSize: 12 } }, '硬关闭：DSH 插件管理里禁用 dsh-dashboard；重新开启即恢复。')),
        msg ? h('div', { style: { color: '#b26a00', marginTop: 8 } }, msg) : null,
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
          label: () => '控制台设置',
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
