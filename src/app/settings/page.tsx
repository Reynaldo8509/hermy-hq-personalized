import Link from "next/link";
import { ArrowUpRight, Bot, KeyRound, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { CodexPolicyControl } from "./codex-policy";

const destinations = [
  { href: "/agents", title: "Agentes y disponibilidad", detail: "Consultar estado administrativo, disponibilidad observada e historial.", icon: Bot },
  { href: "/action-center", title: "Accesos y aprobaciones", detail: "Revisar autorizaciones pendientes y decisiones registradas.", icon: ShieldCheck },
  { href: "/infrastructure#model-performance", title: "Modelos y proveedores", detail: "Ver proveedores, modelos y métricas registradas.", icon: SlidersHorizontal },
  { href: "/security-center", title: "Seguridad y red", detail: "Consultar dispositivos, hallazgos y auditoría operativa.", icon: KeyRound },
];

export default function SettingsPage() {
  return <div className="mx-auto w-full max-w-5xl space-y-6 pb-8">
    <header><div className="eyebrow">Hermy HQ · configuración</div><h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 max-w-2xl text-sm text-[var(--text-3)]">Accesos a los controles existentes de agentes, permisos, proveedores y seguridad.</p></header>
    <div role="note" className="rounded-xl border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-2)]">Los controles se guardan en el módulo que administra cada función y conservan sus autorizaciones.</div>
    <CodexPolicyControl />
    <section aria-label="Configuración por módulo" className="grid gap-3 sm:grid-cols-2">
      {destinations.map(({ href, title, detail, icon: Icon }) => <Link key={href} href={href} className="panel group flex min-h-32 items-start gap-4 p-5 transition-colors hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]">
        <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1"><strong className="block text-sm">{title}</strong><span className="mt-1.5 block text-xs leading-relaxed text-[var(--text-3)]">{detail}</span></span>
        <ArrowUpRight aria-hidden="true" className="h-4 w-4 text-[var(--text-4)] group-hover:text-[var(--text-2)]" />
      </Link>)}
    </section>
  </div>;
}
