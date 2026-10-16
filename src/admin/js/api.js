/* Admin API helper — sends Telegram initData on every request. No framework. */
"use strict";

const Api = (() => {
  const HEADER = "x-telegram-init-data";
  const MAX_RETRIES = 2;

  /**
   * API base URL. Empty string = same-origin relative paths — the production
   * setup: panel and API share one origin, so no CORS and no redirect.
   * Override with window.ADMIN_API_BASE_URL for split deployments. It must be
   * the absolute https origin WITHOUT a trailing slash: a wrong value makes
   * fetch() follow a redirect, and redirects drop custom headers (301/302 also
   * rewrite POST to GET), which surfaces as "missing x-telegram-init-data".
   */
  function baseUrl() {
    let base = typeof window.ADMIN_API_BASE_URL === "string" ? window.ADMIN_API_BASE_URL.trim() : "";
    if (!base) return "";
    base = base.replace(/\/+$/, "");
    if (/^http:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(base)) {
      console.warn(`[api] ADMIN_API_BASE_URL must be https in production (got "${base}") — forcing https.`);
      base = "https://" + base.slice(7);
    }
    return base;
  }

  /** Telegram WebApp object, or null when the page is not inside Telegram. */
  function webApp() {
    return (window.Telegram && window.Telegram.WebApp) || null;
  }

  /**
   * Resolve the signed initData string.
   *
   * Production: window.Telegram.WebApp.initData, injected by the Telegram SDK
   * (telegram-web-app.js) when the Mini App is opened from inside Telegram.
   *
   * Dev fallback: ?initData=... / ?tgWebAppData=... in the URL, so the panel can
   * be opened in a plain browser. The server only honors these when
   * ALLOW_INIT_DATA_QUERY=1, so this is inert in production.
   *
   * NOTE: never use initDataUnsafe — it is unsigned and the server rejects it.
   */
  function initData() {
    const tg = webApp();
    if (tg && typeof tg.initData === "string" && tg.initData) return tg.initData;

    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get("initData") || params.get("tgWebAppData");
      if (fromQuery) return fromQuery;
    } catch {
      /* ignore malformed URLs */
    }
    return "";
  }

  /** True when the page is running inside Telegram with a signed payload. */
  function isTelegram() {
    const tg = webApp();
    return !!(tg && typeof tg.initData === "string" && tg.initData);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Telegram Init Awaiter. Bounded wait for the Telegram SDK to inject
   * initData: some clients populate window.Telegram.WebApp.initData
   * asynchronously after telegram-web-app.js loads, so the first request can
   * otherwise race ahead of the SDK and go out with an empty header. Calls
   * ready(), then polls every 100ms for up to 3s. Resolves immediately when
   * the page is not inside Telegram (plain-browser dev fallback) or once
   * initData is present; logs a clear warning on timeout.
   */
  function whenTelegramReady(timeoutMs = 3000) {
    const tg = webApp();
    if (!tg || (typeof tg.initData === "string" && tg.initData)) return Promise.resolve();
    if (typeof tg.ready === "function") tg.ready();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const t = webApp();
        if (t && typeof t.initData === "string" && t.initData) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          console.warn(
            `[api] Telegram initData still empty after ${timeoutMs}ms — ` +
              (t
                ? "the SDK loaded but never injected initData. Reopen the panel from inside the bot."
                : "the Telegram SDK did not load at all (window.Telegram missing). Check the network/CDN for telegram-web-app.js."),
          );
          resolve();
        }
      }, 100);
    });
  }

  let readyPromise = null;
  function telegramReady() {
    if (!readyPromise) readyPromise = whenTelegramReady();
    return readyPromise;
  }

  /** Human-readable Persian message for a failed response. */
  function messageFor(status, data) {
    const serverMsg = data && typeof data.error === "string" ? data.error : "";
    if (status === 429) {
      return "تعداد درخواست‌ها زیاد است. چند لحظه صبر کنید و دوباره تلاش کنید.";
    }
    if (status === 401) {
      return "برای استفاده از پنل مدیریت، آن را از داخل ربات تلگرام باز کنید.";
    }
    if (status === 403) {
      return "این حساب دسترسی مدیریت ندارد.";
    }
    if (status === 413) {
      return "حجم فایل ارسالی بیش از حد مجاز است.";
    }
    if (status >= 500) {
      return "خطای داخلی سرور. لطفاً بعداً دوباره تلاش کنید.";
    }
    return serverMsg || `خطا در ارتباط با سرور (${status})`;
  }

  async function request(method, path, body, attempt = 0) {
    // First request waits (bounded) for the Telegram SDK so the header is never
    // empty because of a startup race.
    await telegramReady();

    const headers = {};
    // Read at request time, never cached at module load — initData is injected
    // asynchronously by the Telegram SDK.
    const token = initData();
    if (token) {
      headers[HEADER] = token;
    } else {
      // Interceptor-equivalent warning: a request without this header can only
      // end in the 401 "missing x-telegram-init-data".
      console.warn(
        `⚠️ Warning: Sending API request with EMPTY ${HEADER}! ` +
          `method=${method} path=${path} insideTelegram=${!!webApp()}`,
      );
    }
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(baseUrl() + path, {
        method,
        headers,
        body: payload,
        // Same-origin in production; the server echoes CORS headers when the
        // panel is opened from web.telegram.org.
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (networkErr) {
      const err = new Error("ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.");
      err.status = 0;
      err.cause = networkErr;
      throw err;
    }

    // A redirect strips custom headers (and 301/302 rewrite POST to GET), so a
    // redirected request can never authenticate. Surface it loudly instead of
    // letting it masquerade as a missing-header bug.
    if (res.redirected) {
      console.warn(
        `[api] ${method} ${path} was redirected to ${res.url} — the ${HEADER} header was dropped by the redirect. ` +
          "Fix the API base URL (https, no trailing slash) and nginx (no internal redirects) so requests go out directly.",
      );
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    // Transparent retry on 429 — the server sends Retry-After. This keeps a
    // burst of panel requests (dashboard + reports + products) from surfacing
    // as a hard error to the user.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 800 * (attempt + 1);
      await sleep(waitMs);
      return request(method, path, body, attempt + 1);
    }

    if (!res.ok) {
      const err = new Error(messageFor(res.status, data));
      err.status = res.status;
      err.code = (data && data.code) || null;
      err.retryAfter = res.headers.get("retry-after");
      throw err;
    }
    return data;
  }

  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    del: (p) => request("DELETE", p),
    initData,
    isTelegram,
    whenReady: telegramReady,
  };
})();
