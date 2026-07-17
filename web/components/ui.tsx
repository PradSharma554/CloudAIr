"use client";

import { useState } from "react";

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white p-5 shadow-sm ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h2>}
      {children}
    </section>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "green" | "yellow" | "red" | "gray" | "blue";
  children: React.ReactNode;
}) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    yellow: "bg-amber-50 text-amber-700 ring-amber-600/20",
    red: "bg-red-50 text-red-700 ring-red-600/20",
    gray: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
    blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function CrawlBadge({ status }: { status?: string }) {
  switch (status) {
    case "completed":
      return <Badge tone="green">crawled</Badge>;
    case "running":
      return <Badge tone="blue">crawling…</Badge>;
    case "stalled":
      return <Badge tone="yellow">stalled</Badge>;
    case "failed":
      return <Badge tone="red">crawl failed</Badge>;
    default:
      return <Badge tone="gray">not crawled</Badge>;
  }
}

export function CopyField({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <div className="mb-1 text-xs font-medium text-zinc-500">{label}</div>}
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs">{value}</code>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-400",
    secondary: "border border-zinc-300 bg-white hover:bg-zinc-50 disabled:text-zinc-400",
    danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
  };
  return (
    <button
      {...props}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {error}
    </div>
  );
}
