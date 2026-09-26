const MAX_VIDEO_KINDS = new Set(["max.chief-of-staff", "max.deep-analysis"]);

export function isPendingVideoDelegation(request, explicitContract, detail) {
  if (!MAX_VIDEO_KINDS.has(request?.kind) || !explicitContract?.valid) return false;
  return /(?:Delegué el análisis explícito de YouTube a Pulse|Delegación video\.youtube\.analyze existente)[.:]/i.test(String(detail || ""));
}

export function propagationDetailForParent(kind, status, storedDetail, completionText) {
  if (
    kind === "video.youtube.analyze"
    && status === "failed"
    && typeof storedDetail === "string"
    && storedDetail.trim()
  ) return storedDetail;
  return completionText;
}

export function applyMockChildOutcome(parent, child, outcome) {
  if (parent.status !== "running") throw new Error("parent_must_remain_running_until_child_terminal");
  if (child.kind !== "video.youtube.analyze") throw new Error("video_child_kind_required");
  if (outcome.status === "done") {
    const result = JSON.parse(String(outcome.result));
    return {
      status: "done",
      result: { parent_request_id: parent.id, child_request_id: child.id, kind: child.kind, status: "done", result },
      error: null,
    };
  }
  if (outcome.status === "failed") {
    return {
      status: "failed",
      result: null,
      error: `video.youtube.analyze child ${child.id} failed: ${String(outcome.error || "unknown_error")}`,
    };
  }
  throw new Error("child_must_be_terminal");
}
