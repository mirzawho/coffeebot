/* Admin API helper — sends Telegram initData on every request. No framework. */
"use strict";

const Api = (() => {
  const HEADER = "x-telegram-init-data";
  const MAX_RETRIES = 2;

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
    const headers = {};
    const token = initData();
    if (token) headers[HEADER] = token;
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(path, {
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
  };
})();
