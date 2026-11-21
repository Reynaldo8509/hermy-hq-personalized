export async function publishAtlasReportIfAllowed({
  request,
  result,
  noReply = false,
  reportedProviderFailure = false,
  routingE2ETest = false,
}, publish) {
  if (routingE2ETest
      || request?.kind !== "atlas.research"
      || !String(result || "").trim()
      || noReply
      || reportedProviderFailure) return null;
  return publish(request, result);
}

export async function notifySpecialistOutcomeIfAllowed({
  agent,
  request,
  status,
  routingE2ETest = false,
}, notify) {
  if (routingE2ETest || !agent) return false;
  await notify(agent, request, status);
  return true;
}
