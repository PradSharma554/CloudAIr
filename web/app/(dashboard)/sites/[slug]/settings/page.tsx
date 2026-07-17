"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type RateLimitRule, type Site } from "@/lib/api";
import { Badge, Button, Card, ErrorNote } from "@/components/ui";

const classes = ["verified-agent", "declared-agent", "suspected-agent", "unknown"];

export default function SettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const [site, setSite] = useState<Site | null>(null);
  const [rules, setRules] = useState<RateLimitRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Site>(`/sites/${slug}`).then(setSite).catch((e) => setError(e.message));
    api<{ rules: RateLimitRule[] }>(`/sites/${slug}/rate-limits`)
      .then((r) => setRules(r.rules))
      .catch((e) => setError(e.message));
  }, [slug]);

  function updateRule(i: number, patch: Partial<RateLimitRule>) {
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function saveRules() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/sites/${slug}/rate-limits`, {
        method: "PUT",
        body: JSON.stringify({ rules }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSite() {
    if (!confirm(`Delete ${site?.domain}? This removes all crawled pages and analytics.`)) return;
    try {
      await api(`/sites/${slug}`, { method: "DELETE" });
      router.push("/sites");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorNote error={error} />

      <Card title="Rate limits">
        <p className="mb-4 text-sm text-zinc-500">
          Requests per minute allowed per agent. Most specific rule wins: exact
          agent name → agent class → <code className="text-xs">*</code> (site
          default). Without rules, agents get 60 rpm with a burst of 10.
        </p>
        <div className="space-y-2">
          {rules.map((rule, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                value={rule.subject_type}
                onChange={(e) => updateRule(i, { subject_type: e.target.value as "class" | "agent" })}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
              >
                <option value="agent">agent</option>
                <option value="class">class</option>
              </select>
              {rule.subject_type === "class" ? (
                <select
                  value={rule.subject}
                  onChange={(e) => updateRule(i, { subject: e.target.value })}
                  className="w-44 rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
                >
                  {classes.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={rule.subject}
                  onChange={(e) => updateRule(i, { subject: e.target.value })}
                  placeholder="GPTBot or *"
                  className="w-44 rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
                />
              )}
              <label className="flex items-center gap-1 text-xs text-zinc-500">
                rpm
                <input
                  type="number"
                  min={1}
                  value={rule.rpm}
                  onChange={(e) => updateRule(i, { rpm: Number(e.target.value) })}
                  className="w-20 rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-zinc-500">
                burst
                <input
                  type="number"
                  min={1}
                  value={rule.burst}
                  onChange={(e) => updateRule(i, { burst: Number(e.target.value) })}
                  className="w-20 rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
                />
              </label>
              <button
                onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                className="text-xs text-red-500 hover:text-red-700"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() =>
              setRules((prev) => [...prev, { subject_type: "agent", subject: "", rpm: 60, burst: 10 }])
            }
          >
            Add rule
          </Button>
          <Button onClick={saveRules} disabled={busy}>
            {busy ? "Saving…" : "Save rules"}
          </Button>
          {saved && <Badge tone="green">saved</Badge>}
        </div>
      </Card>

      <Card title="Monetization">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-zinc-600">Charge agents for access (x402 micropayments)</p>
            <p className="mt-1 text-xs text-zinc-400">
              Coming soon — agents without payment will receive HTTP 402 with
              payment instructions.
            </p>
          </div>
          <Badge tone="gray">coming soon</Badge>
        </div>
      </Card>

      <Card title="Danger zone">
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-600">
            Delete this site, its crawled pages, and all analytics.
          </p>
          <Button variant="danger" onClick={deleteSite}>
            Delete site
          </Button>
        </div>
      </Card>
    </div>
  );
}
