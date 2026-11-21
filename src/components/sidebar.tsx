"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  BookOpen,
  CalendarClock,
  ClipboardList,
  Cpu,
  FolderOpen,
  Home,
  Menu,
  Network,
  Settings,
  ShieldCheck,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { name: string; items: NavItem[]; anchors?: { href: string; label: string }[] };

const navGroups: NavGroup[] = [
  { name: "Centro de mando", items: [
    { href: "/", label: "Overview", icon: Home },
    { href: "/action-center", label: "Action Center", icon: Activity },
  ] },
  { name: "Operaciones", items: [
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/tasks", label: "Tasks", icon: ClipboardList },
  ] },
  { name: "Observabilidad", items: [
    { href: "/infrastructure", label: "Infrastructure", icon: Cpu },
  ], anchors: [
    { href: "/infrastructure#model-performance", label: "Models & Performance" },
  ] },
  { name: "Sistema", items: [
    { href: "/memory-center", label: "Memory", icon: BookOpen },
    { href: "/automations", label: "Automations", icon: CalendarClock },
    { href: "/security-center", label: "Security & Network", icon: ShieldCheck },
    { href: "/settings", label: "Settings", icon: Settings },
  ] },
  { name: "Espacio de trabajo", items: [
    { href: "/hermes", label: "Hermes activity", icon: Wrench },
    { href: "/operations?panel=max", label: "Agent workbench", icon: Network },
    { href: "/workspace", label: "Creator & portfolio", icon: FolderOpen },
  ] },
];

const mobileTabs: NavItem[] = [
  { href: "/", label: "Overview", icon: Home },
  { href: "/action-center", label: "Actions", icon: Activity },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/tasks", label: "Tasks", icon: ClipboardList },
];

function routePath(href: string) {
  return href.split(/[?#]/, 1)[0];
}

function Logo() {
  return <div className="flex items-center gap-2.5">
    <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
      <span aria-hidden="true" className="text-[13px] font-bold tracking-tight text-[#0a0b0d]">H</span>
    </div>
    <span className="text-[15px] font-semibold tracking-tight text-[var(--text)]">Hermy HQ</span>
  </div>;
}

export function Sidebar() {
  const pathname = usePathname();
  const [hash, setHash] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncViewport = () => setIsMobile(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setIsOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    const handleResize = () => { if (window.innerWidth >= 768) setIsOpen(false); };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setIsOpen(false); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  function isActive(href: string) {
    const path = routePath(href);
    if (href.includes("#")) return pathname === path && hash === `#${href.split("#")[1]}`;
    if (href.includes("?")) return pathname === path;
    return path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
  }

  function linkClass(active: boolean) {
    return `group relative flex min-h-10 items-center gap-3 rounded-[10px] px-3 py-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--surface-1)] hover:text-[var(--text)]"}`;
  }

  return <>
    <div className="fixed left-0 right-0 top-0 z-50 flex items-center justify-between border-b border-[var(--line)] bg-[var(--bg)]/95 px-4 py-3 backdrop-blur md:hidden">
      <Logo />
      <button type="button" onClick={() => setIsOpen((open) => !open)} aria-label={isOpen ? "Cerrar navegación" : "Abrir navegación"} aria-expanded={isOpen} aria-controls="primary-navigation" className="rounded-lg p-2 text-[var(--text-2)] hover:bg-[var(--surface-1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
        {isOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
      </button>
    </div>

    {isOpen && <button type="button" aria-label="Cerrar navegación" onClick={() => setIsOpen(false)} className="fixed inset-0 z-40 bg-black/60 md:hidden" />}

    <aside aria-hidden={isMobile && !isOpen} inert={isMobile && !isOpen} className={`fixed left-0 top-0 z-50 flex h-full w-[17rem] flex-col border-r border-[var(--line)] bg-[var(--bg)] transition-transform duration-200 md:relative md:z-10 md:w-[16rem] md:translate-x-0 ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="hidden px-5 pb-6 pt-6 md:block"><Logo /></div>
      <div className="h-16 shrink-0 md:hidden" />
      <nav id="primary-navigation" aria-label="Navegación principal" className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-5">
          {navGroups.map((group) => <section key={group.name} aria-label={group.name}>
            <h2 className="eyebrow mb-1.5 px-3 !text-[10px] !text-[var(--text-4)]">{group.name}</h2>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return <div key={item.href}>
                  <Link href={item.href} className={linkClass(active)} aria-current={active ? "page" : undefined}>
                    {active && <span aria-hidden="true" className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-[var(--accent)]" />}
                    <Icon aria-hidden="true" className={`h-[17px] w-[17px] shrink-0 ${active ? "text-[var(--text)]" : "text-[var(--text-3)] group-hover:text-[var(--text-2)]"}`} />
                    <span className="text-[13.5px] font-medium">{item.label}</span>
                  </Link>
                  {active && group.anchors?.map((anchor) => {
                    const anchorActive = isActive(anchor.href);
                    return <Link key={anchor.href} href={anchor.href} aria-current={anchorActive ? "page" : undefined} className={`ml-[26px] block border-l py-2 pl-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${anchorActive ? "border-[var(--accent)] text-[var(--text)]" : "border-[var(--line)] text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
                      {anchor.label}
                    </Link>;
                  })}
                </div>;
              })}
            </div>
          </section>)}
        </div>
      </nav>
      <div className="border-t border-[var(--line)] px-4 py-4 text-[11px] text-[var(--text-3)]">
        Estado de servicio y datos: consultar Overview.
      </div>
    </aside>

    <nav aria-label="Accesos rápidos" className="safe-area-pb fixed bottom-0 left-0 right-0 z-30 border-t border-[var(--line)] bg-[var(--bg)]/95 px-2 py-2 backdrop-blur md:hidden">
      <ul className="flex justify-around">
        {mobileTabs.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return <li key={item.href}>
            <Link href={item.href} aria-current={active ? "page" : undefined} className={`flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-3 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
              <Icon aria-hidden="true" className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          </li>;
        })}
      </ul>
    </nav>
  </>;
}
