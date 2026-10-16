export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  botToken: string;
  adminIds: Set<number>;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  appBaseUrl: string;
  databasePath: string;
  timezone: string;
  logLevel: LogLevel;
  httpPort: number;
  /** Optional HTTP CONNECT proxy for outbound calls (Telegram API, Ollama). */
  outboundProxyUrl: string;
  /** Editable AI persona file (style only; core rules stay in code). */
  aiPersonaFile: string;
  /**
   * Number of trusted reverse-proxy hops in front of the app (Express's
   * `app.set('trust proxy', N)`). 0 = not behind a proxy. Used only when
   * TRUSTED_PROXIES is empty; TRUSTED_PROXIES is preferred because it cannot
   * be defeated by adding extra hops.
   */
  trustProxy: number;
  /**
   * DEV ONLY: accept initData from ?initData= / ?tgWebAppData= query params.
   * Never enable in production (query strings leak into logs and Referer).
   */
  allowInitDataQuery: boolean;
}

export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  if (!raw || !raw.trim()) return ids;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue; // tolerate trailing commas / extra whitespace
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `Invalid ADMIN_IDS entry: "${trimmed}". Must be numeric Telegram user IDs, comma-separated (e.g. ADMIN_IDS=123456789,987654321). Ask the user for their numeric ID via the bot's /whoami command if unknown.`,
      );
    }
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid ADMIN_IDS entry: "${trimmed}". Telegram user IDs are positive integers.`);
    }
    ids.add(id);
  }
  return ids;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "info").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  throw new Error(`Invalid LOG_LEVEL: "${raw}". Use debug, info, warn, or error.`);
}

/** "1"/"true"/"yes"/"on" (case-insensitive) => true; anything else => false. */
function parseBool(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * The Mini App URL must be an absolute https origin (Telegram requirement),
 * except localhost/127.0.0.1 which may use http for development.
 */
function parseAppBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error(
      "APP_BASE_URL is required. Set it to the public HTTPS origin where this app is served, e.g. APP_BASE_URL=https://cafe.example.com (no trailing path).",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid APP_BASE_URL: "${trimmed}". Expected an absolute URL like https://cafe.example.com`,
    );
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error(
      `Invalid APP_BASE_URL: "${trimmed}". Telegram Mini Apps require HTTPS (plain http is only allowed for localhost during development).`,
    );
  }
  if (url.search || url.hash) {
    throw new Error(`Invalid APP_BASE_URL: "${trimmed}". Do not include query strings or fragments.`);
  }
  // Normalize to origin only — the Mini App is served at "/".
  return `${url.protocol}//${url.host}`;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const botToken = (env.BOT_TOKEN ?? "").trim();
  if (!botToken) throw new Error("BOT_TOKEN is required");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    throw new Error("BOT_TOKEN format looks invalid. Expected digits:secret.");
  }

  const adminIds = parseAdminIds(env.ADMIN_IDS);
  if (adminIds.size === 0) {
    throw new Error(
      "ADMIN_IDS must contain at least one numeric Telegram user ID, comma-separated (e.g. ADMIN_IDS=123456789,987654321).",
    );
  }

  const timezone = (env.TIMEZONE ?? "Asia/Tehran").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Invalid TIMEZONE: "${timezone}"`);
  }

  const databasePath = (env.DATABASE_PATH ?? "data/cafe.sqlite").trim();
  const httpPort = Number(env.HTTP_PORT ?? "3000");
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`Invalid HTTP_PORT: "${env.HTTP_PORT}"`);
  }

  // Trusted reverse-proxy hops (Express's `app.set('trust proxy', N)`).
  // 0 = direct exposure. Only consulted when TRUSTED_PROXIES is empty.
  const trustProxyRaw = (env.TRUST_PROXY ?? "0").trim();
  const trustProxy = Number(trustProxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
    throw new Error(
      `Invalid TRUST_PROXY: "${trustProxyRaw}". Use 0 (no proxy) or the number of proxy hops, e.g. TRUST_PROXY=1 behind nginx.`,
    );
  }

  // Optional outbound proxy. Bun's fetch only supports HTTP(S) CONNECT proxies
  // (socks5:// is rejected), so validate the scheme up-front with a clear error.
  const outboundProxyUrl = (env.OUTBOUND_PROXY_URL ?? "").trim().replace(/\/$/, "");  if (outboundProxyUrl) {
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(outboundProxyUrl);
    } catch {
      throw new Error(
        `Invalid OUTBOUND_PROXY_URL: "${outboundProxyUrl}". Expected http://host:port`,
      );
    }
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new Error(
        `Invalid OUTBOUND_PROXY_URL: only http:// proxies are supported (Bun fetch cannot use socks5). Convert your socks5 proxy with e.g. gost -L http://:8118 -F socks5://127.0.0.1:1080`,
      );
    }
  }

  return {
    botToken,
    adminIds,
    ollamaApiKey: (env.OLLAMA_API_KEY ?? "").trim(),
    ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? "https://ollama.com/v1").trim().replace(/\/$/, ""),
    ollamaModel: (env.OLLAMA_MODEL ?? "gemma4:cloud").trim(),
    appBaseUrl: parseAppBaseUrl(env.APP_BASE_URL),
    databasePath,
    timezone,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    httpPort,
    outboundProxyUrl,
    aiPersonaFile: (env.AI_PERSONA_FILE ?? "").trim(),
    trustProxy,
    allowInitDataQuery: parseBool(env.ALLOW_INIT_DATA_QUERY),
  };
}
