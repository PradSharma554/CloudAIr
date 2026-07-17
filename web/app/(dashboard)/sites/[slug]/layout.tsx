"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";

const tabs = [
  { name: "Overview", path: "" },
  { name: "llms.txt", path: "/llms" },
  { name: "Analytics", path: "/analytics" },
  { name: "Settings", path: "/settings" },
];

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const base = `/sites/${slug}`;
  return (
    <div className="space-y-6">
      <nav className="flex gap-1 border-b border-zinc-200">
        {tabs.map((tab) => {
          const href = base + tab.path;
          const active = pathname === href;
          return (
            <Link
              key={tab.name}
              href={href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                active
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {tab.name}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
