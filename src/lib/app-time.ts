/**
 * Display time zone for command-line reports and logs meant for people.
 *
 * Stored timestamps stay UTC (TIMESTAMPTZ). APP_TIME_ZONE only changes how
 * they are printed, so reports read the same on a laptop in India and on a
 * UTC host. Default: Asia/Kolkata.
 */

const DEFAULT_TIME_ZONE = "Asia/Kolkata";

function resolveTimeZone(value: string | undefined): string {
  const zone = value?.trim();
  if (!zone) return DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    console.warn(`Ignoring invalid APP_TIME_ZONE "${zone}"; using ${DEFAULT_TIME_ZONE}.`);
    return DEFAULT_TIME_ZONE;
  }
}

export const APP_TIME_ZONE = resolveTimeZone(process.env.APP_TIME_ZONE);

const stampFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-09-26 15:05" in APP_TIME_ZONE. */
export function formatAppTimestamp(value: Date | string | number): string {
  const parts = stampFormat.formatToParts(
    value instanceof Date ? value : new Date(value),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
