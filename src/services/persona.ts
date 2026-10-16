import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger";

/**
 * Customizable AI persona (language, tone, style) loaded from a Markdown file.
 * The persona is UNTRUSTED style guidance: it is always appended after the
 * hardcoded core rules in the prompt and can never grant permissions or change
 * application behavior. Loaded once at startup; changes require a restart.
 *
 * Default location: next to the SQLite database (e.g. /data/persona.md in
 * Docker), so it lives on the same mounted volume and is easy to edit.
 */

export const DEFAULT_PERSONA_FILENAME = "persona.md";

/** Shipped default persona, seeded next to the DB when the file is missing. */
export const DEFAULT_PERSONA_CONTENT = `# شخصیت دستیار کافه

این فایل فقط «سبک پاسخ‌گویی» را تنظیم می‌کند و قوانین امنیتی و سفارش‌گیری را تغییر نمی‌دهد.
پس از ویرایش این فایل، برای اعمال تغییرات بات را ری‌استارت کنید.

## زبان و لحن

- به فارسی محاوره‌ای، طبیعی و روان پاسخ بده (مگر اینکه مشتری به زبان دیگری بنویسد).
- لحن دوستانه، محترمانه و گرم مناسب یک کافه باشد؛ نه خشک و اداری، نه بیش از حد صمیمی.
- از واضح‌ترین واژه استفاده کن و از اصطلاحات فنی پرهیز کن.

## کوتاهی و تمرکز

- پاسخ‌ها کوتاه و مفید باشد؛ توضیح اضافه نده.
- سطح جزئیات را با سؤال مشتری تنظیم کن: سؤال کوتاه، جواب کوتاه.
- کل منو را تکرار نکن مگر اینکه مشتری بخواهد.
- هر پاسخ را به تبلیغ محصول تبدیل نکن.

## پیشنهاد محصول

- وقتی محصولی را پیشنهاد می‌کنی، دلیل کوتاه و مرتبط بیاور (مثلاً بر اساس ذائقه‌ای که مشتری گفته).
- وقتی مشتری بین دو محصول مردد است، تفاوت اصلی را در یک جمله بگو.

## ابهام و اطلاعات ناقص

- اگر منظور مشتری مبهم است، فقط یک سؤال کوتاه روشن‌کننده بپرس.
- اگر اطلاعاتی در دسترس نیست، صادقانه بگو و در صورت امکان گزینه‌های موجود را پیشنهاد بده.

## سلام و احوال‌پرسی

- سلام کوتاه و گرم؛ در همان پیام کمکِ مرتبط را پیشنهاد بده.

## ایموجی و قالب‌بندی

- ایموجی را کم و فقط وقتی مناسب استفاده کن.
- برای فهرست‌ها از خط تیره ساده استفاده کن؛ از جدول و قالب‌بندی سنگین پرهیز کن.
`;

/** Safe built-in fallback used when the persona file cannot be read or seeded. */
export const FALLBACK_PERSONA = `- به فارسی محاوره‌ای، طبیعی و صمیمی اما محترمانه پاسخ بده.
- پاسخ‌ها کوتاه و مفید باشد؛ توضیح اضافه نده.
- ایموجی را کم و در جای مناسب استفاده کن.
- کل منو را تکرار نکن و هر پاسخ را به تبلیغ تبدیل نکن.
- اگر اطلاعات کافی نداری، صادقانه بگو.`;

/** Application root: the directory containing src/ (and the default data dir). */
export function appRoot(): string {
  // src/services/persona.ts -> ../../ = project root (works in bun runtime).
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * Resolve the persona file path. An explicit AI_PERSONA_FILE wins (absolute,
 * or relative to the app root). Otherwise the file sits next to the SQLite
 * database so it shares the mounted data volume.
 */
export function resolvePersonaPath(rawPath: string | undefined, dbPath?: string): string {
  const p = (rawPath ?? "").trim();
  if (p) return isAbsolute(p) ? p : join(appRoot(), p);
  const dbDir = dbPath ? dirname(dbPath) : join(appRoot(), "data");
  return join(dbDir, DEFAULT_PERSONA_FILENAME);
}

/**
 * Load the persona text. Never throws: a missing file is seeded with the
 * shipped default (so it can be edited on the volume); an unreadable file logs
 * a startup warning and returns the safe built-in fallback.
 */
export function loadPersona(
  rawPath: string | undefined,
  dbPath?: string,
): { text: string; path: string; fallback: boolean; seeded: boolean } {
  const path = resolvePersonaPath(rawPath, dbPath);
  try {
    if (!existsSync(path)) {
      // Seed the default next to the DB so admins can edit it on the volume.
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, DEFAULT_PERSONA_CONTENT, "utf8");
        log.info("persona file seeded with default", { path });
        return { text: DEFAULT_PERSONA_CONTENT.slice(0, 4000), path, fallback: false, seeded: true };
      } catch (err) {
        log.warn("persona file missing and could not be seeded; using built-in fallback", {
          path,
          err: String((err as any)?.code ?? err),
        });
        return { text: FALLBACK_PERSONA, path, fallback: true, seeded: false };
      }
    }
    const text = readFileSync(path, "utf8").trim();
    if (!text) {
      log.warn("persona file is empty; using built-in fallback", { path });
      return { text: FALLBACK_PERSONA, path, fallback: true, seeded: false };
    }
    // Hard cap: the persona is style guidance, not a second system prompt.
    return { text: text.slice(0, 4000), path, fallback: false, seeded: false };
  } catch (err) {
    log.warn("persona file unreadable; using built-in fallback", {
      path,
      err: String((err as any)?.code ?? err),
    });
    return { text: FALLBACK_PERSONA, path, fallback: true, seeded: false };
  }
}
