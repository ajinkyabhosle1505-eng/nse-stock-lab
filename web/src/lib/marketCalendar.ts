/**
 * NSE Capital Market calendar (IST). Holidays from the checked-in file
 * web/src/data/nse-holidays-<year>.json (official NSE circulars, see file).
 * Years without a file: weekdays treated as trading days and callers must
 * surface `unverified: true`. Muhurat/special sessions are never trading days
 * for marks or `based_on_close`.
 */
import h2026 from "@/data/nse-holidays-2026.json";

type HolidayFile = {
  year: number;
  source: { url: string; circular: string };
  holidays: { date: string; name: string }[];
};

const FILES: Record<number, HolidayFile> = { 2026: h2026 as HolidayFile };

export const CALENDAR_SOURCE = `${h2026.source.circular} — ${h2026.source.url}`;
export const HOLIDAY_FILE = "web/src/data/nse-holidays-2026.json";

const HOLIDAYS = new Map<string, string>();
for (const f of Object.values(FILES)) for (const h of f.holidays) HOLIDAYS.set(h.date, h.name);

export function calendarVerified(isoDate: string): boolean {
  return Number(isoDate.slice(0, 4)) in FILES;
}

export interface IstParts {
  date: string;
  hour: number;
  minute: number;
  minutesOfDay: number;
  /** e.g. 2026-09-25T08:53+05:30 */
  iso: string;
}

export function istParts(d: Date = new Date()): IstParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  ) as Record<string, string>;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    iso: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${parts.minute}+05:30`,
  };
}

export function istDate(d: Date = new Date()): string {
  return istParts(d).date;
}

export function weekdayOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return shiftDate(s, 0) === s;
}

export function holidayName(isoDate: string): string | null {
  return HOLIDAYS.get(isoDate) ?? null;
}

export function isTradingDay(isoDate: string): boolean {
  const wd = weekdayOf(isoDate);
  if (wd === 0 || wd === 6) return false;
  return !HOLIDAYS.has(isoDate);
}

export function prevTradingDay(isoDate: string): string {
  let d = shiftDate(isoDate, -1);
  for (let i = 0; i < 20 && !isTradingDay(d); i++) d = shiftDate(d, -1);
  return d;
}

export function nextTradingDay(isoDate: string): string {
  let d = shiftDate(isoDate, 1);
  for (let i = 0; i < 20 && !isTradingDay(d); i++) d = shiftDate(d, 1);
  return d;
}

/** Latest trading day on or before `isoDate`. */
export function tradingDayOnOrBefore(isoDate: string): string {
  return isTradingDay(isoDate) ? isoDate : prevTradingDay(isoDate);
}

export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
export const PREOPEN_MIN = 9 * 60;

/** Brief §2.6: latest trading day D such that now_IST ≥ D 09:00 IST. */
export function expectedReportSession(now: Date = new Date()): string {
  const p = istParts(now);
  if (isTradingDay(p.date) && p.minutesOfDay >= PREOPEN_MIN) return p.date;
  return prevTradingDay(p.date);
}

export type SessionPhase = "pre_open" | "open" | "post_close" | "closed_day";

export function sessionPhase(now: Date = new Date()): SessionPhase {
  const p = istParts(now);
  if (!isTradingDay(p.date)) return "closed_day";
  if (p.minutesOfDay < SESSION_OPEN_MIN) return "pre_open";
  if (p.minutesOfDay < SESSION_CLOSE_MIN) return "open";
  return "post_close";
}

/**
 * "Final" close rule: a session's close is FINAL when fetched on a later IST
 * calendar day (the 06:30 IST morning run). Same-day post-close bars are
 * PROVISIONAL. Returns the last session whose close counts as final now.
 */
export function lastFinalSession(now: Date = new Date()): string {
  return prevTradingDay(istDate(now));
}

/** Last session whose close is at least provisional (today after 16:00 IST). */
export function lastSettledSession(now: Date = new Date()): string {
  const p = istParts(now);
  if (isTradingDay(p.date) && p.minutesOfDay >= 16 * 60) return p.date;
  return prevTradingDay(p.date);
}

export function fmtDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
