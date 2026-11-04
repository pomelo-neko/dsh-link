// dsh-link-bridge client half (0.8): Settings → dsh-link hub panel.
//
// Hand-written AMD/__ModuleLoader__ bundle, no build step and no dependencies besides React (which
// the DSH web client provides through require("react")). The host half (lib/index.js + lib/hub.js)
// serves the two same-origin routes this panel talks to:
//
//   GET  /api/v1/hub/status    → proxy of the local node's hub state (token stays in the host)
//   POST /api/v1/hub/reconnect → proxy of the node's manual reconnect (409 hub_disabled etc.)
//
// The panel polls status every 5s (paused while the page is hidden, refreshed immediately when it
// becomes visible again), shows the whole hub uplink story — state, heartbeat, last error, pending
// outbox, enrolled node — and offers 重新连接. On a node that is not enrolled (0.7 point-to-point
// mode) it says so and keeps the button disabled.
//
// Only Node-free browser APIs are used; the module is inert when loaded outside a browser.
if (typeof window !== 'undefined') {

  window.__ModuleLoader__.load({
    id: "dsh-link-bridge",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      var react = require("react");
      var h = react.createElement;

      // ---- 样式注入（官方 data-plugin-css 模式，见 DSH 插件示例）----
      var CSS_ID = "dsh-link-bridge/settings.css";
      var cssText = [
        ".dlhub-section{max-width:720px;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);display:flex}",
        ".dlhub-head{flex-direction:column;gap:4px;display:flex}",
        ".dlhub-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
        ".dlhub-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}",
        ".dlhub-notice{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;font-size:13px;line-height:20px;flex-direction:column;gap:4px;display:flex}",
        ".dlhub-notice-warn{border-color:var(--dsw-alias-state-warn-secondary,var(--dsw-alias-border-l3))}",
        ".dlhub-notice-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".dlhub-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;word-break:break-word}",
        ".dlhub-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}",
        ".dlhub-row{align-items:flex-start;gap:12px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;line-height:20px;display:flex}",
        ".dlhub-row:first-child{border-top:none}",
        ".dlhub-row-label{color:var(--dsw-alias-label-tertiary);flex:none;width:104px}",
        ".dlhub-row-value{min-width:0;flex:1;word-break:break-word}",
        ".dlhub-sub-value{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-word}",
        ".dlhub-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}",
        ".dlhub-badge{align-items:center;gap:6px;display:inline-flex}",
        ".dlhub-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:var(--dsw-alias-label-tertiary)}",
        ".dlhub-dot-ok{background:var(--dsw-alias-state-success-primary)}",
        ".dlhub-dot-warn{background:var(--dsw-alias-state-warn-label,#d97706)}",
        ".dlhub-dot-error{background:var(--dsw-alias-state-error-primary)}",
        ".dlhub-dot-info{background:var(--dsw-alias-state-info-primary,var(--dsw-alias-label-secondary))}",
        ".dlhub-foot{align-items:center;gap:8px;justify-content:space-between;display:flex}",
        ".dlhub-foot-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".dlhub-btn{box-sizing:border-box;height:30px;border:none;border-radius:15px;padding:0 14px;font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;justify-content:center;align-items:center;display:inline-flex;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
        ".dlhub-btn:disabled{opacity:.5;cursor:default}"
      ];
      function injectCss() {
        try {
          if (typeof document === "undefined" || !document.head) return;
          if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) return;
          var style = document.createElement("style");
          style.dataset.plugin = "dsh-link-bridge";
          style.dataset.pluginCss = CSS_ID;
          style.textContent = cssText.join("\n");
          document.head.appendChild(style);
        } catch (error) {
          // 样式只是装饰：注入失败不能影响面板注册
        }
      }
      injectCss();

      // ---- 面板数据 ----
      var STATUS_PATH = "/api/v1/hub/status";
      var RECONNECT_PATH = "/api/v1/hub/reconnect";
      var POLL_MS = 5000;

      var STATE_LABELS = {
        disabled: "未启用",
        connecting: "连接中",
        online: "在线",
        degraded: "降级",
        offline: "离线",
        unknown: "未知"
      };
      var STATE_TONES = {
        disabled: "none",
        connecting: "info",
        online: "ok",
        degraded: "warn",
        offline: "error",
        unknown: "none"
      };

      function stringOf(value) {
        return typeof value === "string" ? value : "";
      }

      function isoText(value) {
        var text = stringOf(value);
        if (!text) return "—";
        var date = new Date(text);
        if (isNaN(date.getTime())) return text;
        return date.toLocaleString();
      }

      function errorText(error) {
        if (!error) return "未知错误";
        var message = error.message !== undefined && error.message !== null ? String(error.message) : String(error);
        return message || "未知错误";
      }

      function nodeFailure(body, response) {
        var error = body && body.error ? body.error : null;
        var code = error ? stringOf(error.code) : "";
        var message = error ? stringOf(error.message) : "";
        if (code && message) return code + ": " + message;
        if (code) return code;
        if (message) return message;
        return response ? "HTTP " + response.status : "未知错误";
      }

      // fetch + JSON in one step; a non-2xx answer becomes an Error that carries the node's code,
      // so the panel can render hub_disabled / node_unreachable verbatim.
      function fetchJson(path, init) {
        return fetch(path, init).then(function (response) {
          return response.text().then(function (text) {
            var body = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch (error) {
              body = null;
            }
            if (!response.ok) {
              var failure = new Error(nodeFailure(body, response));
              failure.status = response.status;
              failure.code = body && body.error ? stringOf(body.error.code) : "";
              throw failure;
            }
            if (body === null) throw new Error("本地 dsh-link 节点返回了非 JSON 响应");
            return body;
          });
        });
      }

      function loadHubStatus() {
        return fetchJson(STATUS_PATH, { headers: { accept: "application/json" } });
      }

      function requestHubReconnect() {
        return fetchJson(RECONNECT_PATH, { method: "POST", headers: { accept: "application/json" } });
      }

      function looksLikeStatus(body) {
        return !!body && typeof body === "object" && typeof body.enabled === "boolean" && typeof body.state === "string";
      }

      // ---- 小组件 ----
      function statusRow(label, value, extra, extraClass) {
        var children = [
          h("span", { className: "dlhub-row-label" }, label),
          h("span", { className: "dlhub-row-value" + (extraClass ? " " + extraClass : "") }, value)
        ];
        if (extra) children.push(h("div", { className: "dlhub-sub-value" }, extra));
        return h("div", { className: "dlhub-row" }, children);
      }

      function stateRow(stateKey, stateLabel) {
        var tone = STATE_TONES[stateKey] || "none";
        return h("div", { className: "dlhub-row" },
          h("span", { className: "dlhub-row-label" }, "链路状态"),
          h("span", { className: "dlhub-row-value" },
            h("span", { className: "dlhub-badge" },
              h("span", { className: "dlhub-dot" + (tone === "none" ? "" : " dlhub-dot-" + tone) }),
              stateLabel
            )
          )
        );
      }

      // Settings → dsh-link。面板没有任何写操作除了「重新连接」，其余全是本机节点状态投影。
      function DshLinkHubSection() {
        var viewState = react.useState({ loading: true, status: null, error: null, busy: false, checkedAt: null });
        var view = viewState[0];
        var setView = viewState[1];
        var aliveRef = react.useRef(true);

        function patch(updater) {
          setView(function (previous) {
            return Object.assign({}, previous, updater(previous));
          });
        }

        function refresh() {
          return loadHubStatus().then(function (status) {
            if (!aliveRef.current) return;
            patch(function () {
              return { loading: false, status: status, error: null, checkedAt: Date.now() };
            });
          }).catch(function (error) {
            if (!aliveRef.current) return;
            patch(function () {
              return { loading: false, error: errorText(error), checkedAt: Date.now() };
            });
          });
        }

        function reconnect() {
          patch(function () {
            return { busy: true, error: null };
          });
          return requestHubReconnect().then(function (body) {
            if (!aliveRef.current) return;
            if (looksLikeStatus(body)) {
              patch(function () {
                return { busy: false, status: body, error: null, loading: false, checkedAt: Date.now() };
              });
            } else {
              patch(function () {
                return { busy: false };
              });
            }
            return refresh();
          }).catch(function (error) {
            if (!aliveRef.current) return;
            patch(function () {
              return { busy: false, error: errorText(error) };
            });
            // 节点明确拒绝（如 409 hub_disabled）时，状态仍值得再读一次，让面板显示节点自己的 lastError。
            return refresh();
          });
        }

        react.useEffect(function () {
          aliveRef.current = true;
          refresh();
          var timer = setInterval(function () {
            if (typeof document !== "undefined" && document.hidden) return; // 页面不可见时暂停轮询
            refresh();
          }, POLL_MS);
          function onVisibilityChange() {
            if (typeof document !== "undefined" && !document.hidden) refresh();
          }
          if (typeof document !== "undefined" && document.addEventListener) {
            document.addEventListener("visibilitychange", onVisibilityChange);
          }
          return function () {
            aliveRef.current = false;
            clearInterval(timer);
            if (typeof document !== "undefined" && document.removeEventListener) {
              document.removeEventListener("visibilitychange", onVisibilityChange);
            }
          };
        }, []);

        var status = view.status;
        var enabled = !!(status && status.enabled === true);
        var stateKey = status && typeof status.state === "string" ? status.state : "";
        var stateLabel = STATE_LABELS[stateKey] || stateKey || (view.loading ? "读取中…" : "未知");
        var url = status ? stringOf(status.url) : "";
        var enrolled = status && status.enrolled && typeof status.enrolled === "object" ? status.enrolled : null;
        if (!url && enrolled) url = stringOf(enrolled.downlinkUrl);
        var heartbeatValue = status ? isoText(status.lastHeartbeatAt) : "—";
        var lastError = status ? stringOf(status.lastError) : "";
        var pendingOutbox = status && typeof status.pendingOutbox === "number" ? status.pendingOutbox : null;
        var pendingTargets = status && Array.isArray(status.pendingTargets) ? status.pendingTargets.filter(function (target) { return typeof target === "string" && target; }) : [];
        var pendingValue = pendingOutbox === null ? "—" : String(pendingOutbox) + " 条" + (pendingOutbox === 0 ? "（无待发消息）" : "");
        var pendingExtra = pendingTargets.length ? "目标：" + pendingTargets.join("、") : "";
        var enrolledValue = enrolled ? (stringOf(enrolled.nodeName) || "未命名节点") : "—";
        var enrolledExtra = enrolled && stringOf(enrolled.hubName) ? "hub：" + stringOf(enrolled.hubName) : (enrolled ? "" : "节点尚未注册到 hub");
        var checkedText = view.checkedAt ? new Date(view.checkedAt).toLocaleTimeString() : "—";

        var children = [
          h("div", { className: "dlhub-head" },
            h("h2", { className: "dlhub-title" }, "dsh-link hub"),
            h("p", { className: "dlhub-sub" }, "本机 dsh-link 节点的 hub 链路状态。面板每 5 秒刷新，页面隐藏时暂停；「重新连接」会立即重试链路并上传一次心跳。")
          )
        ];

        if (status && enabled !== true) {
          children.push(h("div", { className: "dlhub-notice dlhub-notice-warn" },
            h("div", null, "hub 未启用（当前为 0.7 点对点模式）"),
            h("div", { className: "dlhub-notice-sub" }, "在节点的 dshlink.config.json 里启用 hub 并完成注册后，这里会显示链路状态并允许手动重连；桥插件与点对点消息不受影响。")
          ));
        }
        if (view.error) {
          children.push(h("div", { className: "dlhub-notice" },
            h("div", { className: "dlhub-error" }, "面板读取失败：" + view.error),
            h("div", { className: "dlhub-notice-sub" }, "本地 dsh-link 节点不可达，或当前 DSH host 未加载 bridge 0.8 的 hub 路由。消息主循环不受影响。")
          ));
        }

        if (view.loading && !status) {
          children.push(h("div", { className: "dlhub-notice" }, h("div", { className: "dlhub-notice-sub" }, "正在读取本机节点的 hub 状态…")));
        } else {
          var rows = [];
          rows.push(h("div", { className: "dlhub-row" },
            h("span", { className: "dlhub-row-label" }, "hub URL"),
            h("span", { className: "dlhub-row-value dlhub-mono" }, url || "—")
          ));
          rows.push(stateRow(stateKey, stateLabel));
          rows.push(statusRow("最后心跳", heartbeatValue));
          rows.push(statusRow("最后错误", lastError || "—", "", lastError ? "dlhub-error" : ""));
          rows.push(statusRow("本地待发队列", pendingValue, pendingExtra));
          rows.push(statusRow("已注册节点", enrolledValue, enrolledExtra));
          children.push(h("div", { className: "dlhub-card" }, rows));
        }

        children.push(h("div", { className: "dlhub-foot" },
          h("span", { className: "dlhub-foot-note" }, "最后刷新 " + checkedText),
          h("button", {
            type: "button",
            className: "dlhub-btn",
            disabled: view.busy === true || view.loading === true || enabled !== true,
            title: enabled === true ? "立即重试 hub 连接并上传心跳" : "hub 未启用，无法重连",
            onClick: reconnect
          }, view.busy === true ? "重新连接中…" : "重新连接")
        ));

        return h("div", { className: "dlhub-section" }, children);
      }

      // ---- 注册设置侧边栏分区 ----
      function apply(ctx) {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-link",
            order: 700,
            label: "dsh-link"
          }, DshLinkHubSection);
        });
      }

      // 运行时注入声明：apply 只访问 cordis ctx 上的 slots 服务。
      var inject = ["slots"];

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    }
  });

}
