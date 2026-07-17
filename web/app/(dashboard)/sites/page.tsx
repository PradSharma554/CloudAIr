"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Site } from "@/lib/api";
import { Badge, Card, ErrorNote } from "@/components/ui";

export default function SitesPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ sites: Site[] }>("/sites")
      .then((r) => setSites(r.sites))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Your sites</h1>
        <Link
          href="/sites/new"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Add site
        </Link>
      </div>
      <ErrorNote error={error} />
      {sites === null && !error && <p className="text-sm text-zinc-500">Loading…</p>}
      {sites?.length === 0 && (
        <Card>
          <p className="text-sm text-zinc-600">
            No sites yet. Add your first site to generate its llms.txt and MCP
            endpoint for AI agents.
          </p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {sites?.map((site) => (
          <Link key={site.id} href={`/sites/${site.slug}`}>
            <Card className="transition-shadow hover:shadow-md">
              <div className="flex items-center justify-between">
                <div className="font-medium">{site.domain}</div>
                {site.verified ? (
                  <Badge tone="green">verified</Badge>
                ) : (
                  <Badge tone="yellow">pending verification</Badge>
                )}
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                {site.llms_txt_generated ? "llms.txt ready · MCP live" : "llms.txt not generated yet"}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
