/**
 * One place for how the app shows dates and times.
 *
 * Timestamps are stored and sent as UTC instants. They are *shown* in the
 * zone configured by NEXT_PUBLIC_APP_TIME_ZONE (default Asia/Kolkata), not in
 * whatever zone the browser or the hosting server happens to run in. That
 * keeps "Today"/"Yesterday" and question times correct when the app is
 * hosted on a UTC machine, and makes server and browser rendering agree.
 *
 * NEXT_PUBLIC_* values are inlined at build time, so change them in
 * apps/web/.env.local (or the host's build environment) and rebuild.
 */

const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const DEFAULT_LOCALE = "en-IN";

function validTimeZone(value: string | undefined): string {
  const zone = value?.trim();
  if (!zone) return DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function validLocale(value: string | undefined): string {
  const locale = value?.trim();
  if (!locale) return DEFAULT_LOCALE;

  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0
      ? locale
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export const APP_TIME_ZONE = validTimeZone(
  process.env.NEXT_PUBLIC_APP_TIME_ZONE,
);
export const APP_LOCALE = validLocale(process.env.NEXT_PUBLIC_APP_LOCALE);

type DateInput = Date | number | string;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day in the app zone as "YYYY-MM-DD". */
export function appDayKey(value: DateInput): string {
  const parts = dayKeyFormat.formatToParts(toDate(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The day before a "YYYY-MM-DD" key. */
export function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** "3:05 pm" in the app zone. */
export function formatAppTime(value: DateInput): string {
  return toDate(value).toLocaleTimeString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "26 Sept" (or "26 Sept 2025" when withYear) in the app zone. */
export function formatAppDay(value: DateInput, withYear = false): string {
  return toDate(value).toLocaleDateString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
  });
}

/** Label for a "YYYY-MM-DD" day key, without shifting it through a zone. */
export function formatDayKey(key: string, withYear = false): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString(
    APP_LOCALE,
    {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" as const } : {}),
    },
  );
}

/** "Saturday, 26 September 2026 at 3:05 pm IST" in the app zone. */
export function formatAppDateTimeFull(value: DateInput): string {
  return toDate(value).toLocaleString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    dateStyle: "full",
    timeStyle: "short",
  }) + ` ${zoneAbbreviation(toDate(value))}`;
}

function zoneAbbreviation(date: Date): string {
  const name = new Intl.DateTimeFormat("en-IN", {
    timeZone: APP_TIME_ZONE,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return name ?? APP_TIME_ZONE;
}
