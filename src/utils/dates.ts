/**
 * Timezone-aware date helpers and Jalali (Solar Hijri) conversion.
 * Calendar dates are represented as "YYYY-MM-DD" strings.
 * Weekday numbers use JS convention: 0=Sunday .. 6=Saturday.
 */

export interface ZonedNow {
  /** Local calendar date in the configured timezone, YYYY-MM-DD */
  date: string;
  /** Local time of day, HH:MM (24h) */
  time: string;
  /** Local seconds, HH:MM:SS */
  dateTime: string;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Extract wall-clock parts for an instant in a given IANA timezone. */
export function zonedNow(now: Date, timeZone: string): ZonedNow {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = Number(parts.hour ?? "0");
  if (hour === 24) hour = 0;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${pad2(hour)}:${parts.minute}`;
  return { date, time, dateTime: `${date} ${time}:${parts.second}` };
}

/** Weekday of a YYYY-MM-DD date: 0=Sunday .. 6=Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "HH:MM" -> minutes since midnight. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time: ${t}`);
  }
  return h * 60 + m;
}

export function isValidTime(t: string): boolean {
  return /^\d{2}:\d{2}$/.test(t) && (() => {
    try {
      timeToMinutes(t);
      return true;
    } catch {
      return false;
    }
  })();
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// ---------------------------------------------------------------------------
// Jalali (Solar Hijri) conversion — based on the well-known jalaali algorithm.
// ---------------------------------------------------------------------------

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const breaks = [
    -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324,
    2394, 2456, 3178,
  ];
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0]!;
  if (jy < jp || jy >= breaks[bl - 1]!) throw new Error(`Jalali year out of range: ${jy}`);
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn: number): { jy: number; jm: number; jd: number } {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let jd: number;
  let jm: number;
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { jy, jm, jd };
}

/** Convert Gregorian YYYY-MM-DD to Jalali YYYY-MM-DD. */
export function toJalali(gDate: string): string {
  const [gy, gm, gd] = gDate.split("-").map(Number) as [number, number, number];
  const jdn = g2d(gy, gm, gd);
  const { jy, jm, jd } = d2j(jdn);
  return `${jy}-${pad2(jm)}-${pad2(jd)}`;
}

export const JALALI_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

export const WEEKDAYS_FA = [
  "یکشنبه",
  "دوشنبه",
  "سه‌شنبه",
  "چهارشنبه",
  "پنجشنبه",
  "جمعه",
  "شنبه",
];

/** Weekday names indexed by JS weekday (0=Sunday). Persian week starts شنبه (6). */
export const WEEKDAYS_FA_BY_JS_DAY = WEEKDAYS_FA;

/** Format a Gregorian date as a Persian Jalali date string, e.g. "۱۲ مهر ۱۴۰۴". */
export function formatJalaliFa(gDate: string): string {
  const { jy, jm, jd } = d2j(g2d(...(gDate.split("-").map(Number) as [number, number, number])));
  return `${toPersianDigits(String(jd))} ${JALALI_MONTHS[jm - 1]} ${toPersianDigits(String(jy))}`;
}

export function formatWeekdayFa(gDate: string): string {
  return WEEKDAYS_FA[weekdayOf(gDate)]!;
}

/** Full Persian date with weekday. */
export function formatFullJalaliFa(gDate: string): string {
  return `${formatWeekdayFa(gDate)} ${formatJalaliFa(gDate)}`;
}

export function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
}
