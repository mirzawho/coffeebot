/* Admin API helper — sends Telegram initData on every request. No framework. */
"use strict";

const Api = (() => {
  function initData() {
    const tg = window.Telegram && window.Telegram.WebApp;
    return (tg && tg.initData) || "";
  }

  async function request(method, path, body) {
    const headers = { "x-telegram-init-data": initData() };
    let payload;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
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
  };
})();
