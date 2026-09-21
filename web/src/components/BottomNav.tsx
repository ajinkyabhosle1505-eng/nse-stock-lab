"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/budget", label: "Budget", icon: "₹" },
  { href: "/ideas", label: "Ideas", icon: "◎" },
  { href: "/report", label: "Report", icon: "☰" },
  { href: "/paper", label: "Paper", icon: "▦" },
] as const;

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {items.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/budget" && pathname.startsWith(item.href));
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={`flex flex-col items-center gap-0.5 px-2 py-2.5 text-[11px] font-medium ${
                  active ? "text-emerald-400" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <span className="text-lg leading-none" aria-hidden>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
