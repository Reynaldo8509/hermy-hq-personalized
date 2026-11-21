export type EcuadorDateInput = string | number | Date | null | undefined;

type FormatOptions = {
  dateOnly?: boolean;
  invalid?: string;
};

const ECUADOR_TIME_ZONE = "America/Guayaquil";
const dateTimeFormatter = new Intl.DateTimeFormat("es-EC", {
  timeZone: ECUADOR_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "medium",
});
const dateFormatter = new Intl.DateTimeFormat("es-EC", {
  timeZone: ECUADOR_TIME_ZONE,
  dateStyle: "medium",
});
const calendarKeyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ECUADOR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const zonedTimestampPattern = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseInstant(value: EcuadorDateInput): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const input = value.trim();
  if (dateOnlyPattern.test(input)) {
    const date = new Date(`${input}T12:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === input ? date : null;
  }
  if (!zonedTimestampPattern.test(input)) return null;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getEcuadorCalendarDate(value: EcuadorDateInput): string | null {
  const date = parseInstant(value);
  if (!date) return null;
  const parts = calendarKeyFormatter.formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (!values.year || !values.month || !values.day) return null;
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatEcuadorTimestamp(
  value: EcuadorDateInput,
  options: FormatOptions = {},
): string {
  const date = parseInstant(value);
  if (!date) return options.invalid ?? "Fecha no disponible";
  return (options.dateOnly ? dateFormatter : dateTimeFormatter).format(date);
}
