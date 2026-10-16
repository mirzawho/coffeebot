import { describe, test, expect } from "bun:test";
import { loadConfig, parseAdminIds } from "../src/config";

const BASE = {
  BOT_TOKEN: "123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ",
  ADMIN_IDS: "111,222",
  APP_BASE_URL: "https://cafe.example.com",
};

describe("parseAdminIds", () => {
  test("parses comma-separated ids and tolerates whitespace/trailing commas", () => {
    const ids = parseAdminIds(" 111 , 222 ,, 333 ");
    expect([...ids].sort((a, b) => a - b)).toEqual([111, 222, 333]);
  });

  test("empty input yields an empty set", () => {
    expect(parseAdminIds(undefined).size).toBe(0);
    expect(parseAdminIds("   ").size).toBe(0);
  });

  test("rejects non-numeric entries", () => {
    expect(() => parseAdminIds("111,abc")).toThrow(/Invalid ADMIN_IDS/);
  });

  test("rejects zero and negative ids", () => {
    expect(() => parseAdminIds("0")).toThrow();
    expect(() => parseAdminIds("-5")).toThrow();
  });
});

describe("loadConfig", () => {
  test("loads a valid environment with defaults", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.botToken).toBe(BASE.BOT_TOKEN);
    expect([...cfg.adminIds].sort((a, b) => a - b)).toEqual([111, 222]);
    expect(cfg.appBaseUrl).toBe("https://cafe.example.com");
    expect(cfg.timezone).toBe("Asia/Tehran");
    expect(cfg.ollamaBaseUrl).toBe("https://ollama.com/v1");
    expect(cfg.ollamaModel).toBe("gemma4:cloud");
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.logLevel).toBe("info");
  });

  test("requires BOT_TOKEN", () => {
    expect(() => loadConfig({ ...BASE, BOT_TOKEN: "" })).toThrow(/BOT_TOKEN is required/);
  });

  test("rejects a malformed BOT_TOKEN", () => {
    expect(() => loadConfig({ ...BASE, BOT_TOKEN: "not-a-token" })).toThrow(/format looks invalid/);
  });

  test("requires at least one admin id", () => {
    expect(() => loadConfig({ ...BASE, ADMIN_IDS: "" })).toThrow(/ADMIN_IDS must contain/);
  });

  test("requires APP_BASE_URL", () => {
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: "" })).toThrow(/APP_BASE_URL is required/);
  });

  test("rejects plain http for non-local hosts (Telegram requires HTTPS)", () => {
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: "http://cafe.example.com" })).toThrow(/HTTPS/);
  });

  test("allows http for localhost development", () => {
    const cfg = loadConfig({ ...BASE, APP_BASE_URL: "http://localhost:3000" });
    expect(cfg.appBaseUrl).toBe("http://localhost:3000");
  });

  test("normalizes APP_BASE_URL to an origin (drops path and trailing slash)", () => {
    const cfg = loadConfig({ ...BASE, APP_BASE_URL: "https://cafe.example.com/admin/" });
    expect(cfg.appBaseUrl).toBe("https://cafe.example.com");
  });

  test("rejects query strings and fragments in APP_BASE_URL", () => {
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: "https://cafe.example.com/?x=1" })).toThrow(
      /query strings or fragments/,
    );
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: "https://cafe.example.com/#frag" })).toThrow(
      /query strings or fragments/,
    );
  });

  test("rejects an invalid TIMEZONE", () => {
    expect(() => loadConfig({ ...BASE, TIMEZONE: "Not/AZone" })).toThrow(/Invalid TIMEZONE/);
  });

  test("rejects an out-of-range HTTP_PORT", () => {
    expect(() => loadConfig({ ...BASE, HTTP_PORT: "0" })).toThrow(/Invalid HTTP_PORT/);
    expect(() => loadConfig({ ...BASE, HTTP_PORT: "70000" })).toThrow(/Invalid HTTP_PORT/);
    expect(() => loadConfig({ ...BASE, HTTP_PORT: "abc" })).toThrow(/Invalid HTTP_PORT/);
  });

  test("rejects an invalid LOG_LEVEL", () => {
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: "verbose" })).toThrow(/Invalid LOG_LEVEL/);
  });

  test("trims a trailing slash from OLLAMA_BASE_URL", () => {
    const cfg = loadConfig({ ...BASE, OLLAMA_BASE_URL: "https://ollama.com/v1/" });
    expect(cfg.ollamaBaseUrl).toBe("https://ollama.com/v1");
  });
});

describe("OUTBOUND_PROXY_URL", () => {
  test("empty by default", () => {
    const c = loadConfig({ ...BASE });
    expect(c.outboundProxyUrl).toBe("");
  });

  test("accepts an http proxy URL and strips the trailing slash", () => {
    const c = loadConfig({
      ...BASE,
      OUTBOUND_PROXY_URL: "http://host.docker.internal:8118/",
    });
    expect(c.outboundProxyUrl).toBe("http://host.docker.internal:8118");
  });

  test("rejects socks5 with an actionable error (Bun fetch limitation)", () => {
    expect(() =>
      loadConfig({ ...BASE, OUTBOUND_PROXY_URL: "socks5://127.0.0.1:1080" }),
    ).toThrow(/socks5/);
  });

  test("rejects garbage URLs", () => {
    expect(() =>
      loadConfig({ ...BASE, OUTBOUND_PROXY_URL: "not a url" }),
    ).toThrow(/OUTBOUND_PROXY_URL/);
  });
});
