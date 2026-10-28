"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, type Site } from "@/lib/api";
import { Button, Card, CopyField, ErrorNote } from "@/components/ui";

export default function NewSitePage() {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyDetail, setVerifyDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createSite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api<Site>("/sites", {
        method: "POST",
        body: JSON.stringify({ domain }),
      });
      setSite(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!site) return;
    setBusy(true);
    setError(null);
    setVerifyDetail(null);
    try {
      const res = await api<{ verified: boolean; detail?: string }>(
        `/sites/${site.slug}/verify`,
        { method: "POST" }
      );
      if (res.verified) {
        router.push(`/sites/${site.slug}`);
      } else {
        setVerifyDetail(res.detail ?? "Verification failed — records can take a few minutes to propagate.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Add a site</h1>

      {!site && (
        <Card title="Step 1 — Your domain">
          <form onSubmit={createSite} className="space-y-4">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-hidden"
              required
            />
            <ErrorNote error={error} />
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Continue"}
            </Button>
          </form>
        </Card>
      )}

      {site && (
        <Card title="Step 2 — Prove you own it">
          <div className="space-y-5 text-sm text-zinc-600">
            <p>
              Add this <strong>DNS TXT record</strong> to <strong>{site.domain}</strong>:
            </p>
            <div className="space-y-3">
              <CopyField label="Record name (host)" value={site.dns_record_host} />
              <CopyField label="Record value" value={site.verification_token} />
            </div>
            <details className="rounded-lg border border-zinc-200 p-3">
              <summary className="cursor-pointer text-xs font-medium text-zinc-500">
                Can&apos;t edit DNS? Use a file instead
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs">
                  Serve the token as plain text at:
                </p>
                <CopyField value={site.well_known_url} />
                <CopyField label="File content" value={site.verification_token} />
              </div>
            </details>
            <ErrorNote error={error} />
            {verifyDetail && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Not verified yet: {verifyDetail}
              </div>
            )}
            <div className="flex gap-3">
              <Button onClick={verify} disabled={busy}>
                {busy ? "Checking…" : "Verify & start first crawl"}
              </Button>
              <Button variant="secondary" onClick={() => router.push(`/sites/${site.slug}`)}>
                Do this later
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
