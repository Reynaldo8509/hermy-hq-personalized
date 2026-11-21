import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEcuadorTimestamp, getEcuadorCalendarDate } from "./ecuador-time";

const expectedDateTime = new Intl.DateTimeFormat("es-EC", {
  timeZone: "America/Guayaquil",
  dateStyle: "medium",
  timeStyle: "medium",
}).format(new Date("2026-01-01T02:30:00Z"));

test("formats an absolute UTC instant in Ecuador time across UTC midnight", () => {
  assert.equal(formatEcuadorTimestamp("2026-01-01T02:30:00Z"), expectedDateTime);
  assert.match(expectedDateTime, /2025/);
});

test("keeps a date-only calendar value on its stated Ecuador date", () => {
  const expected = new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    dateStyle: "medium",
  }).format(new Date("2026-01-01T12:00:00.000Z"));
  assert.equal(formatEcuadorTimestamp("2026-01-01", { dateOnly: true }), expected);
});

test("rejects offsetless timestamps instead of guessing their timezone", () => {
  assert.equal(
    formatEcuadorTimestamp("2026-01-01T02:30:00", { invalid: "AMBIGUOUS" }),
    "AMBIGUOUS",
  );
});

test("supports epoch milliseconds and invalid input fallback", () => {
  assert.equal(formatEcuadorTimestamp(Date.parse("2026-01-01T02:30:00Z")), expectedDateTime);
  assert.equal(formatEcuadorTimestamp("not-a-date", { invalid: "INVALID" }), "INVALID");
});

test("calculates calendar dates in Ecuador across UTC midnight", () => {
  assert.equal(getEcuadorCalendarDate("2026-01-01T02:30:00Z"), "2025-12-31");
});
