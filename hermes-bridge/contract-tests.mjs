#!/usr/bin/env node
import fs from "node:fs";
import pg from "pg";

const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const databaseUrl = process.env.DATABASE_URL || envText.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: /@(localhost|127\.0\.0\.1)(?::\d+)?(?:[/?]|$)/.test(databaseUrl) ? undefined : { rejectUnauthorized: false } });
const client = await pool.connect();
const id = `contract-${Date.now()}`;
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO "AgentRequest" (id,kind,title,prompt,status,"sideEffecting",origin,"createdAt","updatedAt") VALUES ($1,'codex.change','Contract test','Non destructive contract test','awaiting_approval',true,'test',now(),now())`, [id]);
  const auditId = `${id}-audit`;
  await client.query(`INSERT INTO "AgentRequest" (id,kind,title,prompt,status,"sideEffecting",origin,"createdAt","updatedAt") VALUES ($1,'codex.audit','Audit contract test','Read-only contract test','queued',false,'test',now(),now())`, [auditId]);
  const auditApproval = await client.query(`SELECT 1 FROM "ActionApproval" WHERE request_id=$1`, [auditId]);
  if (auditApproval.rowCount !== 0) throw new Error("read-only Codex audit unexpectedly requires approval");
  const memory = await client.query(`SELECT cause,hypothesis,remediation,validation FROM "IncidentMemory" WHERE request_id=$1`, [id]);
  if (memory.rowCount !== 1 || Object.values(memory.rows[0]).some((value) => !value)) throw new Error("structured incident fields are incomplete");
  if (Object.values(memory.rows[0]).some((value) => /^(pendiente|no registrado|n\/a|na|unknown|desconocido|sin datos)/i.test(String(value).trim()))) throw new Error("structured incident fields contain a placeholder");
  const approval = await client.query(`SELECT status FROM "ActionApproval" WHERE request_id=$1`, [id]);
  if (approval.rows[0]?.status !== "pending") throw new Error("approval gate did not create pending approval");
  await client.query("SAVEPOINT gate_check");
  let blocked = false;
  try { await client.query(`UPDATE "AgentRequest" SET status='running' WHERE id=$1`, [id]); }
  catch { blocked = true; await client.query("ROLLBACK TO SAVEPOINT gate_check"); }
  if (!blocked) throw new Error("sensitive request ran without approval");
  await client.query(`UPDATE "AgentRequest" SET status='rejected',error='contract rejection' WHERE id=$1`, [id]);
  const rejected = await client.query(`SELECT status FROM "ActionApproval" WHERE request_id=$1`, [id]);
  if (rejected.rows[0]?.status !== "rejected") throw new Error("rejection did not close approval");
  await client.query(`INSERT INTO "InferenceAttempt" (id,request_id,attempt_no,provider,model,status,created_at) VALUES ($1,$2,1,'openai','codex','running',now())`, [`${id}-1`, id]);
  await client.query(`UPDATE "InferenceAttempt" SET status='failed',reason='contract fallback',duration_ms=1,finished_at=now() WHERE request_id=$1 AND status='running' AND provider='openai'`, [id]);
  await client.query(`INSERT INTO "InferenceAttempt" (id,request_id,attempt_no,provider,model,status,created_at) SELECT $1,$2,COALESCE(MAX(attempt_no),0)+1,'custom','qwen3-8b-local','running',now() FROM "InferenceAttempt" WHERE request_id=$2`, [`${id}-2`, id]);
  const attempts = await client.query(`SELECT attempt_no,provider,model,status FROM "InferenceAttempt" WHERE request_id=$1 ORDER BY attempt_no`, [id]);
  if (attempts.rowCount !== 2 || attempts.rows[0].status !== "failed" || attempts.rows[1].attempt_no !== 2 || attempts.rows[1].model !== "qwen3-8b-local") throw new Error("fallback attempt contract failed");
  console.log("approval/fallback contract: PASS");
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
