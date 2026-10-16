import { join, normalize } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import type { ApiApp } from "./context";
import { handleAdminApi } from "./routes/admin";
import { RateLimiter } from "./middleware/rate-limit";
import { log } from "../utils/logger";
import { botState } from "../bot/state";

const ADMIN_DIR = join(import.meta.dir, "..", "admin");

// Stricter limit for anything under /api (auth + admin API).
const authLimiter = new RateLimiter(20, 60_000);

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // script-src must allow the official Telegram Mini App SDK origin; everything
  // else stays same-origin. connect-src stays 'self' (the Mini App only calls
  // our own API); img-src covers local product images, inline data: previews,
  // and the admin's Telegram profile photo (specific hosts, no wildcards).
  // style/font-src allow Google Fonts to serve Vazirmatn (the required Persian UI font).
  "content-security-policy":
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://t.me https://cdn4.telesco.pe; connect-src 'self'; frame-ancestors 'self'",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }): string {
  // Socket-level address first — unspoofable by the client.
  const peer = server.requestIP(req)?.address ?? "local";
  // Only honor forwarded headers when a trusted reverse proxy is configured.
  // Without this, any client could spoof X-Forwarded-For to bypass rate limits.
  const trustedProxies = (process.env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (trustedProxies.length > 0) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded && trustedProxies.includes(peer)) {
      return forwarded;
    }
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

function serveFile(absPath: string, rootDir: string): Response | null {
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
      ...SECURITY_HEADERS,
    },
  });
}

export function createHttpServer(app: ApiApp) {
  return Bun.serve({
    port: app.config.httpPort,
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
        const ip = clientIp(req, server);
        if (!authLimiter.check(`auth:${ip}`)) {
          return json({ error: "too many requests" }, 429);
        }
        try {
          const res = await handleAdminApi(req, app);
          if (res) {
            // Ensure security headers on API responses too.
            const headers = new Headers(res.headers);
            for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
            return new Response(res.body, { status: res.status, headers });
          }
        } catch (err) {
          log.error("admin api crash", { err: String(err) });
          return json({ error: "internal error" }, 500);
        }
        return json({ error: "not found" }, 404);
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
      const f = serveFile(abs, ADMIN_DIR);
      if (f) return f;

      // SPA-ish fallback: serve index.html for unknown non-file paths under admin dir.
      const index = serveFile(join(ADMIN_DIR, "index.html"), ADMIN_DIR);
      if (index && !path.startsWith("/api/")) return index;

      return json({ error: "not found" }, 404);
    },
  });
}
