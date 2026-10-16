import { describe, test, expect } from "bun:test";
import { assertAmount, parseAmountInput, formatAmount, formatMoney } from "../src/utils/money";
import {
  addDays,
  isValidDate,
  isValidTime,
  timeToMinutes,
  toJalali,
  toPersianDigits,
  weekdayOf,
  zonedNow,
} from "../src/utils/dates";

describe("money helpers", () => {
  test("assertAmount accepts non-negative safe integers", () => {
    expect(() => assertAmount(0)).not.toThrow();
    expect(() => assertAmount(15000)).not.toThrow();
  });

  test("assertAmount rejects negatives, floats and non-numbers", () => {
    expect(() => assertAmount(-1)).toThrow();
    expect(() => assertAmount(1.5)).toThrow();
    expect(() => assertAmount("100" as unknown as number)).toThrow();
    expect(() => assertAmount(Number.NaN)).toThrow();
  });

  test("parseAmountInput strips separators and validates digits", () => {
    expect(parseAmountInput("15,000")).toBe(15000);
    expect(parseAmountInput(" 1 500 ")).toBe(1500);
    expect(parseAmountInput(2000)).toBe(2000);
  });

  test("parseAmountInput rejects non-numeric input", () => {
    expect(() => parseAmountInput("abc")).toThrow();
    expect(() => parseAmountInput("12.5")).toThrow();
    expect(() => parseAmountInput("")).toThrow();
  });

  test("formatAmount adds thousands separators", () => {
    expect(formatAmount(125000)).toBe("125,000");
    expect(formatAmount(0)).toBe("0");
  });

  test("formatMoney appends the currency", () => {
    expect(formatMoney(15000, "تومان")).toBe("15,000 تومان");
  });
});

describe("date helpers", () => {
  test("isValidTime accepts HH:MM and rejects out-of-range", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("9:5")).toBe(false);
    expect(isValidTime("noon")).toBe(false);
  });

  test("timeToMinutes converts HH:MM to minutes", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("18:30")).toBe(1110);
    expect(timeToMinutes("23:59")).toBe(1439);
  });

  test("isValidDate accepts YYYY-MM-DD only", () => {
    expect(isValidDate("2026-10-13")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("13/10/2026")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });

  test("addDays moves forward and backward across month boundaries", () => {
    expect(addDays("2026-10-13", 1)).toBe("2026-10-14");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });

  test("weekdayOf returns 0..6 (Sunday=0)", () => {
    // 2026-10-13 is a Tuesday.
    expect(weekdayOf("2026-10-13")).toBe(2);
    expect(weekdayOf("2026-10-11")).toBe(0);
  });

  test("zonedNow returns a date and time in the requested zone", () => {
    const z = zonedNow(new Date("2026-10-13T12:00:00Z"), "Asia/Tehran");
    expect(z.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(z.time).toMatch(/^\d{2}:\d{2}$/);
    // Tehran is UTC+3:30, so 12:00Z is 15:30 local.
    expect(z.time).toBe("15:30");
  });

  test("toJalali converts a Gregorian date to a Jalali YYYY-MM-DD string", () => {
    expect(toJalali("2026-10-13")).toBe("1405-07-21");
    expect(toJalali("2026-03-21")).toBe("1405-01-01"); // Nowruz
  });

  test("toPersianDigits maps ASCII digits to Persian digits", () => {
    expect(toPersianDigits("2026")).toBe("۲۰۲۶");
    expect(toPersianDigits("a1b2")).toBe("a۱b۲");
  });
});
