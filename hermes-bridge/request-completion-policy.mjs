export function isFailedCompletion({ noReply = false, reportedProviderFailure = false, structuredFailure = false, unresolvable = false } = {}) {
  return Boolean(noReply || reportedProviderFailure || structuredFailure || unresolvable);
}
