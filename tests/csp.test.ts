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

  test("keeps frame-ancestors restricted", () => {
    expect(csp).toContain("frame-ancestors 'self'");
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

  test("handles missing requestIP gracefully", () => {
    const req = new Request("http://x/");
    expect(clientIp(req, { requestIP: () => null })).toBe("local");
  });
});
