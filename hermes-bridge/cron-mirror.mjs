const JOB_HEADER = /^\s{2}([0-9a-f]{6,})\s+\[(\w+)\]/;

export function parseCronJobs(raw) {
  if (typeof raw !== "string") return [];
  const jobs = [];
  let current = null;
  const push = () => { if (current) jobs.push(current); };

  for (const line of raw.split("\n")) {
    const head = line.match(JOB_HEADER);
    if (head) {
      push();
      current = {
        id: head[1], status: head[2], name: "", schedule: "", nextRun: null,
        lastRun: null, lastResult: null, deliver: null, skills: null, script: null, mode: null,
      };
      continue;
    }
    const field = line.match(/^\s{4}([A-Za-z][A-Za-z ]*?):\s+(.*)$/);
    if (!field || !current) continue;
    const key = field[1].trim().toLowerCase();
    const value = field[2].trim();
    if (key === "name") current.name = value;
    else if (key === "schedule") current.schedule = value;
    else if (key === "next run") current.nextRun = value;
    else if (key === "deliver") current.deliver = value;
    else if (key === "skills") current.skills = value;
    else if (key === "script") current.script = value;
    else if (key === "mode") current.mode = value;
    else if (key === "last run") {
      const match = value.match(/^(\S+)\s+(.*)$/);
      current.lastRun = match ? match[1] : value;
      current.lastResult = match ? match[2] : null;
    }
  }
  push();
  return jobs;
}

export function successfulCronMirror(raw, syncedAt = new Date().toISOString()) {
  return {
    jobs: parseCronJobs(raw),
    raw: raw.slice(0, 8000),
    syncStatus: "ok",
    syncError: null,
    syncedAt,
    lastAttemptAt: syncedAt,
  };
}

export function failedCronMirror(previous, attemptedAt = new Date().toISOString()) {
  const prior = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  return {
    ...prior,
    jobs: Array.isArray(prior.jobs) ? prior.jobs : [],
    syncStatus: "error",
    syncError: "cron_list_failed",
    lastAttemptAt: attemptedAt,
  };
}
