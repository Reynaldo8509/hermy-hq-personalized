"use client";
import { useEffect, useState } from "react";
export function ApprovalHistory() {
  const [rows,setRows]=useState<Array<{id:string;action:string;status:string;requested_by:string;approved_by:string|null;created_at:string}>>([]);
  useEffect(()=>{ const load=async()=>{const r=await fetch("/api/hermes/approvals"); if(r.ok){const d=await r.json();setRows(d.approvals||[])}}; void load(); const t=setInterval(load,10000); return()=>clearInterval(t)},[]);
  return <div className="panel p-4"><div className="eyebrow mb-3">Action approvals</div>{rows.length===0?<p className="text-xs text-[var(--text-3)]">No pending approvals.</p>:rows.map(x=><div key={x.id} className="border-b border-[var(--line)] py-2 text-xs"><div className="font-medium">{x.title||x.id}</div><div className="text-[var(--text-3)]">{x.action} · {x.requested_by} · {x.status}</div></div>)}</div>;
}
