// dsh-webgate — client half (browser bundle, classic script).
// Registers a "手机访问" (Phone access) section in Settings that shows the
// LAN URLs with QR codes so a phone on the same Wi-Fi can open this GUI by
// scanning. Reads window.__DSH_LAN__ injected by the node half.
window.__ModuleLoader__.load({
  id: "dsh-webgate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var useState = React.useState;
    var h = React.createElement;

    var styles = {
      wrap: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 12px" },
      intro: { fontSize: 13, lineHeight: 1.6, color: "var(--foreground-2, #888)", margin: 0 },
      card: {
        display: "flex", alignItems: "center", gap: 14,
        border: "1px solid var(--border, #333)", borderRadius: 10, padding: 12,
        background: "var(--background-2, rgba(255,255,255,0.03))"
      },
      qr: { width: 132, height: 132, borderRadius: 8, flex: "none", background: "#fff", padding: 4 },
      meta: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
      url: {
        fontSize: 14, fontWeight: 600, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        wordBreak: "break-all", color: "var(--foreground, #eee)"
      },
      hint: { fontSize: 12, lineHeight: 1.6, color: "var(--foreground-2, #888)" },
      warn: {
        border: "1px solid #b58900", borderRadius: 8, padding: "8px 12px",
        fontSize: 12, lineHeight: 1.7, color: "#e0c060",
        background: "rgba(181, 137, 0, 0.08)"
      },
      note: {
        border: "1px solid var(--border, #333)", borderRadius: 8, padding: "8px 12px",
        fontSize: 12, lineHeight: 1.7, color: "var(--foreground-2, #888)"
      },
      button: {
        alignSelf: "flex-start", border: "1px solid var(--border, #555)", borderRadius: 6,
        padding: "4px 10px", fontSize: 12, cursor: "pointer", background: "transparent",
        color: "var(--foreground, #ddd)"
      }
    };

    function CopyButton(props) {
      var text = props.text;
      var [copied, setCopied] = useState(false);
      return h("button", {
        style: styles.button,
        onClick: function () {
          try {
            navigator.clipboard.writeText(text).then(function () {
              setCopied(true);
              setTimeout(function () { setCopied(false); }, 1200);
            }, function () {});
          } catch (e) {}
        }
      }, copied ? "已复制 ✓" : "复制链接");
    }

    function LanAccessSection() {
      var info = (typeof window !== "undefined" && window.__DSH_LAN__) || null;
      if (info === null || info.urls.length === 0) {
        return h("div", { style: styles.wrap },
          h("p", { style: styles.intro }, "在手机与电脑处于同一 Wi-Fi/内网时，用手机相机扫描二维码即可打开本界面。"),
          h("div", { style: styles.note },
            info === null
              ? "插件已加载，但服务尚未注入局域网信息。请确认已安装 dsh-webgate 且以 0.0.0.0 绑定重启（默认即如此）。"
              : "当前服务仅绑定 127.0.0.1，未开放局域网访问。请以 0.0.0.0 绑定重启 dsh web。")
        );
      }
      var cards = info.urls.map(function (entry) {
        return h("div", { key: entry.url, style: styles.card },
          h("img", { src: entry.qr, alt: entry.url, style: styles.qr }),
          h("div", { style: styles.meta },
            h("div", { style: styles.url }, entry.url),
            h("div", { style: styles.hint }, "手机相机对准二维码即可打开"),
            h(CopyButton, { text: entry.url })
          )
        );
      });
      // Detect when THIS page was opened via an authority the /api fence does
      // not trust (e.g. a .local hostname) — the page opens but every API call
      // is rejected, so conversations/workspaces appear broken.
      var untrusted = null;
      try {
        var hostname = window.location.hostname;
        var isLoopback = hostname === "localhost" || hostname === "[::1]" ||
          (hostname.split(".").length === 4 && hostname.split(".")[0] === "127");
        if (!isLoopback && info.hosts && info.hosts.indexOf(hostname) === -1) {
          untrusted = hostname;
        }
      } catch (e) {}
      var remoteCard = info.remote
        ? h("div", { style: { ...styles.card, border: "1px solid #4a9eff" } },
            h("img", { src: info.remote.qr, alt: info.remote.url, style: styles.qr }),
            h("div", { style: styles.meta },
              h("div", { style: { ...styles.url, color: "#6db2ff" } }, "专属域名（frp + Caddy，需登录）"),
              h("div", { style: styles.url }, info.remote.url),
              h("div", { style: styles.hint }, "带密码保护；用户名 admin，密码见你的部署记录"),
              h(CopyButton, { text: info.remote.url })
            )
          )
        : null;
      var tunnelCard = info.tunnel
        ? h("div", { style: { ...styles.card, border: "1px solid #4a9eff" } },
            h("img", { src: info.tunnel.qr, alt: info.tunnel.url, style: styles.qr }),
            h("div", { style: styles.meta },
              h("div", { style: { ...styles.url, color: "#6db2ff" } }, "公网访问（任何网络可用）"),
              h("div", { style: styles.url }, info.tunnel.url),
              h("div", { style: styles.hint }, "在外网/蜂窝网络也能打开；链接即权限，请勿外传"),
              h(CopyButton, { text: info.tunnel.url })
            )
          )
        : null;
      return h("div", { style: styles.wrap },
        remoteCard,
        tunnelCard,
        h("p", { style: styles.intro }, "手机与电脑在同一 Wi-Fi/内网时，用手机相机（或微信/浏览器扫码）扫描下方二维码，即可直接在手机上使用本界面。"),
        untrusted !== null
          ? h("div", { style: styles.warn },
              "⚠️ 当前页面地址（" + untrusted + "）不在服务信任列表里，对话/工作区接口会被拒绝。" +
              "请改用下面的地址打开：" + info.urls[0].url)
          : null,
        cards,
        h("div", { style: styles.warn },
          "⚠️ 安全提醒：局域网模式没有密码保护。同一网络内的任何设备都可以操作本 Agent（包括执行命令），请仅在可信网络使用；设置与凭据修改仍仅限本机访问。"
        )
      );
    }
    /** Required services (cordis fiber inject). */
    var inject = ["slots"];

    /**
    * Register the section once the settings.section slot is on the ledger.
    * @param ctx - client root context.
    */
    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "lan-access",
          order: 200,
          label: function () { return "手机访问"; }
        }, LanAccessSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});