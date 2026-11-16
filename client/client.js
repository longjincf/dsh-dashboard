/**
 * dsh-dashboard — 会话控制台（浏览器端壳，简化双模式）。
 * 模式：dot（小齿轮 ⚙）与 外窗（helper 桌宠窗）。
 * ⚙ 弹窗：打开外窗 / 关闭控制台 / 完全关闭说明。
 * 关闭后两种模式全消失，仅"控制台设置"页可重新开启。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dashboard',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const { useState, useEffect, useRef } = react
    const h = react.createElement

    const NS = 'dsh-dashboard'
    const STYLE_ID = 'dshdash-css'
    const LS_DOT = 'dshdash:dot-pos'

    function getLS(k) { try { return localStorage.getItem(k) } catch { return null } }
    function setLS(k, v) { try { localStorage.setItem(k, v) } catch {} }

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const css = `
.dshdash-dot{position:fixed;-webkit-app-region:no-drag;z-index:2147483000;right:18px;bottom:18px;width:34px;height:34px;border-radius:50%;
  background:rgba(18,21,28,.9);border:1px solid rgba(255,255,255,.16);cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:15px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.dshdash-popup{position:fixed;z-index:2147483001;min-width:190px;border-radius:10px;background:rgba(22,26,35,.97);
  border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 34px rgba(0,0,0,.5);padding:5px;font-size:12.5px;color:#d8dde8}
.dshdash-popup .mi{padding:7px 10px;border-radius:7px;cursor:pointer}
.dshdash-popup .mi:hover{background:rgba(79,140,255,.15)}
.dshdash-popup .mi.danger{color:#f0a0a8}
.dshdash-popup .mi.danger:hover{background:rgba(224,96,108,.15)}
.dshdash-popup .mi.hint{color:#8b93a5;cursor:default;font-size:11.5px}
.dshdash-popup .mi.hint:hover{background:transparent}
`
      const st = document.createElement('style')
      st.id = STYLE_ID
      st.textContent = css
      document.head.appendChild(st)
    }

    function Dash() {
      const [dotPos, setDotPos] = useState(() => { try { return JSON.parse(getLS(LS_DOT)) } catch { return null } })
      const [popup, setPopup] = useState(null)
      const [masterOn, setMasterOn] = useState(true)
      const dragRef = useRef(null)
      const movedRef = useRef(false)

      const clamp = (x, y) => ({
        x: Math.min(Math.max(x, 4), window.innerWidth - 48),
        y: Math.min(Math.max(y, 4), window.innerHeight - 48),
      })

      const openExternal = () => {
        setPopup(null)
        fetch('/dsh-dashboard/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).then(r => r.json()).then(d => {
          if (d.starting) alert(d.message || '首次启动需准备 Electron，完成后自动弹出，请稍后再次点击')
          else if (!d.opened) alert('启动失败：' + (d.error || '未知原因'))
        }).catch(() => alert('启动请求失败'))
      }

      const masterOff = () => {
        setPopup(null)
        fetch('/dsh-dashboard/master', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ on: false }),
        }).then(r => r.json()).then(d => { if (d.masterOn === false) setMasterOn(false) })
          .catch(() => alert('关闭失败，请到 控制台设置 关闭'))
      }

      // 轮询总开关（关闭则 ⚙ 也消失；唯一开启入口 = 控制台设置）
      useEffect(() => {
        const reload = () => {
          fetch('/dsh-dashboard/status').then(r => r.json()).then(d => {
            if (typeof d.masterOn === 'boolean') setMasterOn(d.masterOn)
          }).catch(() => {})
        }
        reload()
        const t = setInterval(reload, 5000)
        return () => clearInterval(t)
      }, [])

      // ⚙ 拖动
      const startDrag = (e) => {
        e.preventDefault(); e.stopPropagation()
        const el = dragRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const base = dotPos || { x: rect.left, y: rect.top }
        const sx = e.clientX - base.x, sy = e.clientY - base.y
        movedRef.current = false
        const move = (ev) => {
          ev.preventDefault(); ev.stopPropagation()
          if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) movedRef.current = true
          const p = clamp(ev.clientX - sx, ev.clientY - sy)
          setDotPos(p)
          try { setLS(LS_DOT, JSON.stringify(p)) } catch {}
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      const dotClick = () => {
        if (movedRef.current) { movedRef.current = false; return }
        const el = dragRef.current
        const r = el ? el.getBoundingClientRect() : { left: window.innerWidth - 60, top: window.innerHeight - 60 }
        setPopup({ x: Math.max(8, r.left - 190), y: r.top - 8 })
      }

      if (!masterOn) return null   // 总开关关闭：仅"控制台设置"可开启

      const st = dotPos ? { left: dotPos.x + 'px', top: dotPos.y + 'px', right: 'auto', bottom: 'auto' } : null
      const popupNode = popup ? h('div', {
        className: 'dshdash-popup',
        style: { left: popup.x + 'px', top: popup.y + 'px' },
        onMouseLeave: () => setPopup(null),
      },
        h('div', { className: 'mi', onClick: openExternal }, '打开外窗'),
        h('div', { className: 'mi danger', onClick: masterOff }, '关闭控制台'),
        h('div', { className: 'mi hint' }, '关闭后仅在 设置 → 控制台设置 可重新开启'),
      ) : null
      return h('div', null,
        h('div', { className: 'dshdash-dot', ref: dragRef, style: st, onMouseDown: startDrag, onClick: dotClick, title: '会话控制台' }, '⚙'),
        popupNode)
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
          '会话控制台：小齿轮（⚙）+ 外窗（透明置顶桌宠窗）两种模式；管理本地（A机 Qwen）会话的上下文预算、工具白名单与清空操作。'),
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
