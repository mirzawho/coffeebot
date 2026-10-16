import type { Db } from "../db/database";
import {
  addDays,
  isValidTime,
  timeToMinutes,
  weekdayOf,
  zonedNow,
  WEEKDAYS_FA,
} from "../utils/dates";

export interface DayHours {
  weekday: number; // 0=Sunday .. 6=Saturday
  openTime: string; // HH:MM
  closeTime: string; // HH:MM
  active: boolean;
}

/**
 * Business-date rules (deterministic, timezone-aware):
 * - open inclusive, close exclusive; overnight hours are rejected.
 * - before opening on an active day -> same date
 * - during hours -> same date
 * - at/after closing -> next active business date
 * - closed day -> next active business date
 */
export class BusinessHoursService {
  constructor(
    private readonly db: Db,
    private readonly timezone: string,
  ) {}

  getHours(): DayHours[] {
    const rows = this.db
      .query("SELECT weekday, open_time, close_time, active FROM business_hours ORDER BY weekday")
      .all() as {
      weekday: number;
      open_time: string;
      close_time: string;
      active: number;
    }[];
    return rows.map((r) => ({
      weekday: r.weekday,
      openTime: r.open_time,
      closeTime: r.close_time,
      active: r.active === 1,
    }));
  }

  /** Validate and persist a complete 7-day schedule. Rejects partial payloads
   * (missing weekdays would otherwise be silently closed) and overnight
   * (close <= open) configurations for active days. */
  saveHours(hours: DayHours[]): DayHours[] {
    const byWd = new Map<number, DayHours>();
    for (const h of hours) {
      if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6) {
        throw new Error(`روز نامعتبر: ${h.weekday}`);
      }
      if (byWd.has(h.weekday)) {
        throw new Error(`روز ${WEEKDAYS_FA[h.weekday]} تکراری است`);
      }
      if (!isValidTime(h.openTime) || !isValidTime(h.closeTime)) {
        throw new Error(`ساعت نامعتبر برای ${WEEKDAYS_FA[h.weekday]}`);
      }
      if (h.active && timeToMinutes(h.closeTime) <= timeToMinutes(h.openTime)) {
        throw new Error(
          `ساعت کاری ${WEEKDAYS_FA[h.weekday]} نامعتبر است: ساعت پایان باید بعد از ساعت شروع باشد (ساعت کاری شبانه پشتیبانی نمی‌شود)`,
        );
      }
      byWd.set(h.weekday, {
        weekday: h.weekday,
        openTime: h.openTime,
        closeTime: h.closeTime,
        active: !!h.active,
      });
    }
    // The API contract is a full-week replace: require all 7 weekdays so a
    // partial payload can never silently close unlisted days.
    if (byWd.size !== 7) {
      throw new Error("برنامه هفتگی باید شامل هر ۷ روز هفته باشد");
    }
    const final: DayHours[] = [];
    for (let wd = 0; wd <= 6; wd++) {
      final.push(byWd.get(wd)!);
    }
    const upsert = this.db.query(
      `INSERT INTO business_hours (weekday, open_time, close_time, active)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(weekday) DO UPDATE SET open_time = excluded.open_time,
         close_time = excluded.close_time, active = excluded.active`,
    );
    this.db.transaction(() => {
      for (const h of final) upsert.run(h.weekday, h.openTime, h.closeTime, h.active ? 1 : 0);
    })();
    return final;
  }

  private hoursFor(weekday: number): DayHours {
    const row = this.db
      .query("SELECT weekday, open_time, close_time, active FROM business_hours WHERE weekday = ?")
      .get(weekday) as
      | { weekday: number; open_time: string; close_time: string; active: number }
      | null;
    if (!row) {
      return { weekday, openTime: "00:00", closeTime: "00:00", active: false };
    }
    return {
      weekday: row.weekday,
      openTime: row.open_time,
      closeTime: row.close_time,
      active: row.active === 1,
    };
  }

  /** Target business date for an order submitted at instant `now`. */
  targetBusinessDate(now: Date): string {
    const { date, time } = zonedNow(now, this.timezone);
    let d = date;
    let first = true;
    for (let i = 0; i < 90; i++) {
      const h = this.hoursFor(weekdayOf(d));
      if (!h.active) {
        d = addDays(d, 1);
        first = false;
        continue;
      }
      if (!first) return d; // next active day, treated as before opening
      const tm = timeToMinutes(time);
      const open = timeToMinutes(h.openTime);
      const close = timeToMinutes(h.closeTime);
      if (tm < open) return d; // before opening -> same day
      if (tm < close) return d; // during hours (close exclusive)
      d = addDays(d, 1); // at/after closing -> next day
      first = false;
    }
    throw new Error("هیچ روز کاری فعالی در بازه ۹۰ روز آینده یافت نشد");
  }

  /**
   * Business date a daily report scheduled at local time `now` should cover.
   * On an active calendar day this is that calendar date (regardless of report
   * time vs closing); on a closed day it is the next active business date.
   */
  reportBusinessDate(now: Date): string {
    const { date } = zonedNow(now, this.timezone);
    const h = this.hoursFor(weekdayOf(date));
    if (h.active) return date;
    return this.targetBusinessDate(now);
  }

  isOpenAt(now: Date): boolean {
    const { date, time } = zonedNow(now, this.timezone);
    const h = this.hoursFor(weekdayOf(date));
    if (!h.active) return false;
    const tm = timeToMinutes(time);
    return tm >= timeToMinutes(h.openTime) && tm < timeToMinutes(h.closeTime);
  }

  /** Next opening instant (for messaging). Returns local HH:MM of today's/tomorrow's open. */
  nextOpeningLabel(now: Date): string {
    const { date, time } = zonedNow(now, this.timezone);
    let d = date;
    let first = true;
    const tm = timeToMinutes(time);
    for (let i = 0; i < 90; i++) {
      const h = this.hoursFor(weekdayOf(d));
      if (h.active && (!first || tm < timeToMinutes(h.openTime))) {
        const dayLabel = d === date ? "امروز" : d === addDays(date, 1) ? "فردا" : d;
        return `${dayLabel} ساعت ${h.openTime}`;
      }
      d = addDays(d, 1);
      first = false;
    }
    return "نامشخص";
  }
}
