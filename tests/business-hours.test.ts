import { describe, test, expect } from "bun:test";
import { openDatabase } from "../src/db/database";
import { BusinessHoursService } from "../src/services/business-hours";

const TZ = "Asia/Tehran"; // +03:30, no DST

function makeService(): BusinessHoursService {
  const db = openDatabase(":memory:");
  return new BusinessHoursService(db, TZ);
}

// Default seed: Sun–Thu + Sat active 08:00–18:00; Fri closed.
// 2026-10-12 is a Monday.

describe("targetBusinessDate", () => {
  const svc = makeService();

  test("before opening on active day -> same date", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T01:00:00+03:30"))).toBe("2026-10-12");
  });

  test("opening time is inclusive", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T08:00:00+03:30"))).toBe("2026-10-12");
  });

  test("during business hours -> same date", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T12:00:00+03:30"))).toBe("2026-10-12");
  });

  test("one minute before closing -> same date", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T17:59:00+03:30"))).toBe("2026-10-12");
  });

  test("closing time is exclusive -> next active day", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T18:00:00+03:30"))).toBe("2026-10-13");
  });

  test("after closing -> next active day", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T22:00:00+03:30"))).toBe("2026-10-13");
  });

  test("closed Friday midday -> next active Saturday", () => {
    // 2026-10-16 is Friday (closed); 2026-10-17 is Saturday (active).
    expect(svc.targetBusinessDate(new Date("2026-10-16T10:00:00+03:30"))).toBe("2026-10-17");
  });

  test("closed Friday evening -> next active Saturday", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-16T23:30:00+03:30"))).toBe("2026-10-17");
  });

  test("before opening on Saturday (after closed Friday) -> Saturday itself", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-17T03:00:00+03:30"))).toBe("2026-10-17");
  });

  test("multiple consecutive closed days -> skips all", () => {
    // Close Sat+Sun+Fri additionally; only Mon–Thu active. Full-week payload.
    svc.saveHours(
      Array.from({ length: 7 }, (_, wd) => ({
        weekday: wd,
        openTime: "08:00",
        closeTime: "18:00",
        active: wd >= 1 && wd <= 4, // only Mon–Thu active
      })),
    );
    // 2026-10-16 Fri closed, 17 Sat closed, 18 Sun closed -> Monday 19.
    expect(svc.targetBusinessDate(new Date("2026-10-16T10:00:00+03:30"))).toBe("2026-10-19");
  });

  test("midnight-adjacent: 00:01 on active day before opening -> same day", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T00:01:00+03:30"))).toBe("2026-10-12");
  });

  test("23:59 on active day after closing -> next day", () => {
    expect(svc.targetBusinessDate(new Date("2026-10-12T23:59:00+03:30"))).toBe("2026-10-13");
  });

  test("timezone matters: same instant is still Tehran wall-clock", () => {
    // 20:30 UTC = 00:00 Tehran next day (Tue 13). 00:00 < opening -> Tue itself.
    expect(svc.targetBusinessDate(new Date("2026-10-12T20:30:00Z"))).toBe("2026-10-13");
    // 17:00 UTC = 20:30 Tehran Mon (after closing) -> Tue.
    expect(svc.targetBusinessDate(new Date("2026-10-12T17:00:00Z"))).toBe("2026-10-13");
    // 04:30 UTC = 08:00 Tehran Mon (opening) -> Mon.
    expect(svc.targetBusinessDate(new Date("2026-10-12T04:30:00Z"))).toBe("2026-10-12");
  });
});

describe("reportBusinessDate", () => {
  test("on active calendar day -> that date even after closing", () => {
    const svc = makeService();
    // Report time is irrelevant to which DATE is reported on an active day.
    expect(svc.reportBusinessDate(new Date("2026-10-12T19:00:00+03:30"))).toBe("2026-10-12");
    expect(svc.reportBusinessDate(new Date("2026-10-12T10:00:00+03:30"))).toBe("2026-10-12");
  });

  test("on closed Friday -> next active Saturday", () => {
    const svc = makeService();
    expect(svc.reportBusinessDate(new Date("2026-10-16T12:00:00+03:30"))).toBe("2026-10-17");
  });
});

describe("isOpenAt", () => {
  const svc = makeService();

  test("open during hours", () => {
    expect(svc.isOpenAt(new Date("2026-10-12T12:00:00+03:30"))).toBe(true);
  });

  test("closed after hours", () => {
    expect(svc.isOpenAt(new Date("2026-10-12T18:00:00+03:30"))).toBe(false);
  });

  test("closed on Friday", () => {
    expect(svc.isOpenAt(new Date("2026-10-16T12:00:00+03:30"))).toBe(false);
  });
});

describe("saveHours validation", () => {
  function fullWeek(overrides: Partial<{ weekday: number; openTime: string; closeTime: string; active: boolean }>[]) {
    const base = Array.from({ length: 7 }, (_, wd) => ({
      weekday: wd,
      openTime: "08:00",
      closeTime: "18:00",
      active: wd !== 5,
    }));
    for (const o of overrides) {
      if (o.weekday !== undefined && base[o.weekday]) Object.assign(base[o.weekday]!, o);
    }
    return base;
  }

  test("rejects overnight (close <= open) for active days", () => {
    const svc = makeService();
    expect(() =>
      svc.saveHours(fullWeek([{ weekday: 0, openTime: "18:00", closeTime: "08:00", active: true }])),
    ).toThrow();
  });

  test("allows close <= open for inactive days", () => {
    const svc = makeService();
    const saved = svc.saveHours(
      fullWeek([{ weekday: 5, openTime: "18:00", closeTime: "08:00", active: false }]),
    );
    expect(saved.find((h) => h.weekday === 5)?.active).toBe(false);
  });

  test("rejects invalid times", () => {
    const svc = makeService();
    expect(() =>
      svc.saveHours(fullWeek([{ weekday: 0, openTime: "25:99", closeTime: "18:00", active: true }])),
    ).toThrow();
  });

  test("rejects partial week (missing weekdays)", () => {
    const svc = makeService();
    expect(() =>
      svc.saveHours([{ weekday: 0, openTime: "09:00", closeTime: "17:00", active: true }]),
    ).toThrow(/۷ روز/);
    // Existing schedule untouched.
    const hours = svc.getHours();
    expect(hours.find((h) => h.weekday === 0)?.openTime).toBe("08:00");
    expect(hours.find((h) => h.weekday === 1)?.active).toBe(true);
  });

  test("rejects duplicate weekdays", () => {
    const svc = makeService();
    const week = fullWeek([]);
    week.push({ weekday: 0, openTime: "09:00", closeTime: "17:00", active: true });
    expect(() => svc.saveHours(week)).toThrow(/تکراری/);
  });

  test("full-week replace updates exactly the provided days", () => {
    const svc = makeService();
    const saved = svc.saveHours(fullWeek([{ weekday: 0, openTime: "09:30", closeTime: "16:30" }]));
    expect(saved).toHaveLength(7);
    expect(saved.find((h) => h.weekday === 0)?.openTime).toBe("09:30");
    expect(saved.find((h) => h.weekday === 2)?.openTime).toBe("08:00");
  });
});
