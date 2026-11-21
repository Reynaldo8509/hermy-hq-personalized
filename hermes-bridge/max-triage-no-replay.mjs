// A failed triage is terminal. Only an explicit null result permits a single
// generic inference pass; a rejected promise must never replay the request.
export async function runMaxTriageOrInference(triage, inference) {
  if (typeof triage !== "function" || typeof inference !== "function") {
    throw new TypeError("max_triage_contract_invalid");
  }
  const result = await triage();
  return result !== null ? result : inference();
}
