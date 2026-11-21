"use client";
import { useEffect, useState } from "react";
export function ApprovalHistory() {
  const [rows,setRows]=useState<Array<{id:string;title?:string|null;action:string;status:string;requested_by:string;approved_by:string|null;resolved_by:string|null;approval_method:string|null;created_at:string}>>([]);
  useEffect(()=>{ const load=async()=>{const r=await fetch("/api/hermes/approvals"); if(r.ok){const d=await r.json();setRows(d.history||[])}}; void load(); const t=setInterval(load,10000); return()=>clearInterval(t)},[]);
  return <div className="panel p-4"><div className="eyebrow mb-3">Approval history</div>{rows.length===0?<p className="text-xs text-[var(--text-3)]">No resolved approvals.</p>:rows.map(x=><div key={x.id} className="border-b border-[var(--line)] py-2 text-xs"><div className="font-medium">{x.title||x.id}</div><div className="text-[var(--text-3)]">{x.action} · {x.status} · solicitada por {x.requested_by}</div><div className="text-[var(--text-3)]">Decisor: {x.approved_by||x.resolved_by||"—"}{x.approval_method?` · ${x.approval_method}`:""}</div></div>)}</div>;
}
