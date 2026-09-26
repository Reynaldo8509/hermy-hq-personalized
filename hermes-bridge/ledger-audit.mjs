import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function isScheduledLedgerAudit(r) {
  return r.kind === "ledger.operations" && r.origin === "system"
    && r.sideEffecting === false
    && r.title === "Ledger · auditoría de continuidad y salud operativa"
    && String(r.prompt || "").startsWith("Auditoría periódica de solo lectura.");
}

// Fixed local probes: no model loop, shell interpolation, remote access or writes.
export async function runLedgerAudit(query, execute = exec) {
  const blockers = [];
  async function probe(label, file, args) {
    try {
      const { stdout } = await execute(file, args, {
        timeout: 8000, maxBuffer: 128 * 1024,
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
      });
      return `${label}:\n${stdout.trim() || "Sin entradas en la ventana consultada."}`;
    } catch (error) {
      blockers.push(`${label}: ${error.signal || error.code || "error"}`);
      return `${label}: NO VERIFICADO (falló la comprobación).`;
    }
  }
  const inventory = await probe("Unidades instaladas", "systemctl", [
    "list-unit-files", "--no-pager", "--no-legend", "*backup*", "*health*", "*observability*",
  ]);
  const units = [...inventory.matchAll(/^([\w@.:-]+\.service)\s/gm)]
    .map(m => m[1]).filter(name => !name.includes("@"));
  const checks = [inventory];
  if (units.length) {
    checks.push(await probe("Estado actual de backups/salud", "systemctl", [
      "show", ...units, "-p", "Id", "-p", "ActiveState", "-p", "SubState",
      "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp",
    ]));
    const history = await probe("Ejecuciones registradas (7 días; hasta 80 entradas)", "journalctl", [
      ...units.flatMap(unit => ["-u", unit]), "--identifier=systemd", "--since=-7 days",
      "--no-pager", "-o", "short-iso", "-n", "80",
    ]);
    checks.push(history);
    if (/No entries|Sin entradas/.test(history)) blockers.push("Sin historial systemd visible: último éxito y frescura no verificados.");
  } else blockers.push("No se pudo identificar ningún servicio concreto de backup/salud.");
  checks.push(await probe("Timers y próxima ejecución", "systemctl", [
    "list-timers", "--all", "--no-pager", "*backup*", "*health*", "*observability*",
  ]));
  for (const repo of ["$HOME/hermes/app", "$HOME/hermes-customizations"]) {
    checks.push(await probe(`Git ${repo}`, "git", ["-C", repo, "status", "--porcelain=v1", "--branch", "--untracked-files=no"]));
    checks.push(await probe(`Refs locales ${repo}`, "git", ["-C", repo, "for-each-ref", "--format=%(refname:short) %(objectname:short) %(committerdate:iso8601)", "refs/heads", "refs/remotes/origin/main"]));
  }
  try {
    const { rows } = await query({
      text: `SELECT kind, count(*)::int AS failures, max("updatedAt") AS latest
        FROM "AgentRequest" WHERE status='failed' AND "updatedAt">now()-interval '24 hours'
        GROUP BY kind ORDER BY failures DESC LIMIT 30`,
      query_timeout: 8000,
    });
    checks.push(`Solicitudes fallidas de agentes en 24 h (HQ): ${JSON.stringify(rows)}`);
  } catch { blockers.push("Historial de agentes HQ no disponible."); }
  const hasFailure = checks.some(s => /Result=(?!success\b)\S+|\"failures\":\s*[1-9]/.test(s));
  return [
    `Ledger · auditoría local acotada · ${new Date().toISOString()}`,
    `Severidad: ${hasFailure ? "ATENCIÓN: fallos registrados; revisar evidencia y si siguen vigentes" : "NO CONCLUYENTE: revisar cobertura y evidencia"}.`,
    ...checks,
    "Límites: el resultado systemd no demuestra recuperabilidad. Último éxito: solo el que conste en el journal consultado; ausencia de entradas no demuestra fallo. No se verificaron archivos remotos, restauración, repositorios fuera de los indicados ni errores externos a HQ. Las refs remotas son caché local; no se ejecutó fetch.",
    `Bloqueadores de comprobación: ${blockers.join("; ") || "ninguno"}.`,
    "Impacto: una ejecución de backup fallida puede dejar la copia desactualizada; no prueba pérdida de datos. Siguiente paso: revisar el servicio fallido y verificar frescura/restauración con Ledger. Reparaciones ejecutadas por esta auditoría: ninguna.",
  ].join("\n\n");
}
