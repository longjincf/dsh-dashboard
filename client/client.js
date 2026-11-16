/**
 * dsh-dashboard · 浏览器侧客户端插件（单文件、纯 JS、无构建步骤）
 *
 * 功能规格版本：02.0.4
 *
 * 功能清单：
 *   A. shell.overlay「⚙ 小齿轮」(id: dsh-dashboard-gear)
 *      - 34px 白色齿轮圆钮，锚定窗口右下角；支持拖拽（window 级 pointer 事件），
 *        位移 <5px 判定为单击；拖动结束位置写回 localStorage（dshdash:dot-pos）
 *      - 单击弹出齿轮上方小卡片：「打开外窗」/「关闭控制台」/ 提示文案
 *      - 仅宿主 master.on=true 时显示；组件内每 2s 轮询 GET state
 *   B. settings.section「控制台设置」(id: dsh-dashboard-config)
 *      - 总开关（role=switch，ON/OFF 文案）→ POST set-master
 *      - 「打开外窗」按钮 → POST open，含 准备中/下载中 状态与错误提示
 *      - 三行信息：控制面地址 / 轮询间隔 / 清理提示；每 2s 轮询同步状态
 *   C. 通用：CSS 经 ctx.effect 注入（主题 token + 兜底值）；无外部 UI 库/CDN；
 *      无 JSX；不向 document.body 挂节点；所有定时器/监听器在 cleanup 清理
 */
(function () {
  "use strict";

  /* ================================================================== */
  /* 一、常量与纯工具（模块级，不依赖 React）                            */
  /* ================================================================== */

  /** 宿主 HTTP 路由段（与宿主侧路由契约一致，勿改） */
  const ROUTE_SEGMENT = "/dsh-dashboard";

  /** 齿轮位置记忆的 localStorage key */
  const POS_KEY = "dshdash:dot-pos";

  /** 默认位置：距窗口右下角 24px */
  const DEFAULT_POS = { x: 24, y: 24 };

  /** 齿轮直径（px），拖拽 clamp 计算使用 */
  const GEAR_SIZE = 34;

  /** 与视口边缘的最小间距（px） */
  const EDGE_MIN = 8;

  /** 单击/拖动判定阈值（px） */
  const CLICK_THRESHOLD = 5;

  /** 状态轮询间隔（固定 2s） */
  const POLL_INTERVAL = 2000;

  /**
   * 从页面 baseURI 提取挂载路径前缀。
   * 仅 http/https 协议时返回 pathname（去掉末尾斜杠），
   * 例如 "http://127.0.0.1:57215/dsh/" → "/dsh"；
   * 非 http(s)（如 dsh-app://）返回 ""。
   */
  function mountPrefixOf(baseURI) {
    if (!baseURI) return "";
    try {
      const url = new URL(baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.pathname.replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  /**
   * 宿主路由完整前缀：页面 baseURI 挂载前缀 + 路由段。
   * 页面可能运行在 dsh-app:// 协议下，禁止使用 location.origin。
   */
  const ROUTE_PATH =
    mountPrefixOf(typeof document === "undefined" ? undefined : document.baseURI) +
    ROUTE_SEGMENT;

  /** 读取位置记忆；数据非法时回退 null */
  function loadPos() {
    try {
      const raw = window.localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (
        p &&
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        isFinite(p.x) &&
        isFinite(p.y)
      ) {
        return p;
      }
    } catch (e) {
      /* 忽略读取异常 */
    }
    return null;
  }

  /** 写回位置记忆；存储异常静默忽略 */
  function savePos(p) {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify(p));
    } catch (e) {
      /* 忽略存储异常 */
    }
  }

  /** 把齿轮位置 clamp 进当前视口（保留距边缘最小间距） */
  function clampPos(p) {
    const maxX = Math.max(EDGE_MIN, window.innerWidth - GEAR_SIZE - EDGE_MIN);
    const maxY = Math.max(EDGE_MIN, window.innerHeight - GEAR_SIZE - EDGE_MIN);
    return {
      x: Math.min(maxX, Math.max(EDGE_MIN, p.x)),
      y: Math.min(maxY, Math.max(EDGE_MIN, p.y)),
    };
  }

  /* ------------------------------------------------------------------ */
  /* HTTP 工具（宿主路由契约：GET state / POST open / POST set-master）  */
  /* ------------------------------------------------------------------ */

  /** 通用请求：非 2xx 抛错，成功返回解析后的 JSON */
  async function request(path, options) {
    const res = await fetch(ROUTE_PATH + path, options);
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    return res.json();
  }

  /** GET {ROUTE}/state：宿主状态轮询 */
  function getState() {
    return request("/state");
  }

  /** POST {ROUTE}/open：打开外窗（首次可能触发 Electron 下载，耗时长） */
  function postOpen() {
    return request("/open", { method: "POST" });
  }

  /** POST {ROUTE}/set-master：总开关 */
  function postSetMaster(on) {
    return request("/set-master", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: !!on }),
    });
  }

  /** 齿轮 SVG path（白色，fill-rule=evenodd 挖出中心孔） */
  const GEAR_PATH =
    "M 32.00 2.00 A 30 30 0 0 1 42.26 3.81 L 39.87 10.39 A 23 23 0 0 1 48.26 15.74 L 53.21 10.79 M 53.21 10.79 A 30 30 0 0 1 59.19 19.32 L 52.85 22.28 A 23 23 0 0 1 55.00 32.00 L 62.00 32.00 M 62.00 32.00 A 30 30 0 0 1 60.19 42.26 L 53.61 39.87 A 23 23 0 0 1 48.26 48.26 L 53.21 53.21 M 53.21 53.21 A 30 30 0 0 1 44.68 59.19 L 41.72 52.85 A 23 23 0 0 1 32.00 55.00 L 32.00 62.00 M 32.00 62.00 A 30 30 0 0 1 21.74 60.19 L 24.13 53.61 A 23 23 0 0 1 15.74 48.26 L 10.79 53.21 M 10.79 53.21 A 30 30 0 0 1 4.81 44.68 L 11.15 41.72 A 23 23 0 0 1 9.00 32.00 L 2.00 32.00 M 2.00 32.00 A 30 30 0 0 1 3.81 21.74 L 10.39 24.13 A 23 23 0 0 1 15.74 15.74 L 10.79 10.79 M 10.79 10.79 A 30 30 0 0 1 19.32 4.81 L 22.28 11.15 A 23 23 0 0 1 32.00 9.00 L 32.00 2.00 M 32.00 24.50 A 7.5 7.5 0 1 1 32.00 24.50 A 7.5 7.5 0 1 1 32.00 24.50";

  /* ================================================================== */
  /* 样式表（ctx.effect 注入；统一 dash- 前缀；全部 token + 兜底值）    */
  /* ================================================================== */
  const CSS = `
/* dsh-dashboard 客户端样式 */
.dash-gear-anchor { position: fixed; z-index: 99999; }
.dash-gear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #1677ff);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.12s ease, filter 0.12s ease;
}
.dash-gear-btn:hover { filter: brightness(1.1); }
.dash-gear-btn:active { transform: scale(0.94); }
.dash-gear-pop {
  position: absolute;
  right: 0;
  bottom: 46px;
  width: 224px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--dsw-alias-settings-card-fill, #ffffff);
  border: 1px solid var(--dsw-alias-settings-card-stroke, rgba(0, 0, 0, 0.08));
  border-radius: var(--dsw-radius-md, 12px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.22);
  color: var(--dsw-alias-label-primary, rgba(0, 0, 0, 0.85));
}
.dash-gear-pop .dash-btn { width: 100%; }
.dash-btn {
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-base, #f7f8fa);
  color: var(--dsw-alias-label-primary, rgba(0, 0, 0, 0.85));
  font: var(--dsw-font-s-14, 14px);
  cursor: pointer;
  transition: background 0.12s ease;
}
.dash-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
}
.dash-btn:disabled { opacity: 0.5; cursor: default; }
.dash-btn-danger {
  border-color: var(--dsw-alias-state-error-primary, #e5484d);
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dash-pop-hint {
  margin: 0;
  font: var(--dsw-font-xxs-12, 12px);
  line-height: 1.5;
  color: var(--dsw-alias-label-caption, rgba(0, 0, 0, 0.45));
}
.dash-pop-status {
  margin: 0;
  font: var(--dsw-font-xxs-12, 12px);
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.6));
}
.dash-pop-status-ok { color: var(--dsw-alias-state-business-primary, #1677ff); }
.dash-pop-status-err { color: var(--dsw-alias-state-error-primary, #e5484d); }

/* ---------- 设置页 ---------- */
.dash-settings { display: flex; flex-direction: column; gap: 12px; }
.dash-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dash-row-side { display: flex; align-items: center; gap: 8px; }
.dash-label {
  font: var(--dsw-font-s-14, 14px);
  color: var(--dsw-alias-label-primary, rgba(0, 0, 0, 0.85));
}
.dash-switch {
  position: relative;
  width: 52px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-label-dimmed, rgba(0, 0, 0, 0.35));
  cursor: pointer;
  transition: background 0.18s ease;
}
.dash-switch:disabled { opacity: 0.5; cursor: default; }
.dash-switch-on { background: var(--dsw-alias-state-business-primary, #1677ff); }
.dash-switch-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: left 0.18s ease;
}
.dash-switch-on .dash-switch-knob { left: 27px; }
.dash-switch-text {
  min-width: 30px;
  font: var(--dsw-font-xxs-12, 12px);
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.6));
}
.dash-settings-msg { font: var(--dsw-font-xxs-12, 12px); line-height: 1.4; }
.dash-settings-msg-ok { color: var(--dsw-alias-state-business-primary, #1677ff); }
.dash-settings-msg-err { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dash-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font: var(--dsw-font-xxxs-11, 11px);
  line-height: 1.5;
  color: var(--dsw-alias-label-caption, rgba(0, 0, 0, 0.45));
}
`;

  /* ================================================================== */
  /* 二、插件工厂：React 组件 + 槽位注册                                 */
  /* ================================================================== */

  function makeFactory() {
    return function (require) {
      /* React 依赖（禁止 JSX，统一使用 jsx-runtime 的 h()） */
      const react = require("react");
      const { useEffect, useRef, useState, useCallback } = react;
      const { jsx: h } = require("react/jsx-runtime");

      /** 宿主状态初始值（GET state 字段全集） */
      const INITIAL_STATE = {
        on: false,
        port: 0,
        adminBase: "",
        pollMs: 2000,
        degraded: false,
        downloading: false,
      };

      /** 每 2s 轮询一次宿主状态；组件卸载时清理定时器 */
      function useDashboardState() {
        const [state, setState] = useState(INITIAL_STATE);

        useEffect(function () {
          let alive = true;

          async function tick() {
            try {
              const s = await getState();
              if (!alive) return;
              setState(Object.assign({}, INITIAL_STATE, s));
            } catch (e) {
              /* 轮询失败：保留上一次状态，等待下一轮 */
            }
          }

          tick(); /* 挂载后立即拉取一次 */
          const timer = setInterval(tick, POLL_INTERVAL);
          return function () {
            alive = false;
            clearInterval(timer);
          };
        }, []);

        return [state, setState];
      }

      /* ---------------- A. 右下角小齿轮（shell.overlay） ---------------- */

      function GearWidget() {
        const [state, setState] = useDashboardState();
        const [pos, setPos] = useState(function () {
          return clampPos(loadPos() || DEFAULT_POS);
        });
        const [popOpen, setPopOpen] = useState(false);
        const [openStatus, setOpenStatus] = useState("idle"); /* idle|opening|ok|error */
        const [openError, setOpenError] = useState("");
        const [closeBusy, setCloseBusy] = useState(false);

        const gearRef = useRef(null); /* 齿轮按钮 DOM */
        const posRef = useRef(pos); /* 位置实时值（拖动回调使用） */
        const dragRef = useRef(null); /* 拖动会话 {startX,startY,baseX,baseY} */

        /* 总开关关闭后重置弹窗，避免重新开启时弹窗残留 */
        useEffect(function () {
          if (!state.on) setPopOpen(false);
        }, [state.on]);

        /* ① 打开外窗：POST open（首次可能耗时下载 Electron） */
        const handleOpen = useCallback(
          async function () {
            if (openStatus === "opening" || state.downloading) return;
            setOpenStatus("opening");
            setOpenError("");
            try {
              const res = await postOpen();
              if (res && res.ok) {
                setOpenStatus("ok");
              } else {
                setOpenStatus("error");
                setOpenError((res && res.error) || "打开外窗失败");
              }
            } catch (e) {
              setOpenStatus("error");
              setOpenError("无法连接宿主服务");
            }
          },
          [openStatus, state.downloading]
        );

        /* ② 关闭控制台：POST set-master {on:false} */
        const handleCloseMaster = useCallback(
          async function () {
            if (closeBusy) return;
            setCloseBusy(true);
            setOpenError("");
            try {
              const res = await postSetMaster(false);
              if (res && res.ok) {
                setState(function (s) {
                  return Object.assign({}, s, { on: false });
                });
                setPopOpen(false);
              } else {
                setOpenError("关闭控制台失败");
              }
            } catch (e) {
              setOpenError("无法连接宿主服务");
            } finally {
              setCloseBusy(false);
            }
          },
          [closeBusy, setState]
        );

        /* 拖拽（window 级监听）：pointerdown 起、pointermove 跟、pointerup 判定 */
        const onPointerDown = useCallback(function (ev) {
          const btn = gearRef.current;
          if (!btn || !btn.contains(ev.target)) return; /* 只响应齿轮自身 */
          if (ev.button !== 0) return; /* 仅主键 / 触摸 */

          dragRef.current = {
            startX: ev.clientX,
            startY: ev.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
          /* 捕获指针，保证拖动过程中事件不丢失 */
          if (btn.setPointerCapture && typeof ev.pointerId === "number") {
            try {
              btn.setPointerCapture(ev.pointerId);
            } catch (e) {
              /* 忽略捕获失败 */
            }
          }
          ev.preventDefault(); /* 避免拖动时选中文本 */
        }, []);

        const onPointerMove = useCallback(function (ev) {
          const d = dragRef.current;
          if (!d) return;
          const dx = ev.clientX - d.startX;
          const dy = ev.clientY - d.startY;
          /* 向右拖 → right 偏移减小；向上拖 → bottom 偏移增大；clamp 在视口内 */
          const p = clampPos({ x: d.baseX - dx, y: d.baseY - dy });
          posRef.current = p;
          setPos(p);
        }, []);

        const onPointerUp = useCallback(function (ev) {
          const d = dragRef.current;
          if (!d) return;
          dragRef.current = null;
          const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY);
          if (dist < CLICK_THRESHOLD) {
            /* 位移 <5px 判定为单击 → 切换设置弹窗 */
            setPopOpen(function (o) {
              return !o;
            });
          } else {
            /* 拖动结束 → 写回位置记忆 */
            savePos(posRef.current);
          }
        }, []);

        useEffect(function () {
          window.addEventListener("pointerdown", onPointerDown);
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
          return function () {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
          };
        }, [onPointerDown, onPointerMove, onPointerUp]);

        /* 宿主总开关关闭时整个小齿轮不渲染 */
        if (!state.on) return null;

        const openLabel = state.downloading
          ? "下载中…"
          : openStatus === "opening"
            ? "准备中…"
            : "打开外窗";

        return h("div", {
          className: "dash-gear-anchor",
          style: { right: pos.x + "px", bottom: pos.y + "px" },
          children: [
            popOpen
              ? h("div", {
                  className: "dash-gear-pop",
                  children: [
                    h("button", {
                      type: "button",
                      className: "dash-btn",
                      disabled: openStatus === "opening" || state.downloading,
                      onClick: handleOpen,
                      children: openLabel,
                    }),
                    h("button", {
                      type: "button",
                      className: "dash-btn dash-btn-danger",
                      disabled: closeBusy,
                      onClick: handleCloseMaster,
                      children: "关闭控制台",
                    }),
                    openStatus === "ok"
                      ? h("div", {
                          className: "dash-pop-status dash-pop-status-ok",
                          children: "外窗已打开",
                        })
                      : null,
                    openError
                      ? h("div", {
                          className: "dash-pop-status dash-pop-status-err",
                          children: openError,
                        })
                      : null,
                    h("p", {
                      className: "dash-pop-hint",
                      children: "关闭后仅在 设置 → 控制台设置 可重新开启",
                    }),
                  ],
                })
              : null,
            h("button", {
              ref: gearRef,
              type: "button",
              className: "dash-gear-btn",
              title: "控制台",
              "aria-label": "控制台快捷入口",
              children: h("svg", {
                width: 22,
                height: 22,
                viewBox: "0 0 64 64",
                fill: "#fff",
                "aria-hidden": true,
                children: h("path", { d: GEAR_PATH, fillRule: "evenodd" }),
              }),
            }),
          ],
        });
      }

      /* --------------- B. 设置页「控制台设置」（settings.section） --------------- */

      function SettingsSection() {
        const [state, setState] = useDashboardState();
        const [busy, setBusy] = useState(false); /* set-master 请求中 */
        const [switchError, setSwitchError] = useState("");
        const [openBusy, setOpenBusy] = useState(false); /* open 请求中 */
        const [openMsg, setOpenMsg] = useState(null); /* {ok:bool, text:string} */

        /* ① 总开关：POST set-master {on:!on}，请求期间禁用 */
        const handleToggle = useCallback(
          async function () {
            if (busy) return;
            setBusy(true);
            setSwitchError("");
            try {
              const res = await postSetMaster(!state.on);
              if (res && res.ok) {
                setState(function (s) {
                  return Object.assign({}, s, { on: !!res.on });
                });
              } else {
                setSwitchError("开关切换失败");
              }
            } catch (e) {
              setSwitchError("无法连接宿主服务");
            } finally {
              setBusy(false);
            }
          },
          [busy, state.on, setState]
        );

        /* ② 打开外窗：POST open，成功后提示「外窗已打开」 */
        const handleOpen = useCallback(
          async function () {
            if (openBusy || state.downloading) return;
            setOpenBusy(true);
            setOpenMsg(null);
            try {
              const res = await postOpen();
              if (res && res.ok) {
                setOpenMsg({ ok: true, text: "外窗已打开" });
              } else {
                setOpenMsg({ ok: false, text: (res && res.error) || "打开外窗失败" });
              }
            } catch (e) {
              setOpenMsg({ ok: false, text: "无法连接宿主服务" });
            } finally {
              setOpenBusy(false);
            }
          },
          [openBusy, state.downloading]
        );

        return h("div", {
          className: "dash-settings",
          children: [
            /* ① 总开关 */
            h("div", {
              className: "dash-row",
              children: [
                h("span", { className: "dash-label", children: "控制台总开关" }),
                h("div", {
                  className: "dash-row-side",
                  children: [
                    h("button", {
                      type: "button",
                      role: "switch",
                      "aria-checked": state.on,
                      className: "dash-switch" + (state.on ? " dash-switch-on" : ""),
                      disabled: busy,
                      onClick: handleToggle,
                      children: h("span", { className: "dash-switch-knob" }),
                    }),
                    h("span", {
                      className: "dash-switch-text",
                      children: state.on ? "ON" : "OFF",
                    }),
                  ],
                }),
              ],
            }),

            switchError
              ? h("div", {
                  className: "dash-settings-msg dash-settings-msg-err",
                  children: switchError,
                })
              : null,

            /* ② 打开外窗 */
            h("div", {
              className: "dash-row",
              children: [
                h("button", {
                  type: "button",
                  className: "dash-btn",
                  disabled: openBusy || state.downloading,
                  onClick: handleOpen,
                  children: state.downloading
                    ? "下载中…"
                    : openBusy
                      ? "准备中…"
                      : "打开外窗",
                }),
                openMsg
                  ? h("span", {
                      className:
                        "dash-settings-msg " +
                        (openMsg.ok ? "dash-settings-msg-ok" : "dash-settings-msg-err"),
                      children: openMsg.text,
                    })
                  : null,
              ],
            }),

            /* ③ 信息区（三行小字） */
            h("div", {
              className: "dash-info",
              children: [
                h("div", {
                  children: [
                    "控制面地址：",
                    state.port > 0 ? "http://127.0.0.1:" + state.port : "未运行",
                  ],
                }),
                h("div", { children: "轮询间隔：" + (state.pollMs || 2000) + " ms" }),
                h("div", {
                  children: "外窗随 DSH 退出自动回收；异常残留时关闭总开关可强制清理",
                }),
              ],
            }),
          ],
        });
      }

      /* ---------------- 插件入口 apply：样式注入 + 槽位注册 ---------------- */

      function apply(ctx) {
        /* 注入全局样式；插件卸载时移除 <style> */
        ctx.effect(function () {
          const st = document.createElement("style");
          st.textContent = CSS;
          document.head.appendChild(st);
          return function () {
            st.remove();
          };
        }, "dsh-dashboard: styles");

        /* A. 右下角小齿轮 */
        ctx.slots.inject("shell.overlay", function* () {
          yield ctx.slots.register(
            { name: "shell.overlay", id: "dsh-dashboard-gear", order: 2000 },
            function () {
              return h(GearWidget, {});
            }
          );
        });

        /* B. 设置页「控制台设置」 */
        ctx.slots.inject("settings.section", function* () {
          yield ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-dashboard-config",
              order: 500,
              label: function () {
                return "控制台设置";
              },
              inject: function () {
                return {};
              },
            },
            SettingsSection
          );
        });
      }

      return { apply: apply, inject: ["slots"], name: "dsh-dashboard" };
    };
  }

  /* ================================================================== */
  /* 三、注册进 DSH 模块加载器                                          */
  /* ================================================================== */

  window.__ModuleLoader__.load({ id: "dsh-dashboard", factory: makeFactory() });
})();
