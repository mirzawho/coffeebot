import { join, normalize } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import type { ApiApp } from "./context";
import { handleAdminApi } from "./routes/admin";
import { RateLimiter } from "./middleware/rate-limit";
import { log } from "../utils/logger";
import { botState } from "../bot/state";

const ADMIN_DIR = join(import.meta.dir, "..", "admin");

// Per-IP limit for anything under /api (auth + admin API). Sized generously
// (5000/min) because the panel fires a burst of parallel requests on load and
// a collapsed IP bucket (proxy misconfig) must never lock operators out.
const authLimiter = new RateLimiter(5000, 60_000);

const BASE_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://t.me https://cdn4.telesco.pe; connect-src 'self'; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org";

// DEBUG=true only: eruda is loaded from jsdelivr and bootstrapped with an inline
// script, so both need to be allowed. Never used in production.
const DEBUG_CSP = BASE_CSP.replace(
  "script-src 'self' https://telegram.org",
  "script-src 'self' https://telegram.org https://cdn.jsdelivr.net 'unsafe-inline'",
).replace("connect-src 'self'", "connect-src 'self' https://cdn.jsdelivr.net");

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // NOTE: no X-Frame-Options. Telegram Web renders Mini Apps inside an iframe,
  // and X-Frame-Options: DENY makes the panel render as a blank page there.
  // Framing is controlled by CSP frame-ancestors instead, which is the modern
  // replacement and can express "Telegram may frame me, nobody else".
  // The Telegram Web hosts are listed explicitly (no wildcard) so a compromised
  // or look-alike subdomain cannot frame the panel.
  //
  // script-src must allow the official Telegram Mini App SDK origin; everything
  // else stays same-origin. connect-src stays 'self' (the Mini App only calls
  // our own API); img-src covers local product images, inline data: previews,
  // and the admin's Telegram profile photo (specific hosts, no wildcards).
  // style/font-src allow Google Fonts to serve Vazirmatn (the required Persian UI font).
  "content-security-policy": BASE_CSP,
};

/** Security headers for a response; the debug variant widens the CSP for eruda. */
export function securityHeaders(debug = false): Record<string, string> {
  if (!debug) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, "content-security-policy": DEBUG_CSP };
}

// Injected into index.html when DEBUG=true so the panel can be inspected from
// inside Telegram (no devtools there).
const ERUDA_SNIPPET = `  <script src="https://cdn.jsdelivr.net/npm/eruda"></script>
  <script>eruda.init();</script>
`;

function injectDebugConsole(html: string): string {
  if (html.includes("eruda")) return html;
  return html.includes("</body>")
    ? html.replace("</body>", `${ERUDA_SNIPPET}</body>`)
    : html + ERUDA_SNIPPET;
}

/**
 * CORS for the Mini App.
 *
 * Same-origin requests (the normal case: the panel is served by this very
 * server) need no CORS at all. It matters when the panel is opened from
 * web.telegram.org — Telegram Web hosts Mini Apps in an iframe on a different
 * origin — or from a local dev server. Only exact origins are echoed back;
 * never "*", because the API is credentialed and a wildcard would let any
 * website read admin responses.
 */
const ALLOWED_CORS_ORIGINS = new Set([
  "https://web.telegram.org",
  "https://webk.telegram.org",
  "https://webz.telegram.org",
]);

function corsHeaders(req: Request, app: ApiApp): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  const allowed =
    ALLOWED_CORS_ORIGINS.has(origin) ||
    origin === app.config.appBaseUrl ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-telegram-init-data, authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/**
 * Resolve the real client IP.
 *
 * X-Forwarded-For is a comma-separated chain: `client, proxy1, proxy2`. Each
 * proxy APPENDS the address it received the connection from, so the RIGHTMOST
 * entry is the most trustworthy one and the leftmost is fully client-supplied.
 * We therefore walk the chain from the right and skip every address that
 * belongs to a trusted proxy; the first untrusted address is the client.
 *
 * This is what makes `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
 * in nginx safe: a client sending `X-Forwarded-For: 1.2.3.4` only prepends a
 * bogus entry, which we never reach because nginx's own appended address is
 * already untrusted.
 *
 * Trust is configured with TRUSTED_PROXIES (explicit IPs, preferred) or
 * TRUST_PROXY (number of hops, like Express's `app.set('trust proxy', N)`).
 */
export function clientIp(
  req: Request,
  server: { requestIP(r: Request): { address: string } | null },
  trustProxy = 0,
): string {
  // Socket-level address first — unspoofable by the client.
  const peer = server.requestIP(req)?.address ?? "local";

  const trustedProxies = (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const forwarded = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Explicit allowlist: only honor XFF when the peer really is a known proxy.
  if (trustedProxies.length > 0) {
    if (!trustedProxies.includes(peer)) return peer;
    for (let i = forwarded.length - 1; i >= 0; i--) {
      const candidate = forwarded[i]!;
      if (!trustedProxies.includes(candidate)) return candidate;
    }
    return peer;
  }

  // Hop-count mode: trust the last N entries (the proxies) and take the one
  // before them. With TRUST_PROXY=1 and `client, nginx` we return `client`.
  if (trustProxy > 0 && forwarded.length > 0) {
    const idx = forwarded.length - 1 - trustProxy;
    if (idx >= 0) return forwarded[idx]!;
    // Fewer entries than trusted hops: the chain is shorter than expected, so
    // fall back to the leftmost entry rather than trusting a proxy address.
    return forwarded[0]!;
  }

  return peer;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveFile(
  absPath: string,
  rootDir: string,
  headers: Record<string, string> = SECURITY_HEADERS,
): Response | null {
  // Only files inside rootDir are servable — no traversal outside the given root.
  if (!absPath.startsWith(rootDir + "/")) return null;
  if (!existsSync(absPath)) return null;
  const st = statSync(absPath);
  if (!st.isFile()) return null;
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  const body = createReadStream(absPath);
  return new Response(body as any, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300",
      ...headers,
    },
  });
}

/** Serve the Mini App HTML, injecting the eruda console when DEBUG=true. */
async function serveAdminHtml(absPath: string, app: ApiApp): Promise<Response | null> {
  const headers = securityHeaders(app.config.debug);
  if (!app.config.debug) return serveFile(absPath, ADMIN_DIR, headers);
  if (!absPath.startsWith(ADMIN_DIR + "/") || !existsSync(absPath)) return null;
  const html = injectDebugConsole(await Bun.file(absPath).text());
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...headers },
  });
}

export function createHttpServer(app: ApiApp) {
  return Bun.serve({
    port: app.config.httpPort,
    // Bind to all interfaces explicitly. Bun's default (hostname "localhost")
    // resolves to ::1 on Linux, which breaks IPv4 connections from the test
    // suite (http://127.0.0.1:...) and, in the Docker image, makes the app
    // unreachable from outside the container.
    hostname: "0.0.0.0",
    // Image uploads go base64 in JSON: a 2MB image is ~2.7MB base64 — allow headroom.
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Health check — unauthenticated, no secrets. Reports bot readiness so
      // a failed bot start is observable (200 with bot:failed, or 503 when
      // the bot has permanently failed).
      if (path === "/health" || path === "/healthz") {
        const bot = botState.failed
          ? { status: "failed" as const, error: botState.lastError }
          : botState.running
            ? { status: "running" as const }
            : { status: "starting" as const };
        const ok = !botState.failed;
        return new Response(
          JSON.stringify({ ok, uptime: process.uptime(), bot }),
          {
            status: ok ? 200 : 503,
            headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
          },
        );
      }

      // Admin API (auth + rate-limited).
      if (path.startsWith("/api/admin/")) {
        const cors = corsHeaders(req, app);

        // CORS preflight: the browser sends OPTIONS before any request that
        // carries the custom x-telegram-init-data header. Answer it here so the
        // real request is never rejected by the auth layer.
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
        }

        // TEMP DIAGNOSTIC: traces initData delivery end-to-end. Remove once
        // production is stable. Length only — the header value is never logged.
        const initDataLen = req.headers.get("x-telegram-init-data")?.length ?? 0;
        console.log(
          `[diag] Incoming Request: ${req.method} ${path} | initData Header Length: ${initDataLen} | Client IP seen by App: ${clientIp(req, server, app.config.trustProxy)}`,
        );

        const ip = clientIp(req, server, app.config.trustProxy);
        if (!authLimiter.check(`auth:${ip}`)) {
          // JSON (never HTML) + Retry-After so the Mini App can show a real
          // message instead of a generic "خطا در دریافت اطلاعات".
          return json(
            { error: "too many requests", code: "RATE_LIMITED" },
            429,
            { "retry-after": "5", ...cors },
          );
        }
        try {
          const res = await handleAdminApi(req, app);
          if (res) {
            // Ensure security + CORS headers on API responses too.
            const headers = new Headers(res.headers);
            for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
            for (const [k, v] of Object.entries(cors)) headers.set(k, v);
            return new Response(res.body, { status: res.status, headers });
          }
        } catch (err) {
          log.error("admin api crash", { err: String(err) });
          return json({ error: "internal error" }, 500, cors);
        }
        return json({ error: "not found" }, 404, cors);
      }

      // Any other /api path is rejected (no public customer API exposes secrets).
      if (path.startsWith("/api/")) {
        return json({ error: "not found" }, 404);
      }

      // Product images served from data volume.
      if (path.startsWith("/uploads/")) {
        const rel = normalize(path.replace(/^\/uploads\//, ""));
        if (rel.includes("..")) return json({ error: "bad path" }, 400);
        const abs = join(app.uploadsDir, rel);
        const f = serveFile(abs, app.uploadsDir);
        if (f) return f;
        return json({ error: "not found" }, 404);
      }

      // Static admin Mini App.
      let staticPath = path === "/" ? "/index.html" : path;
      if (!staticPath.includes(".")) staticPath += ".html"; // allow /dashboard -> /dashboard.html if added later
      const abs = join(ADMIN_DIR, normalize(staticPath));
      // Only HTML documents need the debug CSP — a CSP on a JS/CSS response is
      // never enforced, so assets keep the production headers.
      const f = abs.endsWith(".html")
        ? await serveAdminHtml(abs, app)
        : serveFile(abs, ADMIN_DIR);
      if (f) return f;

      // SPA-ish fallback: serve index.html for unknown non-file paths under admin dir.
      const index = await serveAdminHtml(join(ADMIN_DIR, "index.html"), app);
      if (index && !path.startsWith("/api/")) return index;

      return json({ error: "not found" }, 404);
    },
  });
}
