import { describe, test, expect } from "bun:test";
import { SECURITY_HEADERS, clientIp } from "../src/api/server";

describe("CSP (BUG-001 regression)", () => {
  const csp = SECURITY_HEADERS["content-security-policy"]!;

  test("permits the official Telegram Mini App SDK origin in script-src", () => {
    expect(csp).toContain("script-src 'self' https://telegram.org");
  });

  test("does not introduce broad script permissions", () => {
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("'unsafe-eval'");
    // No other external script origins.
    const scriptPart = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"))!;
    const origins = scriptPart.replace("script-src", "").trim().split(/\s+/);
    expect(origins.sort()).toEqual(["'self'", "https://telegram.org"]);
  });

  test("keeps connect-src same-origin (Mini App only calls our API)", () => {
    expect(csp).toContain("connect-src 'self'");
  });

  test("keeps img-src restricted to self, data, and specific Telegram photo hosts", () => {
    const imgPart = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("img-src"))!;
    const origins = imgPart.replace("img-src", "").trim().split(/\s+/);
    expect(origins.sort()).toEqual([
      "'self'",
      "data:",
      "https://cdn4.telesco.pe",
      "https://t.me",
    ]);
    // No wildcard image origins — only the two known Telegram profile-photo hosts.
    expect(origins.some((o) => o.includes("*"))).toBe(false);
  });

  test("permits Google Fonts for Vazirmatn and nothing broader", () => {
    const stylePart = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("style-src"))!;
    expect(stylePart).toContain("https://fonts.googleapis.com");
    const fontPart = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("font-src"))!;
    expect(fontPart.replace("font-src", "").trim().split(/\s+/)).toEqual(["https://fonts.gstatic.com"]);
  });

  test("does not send X-Frame-Options (Telegram Web frames the Mini App)", () => {
    expect(SECURITY_HEADERS["x-frame-options"]).toBeUndefined();
  });

  test("allows Telegram to frame the Mini App, and nobody else", () => {
    const framePart = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("frame-ancestors"))!;
    const origins = framePart.replace("frame-ancestors", "").trim().split(/\s+/);
    expect(origins).toContain("'self'");
    expect(origins).toContain("https://web.telegram.org");
    // Never a bare wildcard — only the *.telegram.org subdomain form.
    expect(origins).not.toContain("*");
    expect(origins.every((o) => o === "'self'" || o.endsWith("telegram.org"))).toBe(true);
  });

  test("index.html loads the SDK from the permitted origin", async () => {
    const html = await Bun.file("src/admin/index.html").text();
    expect(html).toContain('<script src="https://telegram.org/js/telegram-web-app.js"></script>');
  });
});

describe("client IP extraction (BUG-006 regression)", () => {
  const fakeServer = (address: string) => ({ requestIP: () => ({ address }) });

  test("uses socket address when no forwarded headers", () => {
    const req = new Request("http://x/");
    expect(clientIp(req, fakeServer("10.0.0.5"))).toBe("10.0.0.5");
  });

  test("ignores spoofed X-Forwarded-For from untrusted peers", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
    });
    expect(clientIp(req, fakeServer("10.0.0.5"))).toBe("10.0.0.5");
  });

  test("honors X-Forwarded-For only from a trusted proxy", () => {
    process.env.TRUSTED_PROXIES = "10.0.0.9";
    try {
      const fromTrusted = new Request("http://x/", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(clientIp(fromTrusted, fakeServer("10.0.0.9"))).toBe("203.0.113.7");

      const fromUntrusted = new Request("http://x/", {
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      expect(clientIp(fromUntrusted, fakeServer("10.0.0.5"))).toBe("10.0.0.5");
    } finally {
      delete process.env.TRUSTED_PROXIES;
    }
  });

  test("walks the XFF chain right-to-left and skips trusted proxies", () => {
    process.env.TRUSTED_PROXIES = "172.28.0.1";
    try {
      // nginx appended the real client (198.51.100.7) after the spoofed entry.
      const req = new Request("http://x/", {
        headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.7, 172.28.0.1" },
      });
      expect(clientIp(req, fakeServer("172.28.0.1"))).toBe("198.51.100.7");
    } finally {
      delete process.env.TRUSTED_PROXIES;
    }
  });

  test("TRUST_PROXY=1 returns the client, not the proxy", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "203.0.113.7, 172.28.0.1" },
    });
    expect(clientIp(req, fakeServer("172.28.0.1"), 1)).toBe("203.0.113.7");
  });

  test("TRUST_PROXY=0 ignores X-Forwarded-For entirely", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(clientIp(req, fakeServer("172.28.0.1"), 0)).toBe("172.28.0.1");
  });

  test("handles missing requestIP gracefully", () => {
    const req = new Request("http://x/");
    expect(clientIp(req, { requestIP: () => null })).toBe("local");
  });
});
