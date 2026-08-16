// dsh-webgate — node half (host-side cordis plugin).
// 1) Provides the live `lanAccessHosts` service the connection row reads for
//    the /api browser-trust fence: every current LAN IPv4 plus this machine's
//    hostname (.local), refreshed in place so IP changes apply without restart.
// 2) Injects a FRESH window.__DSH_LAN__ (LAN URLs + QR data URLs + hosts) into
//    every index.html render, so a changed Wi-Fi IP never leaves a stale QR.
// 3) Prints the LAN URL line with a terminal QR code and a security warning.
//
// The webserver host is set to 0.0.0.0 by this bundle's cordis.patch.yml
// (config layer), the sanctioned place for binding policy — the CLI rejects
// --host 0.0.0.0 on purpose. On 0.0.0.0 the web-app runtime derives every LAN
// IPv4 as a trusted authority; this plugin extends that with the hostname and
// keeps the list live.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { qrDataUrl, qrTerminal } from "./qr.js";
import { startPortal } from "./portal.js";

/** Stable Cordis plugin name. */
export const name = "dsh-webgate";

/** Services this host row needs before it can mount. */
export const inject = ["webServer", "webRuntime", "sessions"];

/**
* Plugin config (validated by hand to keep the node half dependency-free).
* @param config - raw resolved config.
* @returns the config with defaults applied.
*/
function normalizeConfig(config) {
  return {
    printBootLine: config?.printBootLine !== false,
    injectBrowser: config?.injectBrowser !== false,
    tunnelEnabled: config?.tunnelEnabled === true,
    tunnelBinary: typeof config?.tunnelBinary === "string" ? config.tunnelBinary : "",
    extraHosts: Array.isArray(config?.extraHosts) ? config.extraHosts.filter((h) => typeof h === "string") : [],
    frpEnabled: config?.frpEnabled === true,
    frpcBinary: typeof config?.frpcBinary === "string" ? config.frpcBinary : "",
    frpcConfig: typeof config?.frpcConfig === "string" ? config.frpcConfig : "",
    portalEnabled: config?.portalEnabled === true,
    portalUser: typeof config?.portalUser === "string" ? config.portalUser : "admin",
    portalPasswordHash: typeof config?.portalPasswordHash === "string" ? config.portalPasswordHash : "",
    portalPort: typeof config?.portalPort === "number" && config.portalPort > 0 ? config.portalPort : 8081
  };
}

/** Live cloudflared quick-tunnel state: the public URL once it is announced. */
const tunnel = { url: void 0, child: void 0 };

/** Extra authorities from config (e.g. the frp+Caddy domain) trusted by the fence. */
let extraHosts = [];

/** frpc child process, when the frp tunnel mode is enabled. */
const frp = { child: void 0 };

/** Escape JSON so a plugin-controlled value cannot break out of <script>. */
function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\u003c");
}

/** LAN IPv4 addresses of this machine (non-internal interfaces only). */
function lanIpv4() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

/** LAN IPv6 literals (bracket form, zone stripped) for the trust fence. */
function lanIpv6() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface !== void 0 && iface.family === "IPv6" && !iface.internal)
    .map((iface) => iface.address.split("%")[0])
    .filter((addr) => addr !== "::1" && addr !== "" && !addr.toLowerCase().startsWith("fe80:"))
    .map((addr) => `[${addr}]`);
}

/**
* Live list of authorities the /api fence accepts from LAN browsers: every
* current non-internal IPv4 plus this machine's own hostname (so mDNS access
* like http://mac-name.local:3080 also works). Exposed as `lanAccessHosts`.
* @returns the deduplicated authority list.
*/
function computeLanHosts() {
  const hosts = [...lanIpv4(), ...lanIpv6(), ...extraHosts];
  let hostname = "";
  try {
    hostname = osHostname();
  } catch {
    /* hostname unavailable — IPs alone still cover the LAN */
  }
  if (hostname !== "") {
    const base = hostname.endsWith(".local") ? hostname.slice(0, -6) : hostname;
    if (base !== "") hosts.push(base, base + ".local");
  }
  return [...new Set(hosts)];
}

/**
* Recompute the LAN host list in place. The connection row holds the same
* array reference per request, so the fence sees updates immediately.
* @param live - the live array provided as the `lanAccessHosts` service.
* @returns the refreshed list.
*/
function refreshLanHosts(live) {
  const next = [...computeLanHosts(), ...tunnelHosts()];
  live.splice(0, live.length, ...next);
  return next;
}

/**
* Push any authorities missing from the connection row's SNAPSHOTTED
* trustedHosts into that snapshot. The fence reads that snapshot per request,
* but it was captured at boot — new authorities appearing later (a Tailscale
* 100.x address, a new Wi-Fi IP, a tunnel hostname) must be added to it
* directly or they stay rejected until restart.
* @param ctx - plugin context.
* @param live - the live authority list.
*/
function syncSnapshotTrust(ctx, live) {
  try {
    const connection = ctx.get("connection");
    if (connection === void 0 || !Array.isArray(connection.trustedHosts)) return;
    for (const host of live) if (!connection.trustedHosts.includes(host)) connection.trustedHosts.push(host);
  } catch {
    /* best effort */
  }
}

/** Public tunnel hostname(s) currently announced by cloudflared. */
function tunnelHosts() {
  return tunnel.url === void 0 ? [] : [new URL(tunnel.url).hostname];
}

/**
* Suggested session cache: the session a fresh browser should land on.
* Refreshed asynchronously (attached live sessions first by last event time,
* then cold persisted sessions by creation time).
*/
const suggested = { id: void 0 };

/**
* Pick the best session to auto-open on fresh origins: the most recently
* active top-level attached session, or the most recently created top-level
* persisted session when nothing is attached. Child/subagent sessions are
* skipped — the GUI's session list shows top-level sessions.
* @param ctx - plugin context (sessions + sessionPersistence injected).
*/
async function refreshSuggested(ctx) {
  try {
    let best;
    let bestTime = -Infinity;
    for (const session of ctx.sessions.list()) {
      if (session.header?.parentSession !== void 0) continue;
      const lastEvent = session.events?.at(-1);
      const time = lastEvent?.time ?? session.header?.createdAt ?? 0;
      if (time > bestTime) {
        bestTime = time;
        best = session.id;
      }
    }
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== void 0) {
      const headers = await persistence.list();
      for (const header of headers ?? []) {
        if (header?.parentSession !== void 0) continue;
        const time = header.createdAt ?? 0;
        if (time > bestTime) {
          bestTime = time;
          best = header.id;
        }
      }
    }
    suggested.id = best;
  } catch {
    /* keep the previous suggestion */
  }
}

/**
* Publish the announced tunnel URL: record it, and push its hostname into the
* connection row's SNAPSHOTTED trustedHosts array (the fence captures that
* array at boot — a live list alone is invisible to it), so API and WebSocket
* requests through the tunnel pass immediately.
* @param ctx - plugin context.
* @param url - the announced https URL.
*/
function announceTunnel(ctx, url) {
  tunnel.url = url;
  syncSnapshotTrust(ctx, [...tunnelHosts(), ...computeLanHosts()]);
  console.log(`lan-access: public tunnel: ${tunnel.url}`);
  console.log(qrTerminal(tunnel.url));
  console.log("lan-access: anyone with this URL can control the agent — share carefully.");
}

/**
* Start a cloudflared quick tunnel (https://<random>.trycloudflare.com) that
* forwards to the loopback web server, and keep it alive for the plugin's
* lifetime. The announced hostname joins the live fence trust list, so API and
* WebSocket requests arriving through the tunnel pass the browser-trust fence.
* @param ctx - plugin context.
* @param binary - path to the cloudflared executable.
* @param port - the listening port.
*/
function startTunnel(ctx, binary, port) {
  let child;
  try {
    child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    console.error("lan-access: failed to start cloudflared:", error);
    return;
  }
  tunnel.child = child;
  let pending = "";
  const scan = (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
      if (match !== null) {
        tunnel.url = match[0];
        announceTunnel(ctx, match[0]);
      }
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.on("error", (error) => {
    console.error("lan-access: cloudflared error:", error);
  });
  child.on("exit", (code) => {
    if (tunnel.child === child) tunnel.child = void 0;
    if (code !== null && code !== 0) console.warn(`lan-access: cloudflared exited with ${code}`);
  });
  ctx.effect(() => () => {
    tunnel.url = void 0;
    if (tunnel.child === child) tunnel.child = void 0;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }, "lan-access: tunnel process");
}

/**
* Start frpc (the frp client) to forward the HK server's tunnel to this
* machine. The tunnel is plain TCP/HTTP passthrough, so no output parsing is
* needed — the plugin just keeps the process alive and logs its output.
* @param ctx - plugin context.
* @param binary - path to the frpc executable.
* @param configPath - path to the frpc TOML config.
*/
function startFrpc(ctx, binary, configPath) {
  let disposed = false;
  let current;
  const log = (chunk) => {
    const line = chunk.toString("utf8").trim();
    if (line !== "") console.log("frpc: " + line);
  };
  // Supervised launch loop: frp exits when the server is unreachable (e.g. the
  // cloud security group blocks the port), so respawn every 5s forever while
  // the plugin lives — the tunnel self-heals once the server becomes reachable.
  const launch = () => {
    if (disposed) return;
    let child;
    try {
      child = spawn(binary, ["-c", configPath], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      console.error("lan-access: failed to start frpc:", error);
      if (!disposed) setTimeout(launch, 5000);
      return;
    }
    current = child;
    frp.child = child;
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.on("exit", (code) => {
      if (frp.child === child) frp.child = void 0;
      if (disposed) return;
      if (code !== null && code !== 0) console.warn(`lan-access: frpc exited with ${code}, retrying in 5s`);
      setTimeout(launch, 5000);
    });
  };
  launch();
  ctx.effect(() => () => {
    disposed = true;
    frp.child = void 0;
    try { current?.kill("SIGTERM"); } catch { /* already gone */ }
  }, "lan-access: frpc process");
}

/**
* Build the payload the browser section renders: every LAN URL with a ready
* QR data URL, plus bind facts and the trusted authority list.
* @param ctx - plugin context (webServer + webRuntime injected).
* @param ipv4s - the IPv4 addresses to publish as URLs.
* @returns the payload.
*/
function lanPayload(ctx, ipv4s) {
  const port = ctx.webServer.port;
  const derived = ipv4s.length > 0
    ? ipv4s
    : ctx.webServer.host === "0.0.0.0"
      ? lanIpv4()
      : [];
  const urls = derived.map((ip) => {
    const url = `http://${ip}:${port}`;
    return { url, qr: qrDataUrl(url) };
  });
  return {
    urls,
    port,
    loopback: ctx.webServer.host === "127.0.0.1",
    host: ctx.webServer.host,
    hosts: computeLanHosts(),
    ...tunnel.url === void 0 ? {} : { tunnel: { url: tunnel.url, qr: qrDataUrl(tunnel.url) } },
    ...extraHosts.length === 0 ? {} : { remote: { url: "https://" + extraHosts[0], qr: qrDataUrl("https://" + extraHosts[0]) } },
    generatedAt: Date.now()
  };
}

/**
* Classic-script bootstrap that pre-seeds the per-origin current-session
* selection (localStorage `dsh.sessions.current`) on fresh origins, so a
* phone or a LAN-IP tab lands in the most recent conversation instead of the
* empty no-session state. Runs before the shell bundle reads the key; only
* writes when the key is absent (never overrides an explicit choice).
* @param sessionId - the session to open, or undefined to skip seeding.
* @returns an inline script tag, or "" when no session is suggested.
*/
function sessionSeedScript(sessionId) {
  if (sessionId === void 0) return "";
  const payload = JSON.stringify({ sessionId }).replaceAll("<", "\\u003c");
  return `<script>(function(){try{if(localStorage.getItem("dsh.sessions.current")===null){localStorage.setItem("dsh.sessions.current",JSON.stringify(${payload}));}}catch(e){}})();<\/script>`;
}

/**
* Inline polyfill for crypto.randomUUID, which browsers only expose in SECURE
* contexts (https or localhost). A phone opening http://<lan-ip>:3080 gets an
* insecure origin where crypto.randomUUID is undefined, and the client bundles
* (connection RPC ids, conversation message ids) call it directly — the first
* call throws and the app dies. Define a UUIDv4 via crypto.getRandomValues
* (available on insecure origins) before any bundle executes.
* @returns an inline script tag.
*/
function randomUuidPolyfillScript() {
  return `<script>(function(){if(typeof crypto!=="undefined"&&typeof crypto.randomUUID!=="function"){try{crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(x){return("0"+x.toString(16)).slice(-2)});return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10,16).join("")}}catch(e){}}})();<\/script>`;
}

/** Insert the __DSH_LAN__ script into an index.html body. */
function injectLanScript(html, payload) {
  const script = `<script>window.__DSH_LAN__ = ${escapeScriptJson(payload)}<\/script>`;
  const head = html.indexOf("<head>");
  return head !== -1
    ? `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
    : `${script}${html}`;
}

/** Render the boot summary: loopback URL, LAN URLs, terminal QR, warning. */
function printBootLine(ctx, payload) {
  const port = ctx.webServer.port;
  console.log(`dsh web: http://127.0.0.1:${port}`);
  if (payload.loopback || payload.urls.length === 0) {
    console.log("lan-access: bound to loopback only — phone access is off.");
    console.log("lan-access: set webserver host to 0.0.0.0 (this bundle's default) and restart to enable LAN access.");
    return;
  }
  console.log("lan-access: LAN access enabled — scan with your phone camera:");
  for (const { url } of payload.urls) {
    console.log(`  LAN URL: ${url}`);
    console.log(qrTerminal(url));
  }
  console.log("lan-access: WARNING — no authentication; anyone on this network can drive the agent (including running commands).");
  console.log("lan-access: only use on a network you trust. Settings/credentials stay loopback-only by design.");
}

/**
* Mount the plugin:
* - provides the `lanAccessHosts` live service the connection row's
*   trustedHosts reads (mutations visible per request, no restart needed);
* - injects a FRESH window.__DSH_LAN__ into every index.html render;
* - prints the boot summary line.
* @param ctx - plugin context (webServer + webRuntime injected).
* @param rawConfig - raw resolved config.
*/
/** Resolve a path under the DSH home directory (reads DSH_HOME env). */
function requireHomePath(name) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "/tmp", ".dsh");
  return join(home, name);
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  extraHosts = config.extraHosts;
  const live = computeLanHosts();
  ctx.provide("lanAccessHosts", live);
  // Push config extras into the connection snapshot right away (it was
  // captured before this plugin activated, so a timer-only sync would leave a
  // boot-time window where the domain is rejected).
  syncSnapshotTrust(ctx, live);
  // Keep the fence's authority list current (DHCP renewals, Wi-Fi switches).
  refreshSuggested(ctx);
  ctx.effect(() => {
    const timer = setInterval(() => {
      refreshLanHosts(live);
      syncSnapshotTrust(ctx, live);
      refreshSuggested(ctx);
    }, 15000);
    return () => clearInterval(timer);
  }, "lan-access: host refresh");
  // The index.html served by the frontend-static fallback carries no
  // Cache-Control, so phones keep serving a stale cached page (e.g. the old
  // pre-fix build) forever. Force no-store on fallback responses EXCEPT the
  // hashed /assets/ files, so every open gets the current page + injections.
  ctx.effect(() => {
    const webServer = ctx.webServer;
    const orig = webServer.fallback;
    if (orig === void 0) return () => {};
    webServer.fallback = (req, res) => {
      const pathname = (() => {
        try { return new URL(req.url ?? "/", "http://x").pathname; } catch { return "/"; }
      })();
      if (!pathname.startsWith("/assets/")) {
        const origWriteHead = res.writeHead.bind(res);
        res.writeHead = (status, ...args) => {
          let headers = args[0];
          let rest = args.slice(1);
          if (typeof headers === "object" && headers !== null && !Array.isArray(headers)) {
            headers = { "cache-control": "no-store", ...headers };
            rest = args.slice(1);
          } else {
            headers = { "cache-control": "no-store" };
            rest = [];
          }
          res.setHeader("cache-control", "no-store");
          return origWriteHead(status, headers, ...rest);
        };
        try { res.setHeader("cache-control", "no-store"); } catch {}
      }
      return orig(req, res);
    };
    return () => { webServer.fallback = orig; };
  }, "lan-access: no-store index");
  // Settings persistence shim: the client-side settings scope picks
  // "host" persistence only when the page origin looks like loopback. A
  // phone served through the auth portal has a public origin, so it falls
  // back to a memory scope that never reads or writes settings. Rewrite the
  // served ui-settings bundle so the scope always uses host persistence —
  // the auth portal is the trust boundary that makes this safe.
  ctx.effect(() => {
    const route = ctx.webServer.prefixes.get("/plugins");
    if (route === void 0) return () => {};
    const orig = route.handler;
    const PATCH_PATH = "/plugins/@deepseek-ai/dsh-client-ui-settings/client.js";
    const FROM = 'connection.isLoopback ? "host" : "memory"';
    const TO = 'connection.isLoopback ? "host" : "host"';
    route.handler = async (req, res) => {
      let pathname = "/";
      try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* keep "/" */ }
      if (pathname !== PATCH_PATH) return orig(req, res);
      const chunks = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
      res.end = (chunk) => {
        if (chunk !== void 0) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        const patched = body.includes(FROM) ? body.replaceAll(FROM, TO) : body;
        const buf = Buffer.from(patched, "utf8");
        origWrite(buf);
        return origEnd();
      };
      await orig(req, res);
    };
    return () => { route.handler = orig; };
  }, "lan-access: settings persistence shim");
  if (config.portalEnabled) {
    if (config.portalPasswordHash === "") {
      console.error("lan-access: portalEnabled but portalPasswordHash missing");
    } else {
      const portalServer = startPortal({
        port: config.portalPort,
        user: config.portalUser,
        passwordHash: config.portalPasswordHash,
        targetPort: ctx.webServer.port,
        sessionFile: requireHomePath("auth-sessions.json")
      });
      ctx.effect(() => () => {
        try { portalServer.close(); } catch { /* already closed */ }
      }, "lan-access: auth portal");
    }
  }
  if (config.frpEnabled) {
    if (config.frpcBinary === "" || config.frpcConfig === "") {
      console.error("lan-access: frpEnabled but frpcBinary/frpcConfig missing");
    } else {
      startFrpc(ctx, config.frpcBinary, config.frpcConfig);
    }
  }
  if (config.tunnelEnabled) {
    if (config.tunnelBinary === "") {
      console.error("lan-access: tunnelEnabled but no tunnelBinary configured");
    } else {
      startTunnel(ctx, config.tunnelBinary, ctx.webServer.port);
    }
  }
  if (config.injectBrowser) {
    ctx.effect(
      () => ctx.webServer.tapIndex((html) => {
        refreshLanHosts(live);
        const seeded = injectLanScript(html, lanPayload(ctx, lanIpv4()));
        const injected = seeded.replace("</head>", randomUuidPolyfillScript() + sessionSeedScript(suggested.id) + "</head>");
        return injected;
      }),
      "lan-access: index injection"
    );
  }
  if (config.printBootLine) printBootLine(ctx, lanPayload(ctx, lanIpv4()));
}

export default { name, inject, apply };