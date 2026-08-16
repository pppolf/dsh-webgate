// dsh-webgate — auth portal (zero-dependency).
// A tiny cookie-session login gate + reverse proxy that sits in FRONT of the
// DSH web server inside the frp tunnel path:
//
//   browser → Cloudflare → Caddy(TLS) → frp tunnel → portal:8081 → 127.0.0.1:3080
//
// Why: HTTP Basic Auth loops forever in iOS Safari (it won't attach the
// credentials to WebSocket reconnect handshakes), and Cloudflare Access needs
// a payment method. A plain HTML login form + HttpOnly cookie works in every
// browser, including Safari and WeChat webviews.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";

const SESSION_COOKIE = "dsh_session";
const TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

const LOGIN_PAGE = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>登录 — DeepSeek Harness</title>',
  '<style>',
  'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}',
  '.card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:32px 28px;width:min(92vw,340px);box-shadow:0 12px 40px rgba(0,0,0,.4)}',
  'h1{font-size:18px;margin:0 0 6px}',
  'p{color:#8a93a3;font-size:13px;margin:0 0 20px}',
  'input{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;color:#e6e6e6;padding:10px 12px;font-size:15px;margin-bottom:10px}',
  'button{width:100%;background:#3d7bfd;border:none;border-radius:8px;color:#fff;padding:11px;font-size:15px;font-weight:600;cursor:pointer}',
  '.err{color:#ff8080;font-size:13px;margin:10px 0 0;min-height:18px}',
  '</style></head><body>',
  '<div class="card">',
  '<h1>登录</h1><p>访问 DeepSeek Harness 需要登录</p>',
  '<form method="post" action="/__auth__/login">',
  '<input type="text" name="user" placeholder="用户名" autocomplete="username" required>',
  '<input type="password" name="pass" placeholder="密码" autocomplete="current-password" required>',
  '<button type="submit">登 录</button>',
  '<div class="err">__MESSAGE__</div>',
  '</form></div></body></html>'
].join("\n");

/**
* Verify a scrypt password record "saltHex$hashHex" (N=16384,r=8,p=1,keylen=64).
* @param input - plaintext password.
* @param record - stored record.
* @returns true when the password matches.
*/
function verifyPassword(input, record) {
  try {
    const [saltHex, hashHex] = String(record).split("$");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(String(input), Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Hash a plaintext password into the stored record format. */
export function hashPassword(plaintext) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plaintext), salt, 64, { N: 16384, r: 8, p: 1 });
  return salt.toString("hex") + "$" + hash.toString("hex");
}

/**
* Start the auth portal.
* @param opts - { port, user, passwordHash, targetPort, sessionFile }
* @returns the http server.
*/
export function startPortal(opts) {
  const { port, user, passwordHash, targetPort, sessionFile } = opts;
  const sessions = new Map();
  if (existsSync(sessionFile)) {
    try {
      for (const [token, exp] of Object.entries(JSON.parse(readFileSync(sessionFile, "utf8")))) {
        if (typeof exp === "number" && exp > Date.now()) sessions.set(token, exp);
      }
    } catch { /* corrupt file: start empty */ }
  }
  const persist = () => {
    try { writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions))); } catch { /* best effort */ }
  };
  const attempts = new Map();
  const throttled = (ip) => {
    const now = Date.now();
    const row = attempts.get(ip);
    if (row === void 0 || now - row.since > 60000) { attempts.set(ip, { since: now, count: 1 }); return false; }
    row.count++;
    return row.count > 10;
  };
  const cookieOf = (req) => {
    const header = req.headers.cookie;
    if (typeof header !== "string") return void 0;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
    }
    return void 0;
  };
  const validSession = (req) => {
    const token = cookieOf(req);
    if (token === void 0) return false;
    const expires = sessions.get(token);
    return expires !== void 0 && expires >= Date.now();
  };
  // Rewrite Host + Origin to the loopback target so the DSH server treats
  // every proxied request as coming from the local machine: the browser-trust
  // fence and the privileged (loopback-only) settings/credentials APIs then
  // accept them. The auth portal IS the trust boundary here.
  const rewriteHeaders = (headers) => {
    const out = { ...headers };
    out.host = "127.0.0.1:" + String(targetPort);
    if (out.origin !== void 0) out.origin = "http://127.0.0.1:" + String(targetPort);
    return out;
  };
  const respond = (res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const redirect = (res, location) => respond(res, 302, { location, "cache-control": "no-store" }, "");
  const loginPage = (message) => LOGIN_PAGE.replace("__MESSAGE__", message);

  const server = createServer((req, res) => {
    let pathname = "/";
    try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* keep "/" */ }
    if (pathname === "/__auth__/login") {
      if (req.method === "POST") {
        let data = "";
        req.on("data", (chunk) => { data += chunk; if (data.length > 8192) req.destroy(); });
        req.on("end", () => {
          const ip = req.socket.remoteAddress ?? "?";
          if (throttled(ip)) { respond(res, 429, { "content-type": "text/html; charset=utf-8" }, loginPage("尝试过于频繁，请稍后再试")); return; }
          const fields = {};
          for (const pair of data.split("&")) {
            const eq = pair.indexOf("=");
            if (eq >= 0) fields[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
          }
          if (fields.user === user && verifyPassword(fields.pass ?? "", passwordHash)) {
            const token = randomBytes(24).toString("hex");
            sessions.set(token, Date.now() + TTL_MS);
            persist();
            respond(res, 302, {
              location: "/",
              "set-cookie": SESSION_COOKIE + "=" + token + "; Path=/; Max-Age=" + String(TTL_MS / 1000) + "; HttpOnly; Secure; SameSite=Lax",
              "cache-control": "no-store"
            }, "");
          } else {
            respond(res, 401, { "content-type": "text/html; charset=utf-8" }, loginPage("用户名或密码错误"));
          }
        });
      } else {
        respond(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, loginPage(""));
      }
      return;
    }
    if (!validSession(req)) { redirect(res, "/__auth__/login"); return; }
    // reverse proxy to the DSH server (Host passthrough keeps the fence happy)
    const headers = rewriteHeaders(req.headers);
    delete headers.connection;
    const upstream = request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  });

  // WebSocket upgrade proxy (cookie-checked)
  server.on("upgrade", (req, socket, head) => {
    if (!validSession(req)) { socket.destroy(); return; }
    // Keep Connection: Upgrade intact — the downstream http server needs it
    // to route the request to its own upgrade handler.
    const headers = rewriteHeaders(req.headers);
    const up = connect({ host: "127.0.0.1", port: targetPort }, () => {
      const lines = [req.method + " " + req.url + " HTTP/1.1"];
      for (const [k, v] of Object.entries(headers)) if (v !== void 0) lines.push(k + ": " + v);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head !== void 0 && head.length > 0) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("lan-access: auth portal listening on 127.0.0.1:" + String(port));
  });
  return server;
}