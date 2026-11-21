export function canPublishInternalHonchoSummaryForOrigin(origin) {
  return String(origin || "web").toLowerCase() !== "test";
}
