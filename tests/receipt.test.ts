import { describe, test, expect } from "bun:test";
import { validateReceipt, ACCEPTED_RECEIPT_MIMES } from "../src/bot/receipt";
import { MAX_RECEIPT_BYTES } from "../src/utils/ids";

describe("receipt validation (BUG-004 regression)", () => {
  test("accepts a photo with known size under the cap", () => {
    const r = validateReceipt({ kind: "photo", fileId: "f1", messageId: 1, size: 1024, mime: "image/jpeg" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileId).toBe("f1");
  });

  test("rejects a photo with missing file size (does not default to 0)", () => {
    const r = validateReceipt({ kind: "photo", fileId: "f1", messageId: 1, mime: "image/jpeg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("مشخص نیست");
  });

  test("rejects an oversized photo", () => {
    const r = validateReceipt({
      kind: "photo",
      fileId: "f1",
      messageId: 1,
      size: MAX_RECEIPT_BYTES + 1,
      mime: "image/jpeg",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("حجم");
  });

  test("accepts documents with permitted MIME and known size", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      const r = validateReceipt({ kind: "document", fileId: "d1", messageId: 2, size: 2048, mime });
      expect(r.ok).toBe(true);
    }
    expect(ACCEPTED_RECEIPT_MIMES.has("image/gif")).toBe(true);
  });

  test("rejects documents with unsupported MIME", () => {
    const r = validateReceipt({
      kind: "document",
      fileId: "d1",
      messageId: 2,
      size: 1000,
      mime: "application/pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("تصاویر");
  });

  test("rejects documents with missing MIME type (validation not skipped)", () => {
    const r = validateReceipt({ kind: "document", fileId: "d1", messageId: 2, size: 1000, mime: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("نوع فایل");
  });

  test("rejects documents with missing file size", () => {
    const r = validateReceipt({ kind: "document", fileId: "d1", messageId: 2, mime: "image/jpeg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("مشخص نیست");
  });

  test("rejects oversized documents", () => {
    const r = validateReceipt({
      kind: "document",
      fileId: "d1",
      messageId: 2,
      size: MAX_RECEIPT_BYTES + 1,
      mime: "image/png",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects missing fileId", () => {
    const r = validateReceipt({ kind: "photo", fileId: "", messageId: 1, size: 100, mime: "image/jpeg" });
    expect(r.ok).toBe(false);
  });

  test("boundary: exactly at the size cap is accepted", () => {
    const r = validateReceipt({
      kind: "photo",
      fileId: "f1",
      messageId: 1,
      size: MAX_RECEIPT_BYTES,
      mime: "image/jpeg",
    });
    expect(r.ok).toBe(true);
  });
});
