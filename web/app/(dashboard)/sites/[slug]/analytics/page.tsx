"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type TimeseriesPoint, type TopEntry } from "@/lib/api";
import { Card, ErrorNote } from "@/components/ui";

const ranges = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

export default function AnalyticsPage() {
  const { slug } = useParams<{ slug: string }>();
  const [range, setRange] = useState("7d");
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [topAgents, setTopAgents] = useState<TopEntry[]>([]);
  const [topPaths, setTopPaths] = useState<TopEntry[]>([]);
  const [topTools, setTopTools] = useState<TopEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ points: TimeseriesPoint[] }>(`/sites/${slug}/analytics/timeseries?range=${range}`),
      api<{ entries: TopEntry[] }>(`/sites/${slug}/analytics/top?by=agent&range=${range}`),
      api<{ entries: TopEntry[] }>(`/sites/${slug}/analytics/top?by=path&range=${range}`),
      api<{ entries: TopEntry[] }>(`/sites/${slug}/analytics/top?by=tool&range=${range}`),
    ])
      .then(([ts, agents, paths, tools]) => {
        setPoints(ts.points);
        setTopAgents(agents.entries);
        setTopPaths(paths.entries);
        setTopTools(tools.entries.filter((e) => e.key !== ""));
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [slug, range]);

  const chartData = points.map((p) => ({
    ...p,
    label: new Date(p.bucket).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(range === "24h" ? { hour: "numeric" } : {}),
    }),
  }));

  const total = points.reduce((sum, p) => sum + p.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-sm text-zinc-600">
          <span className="text-2xl font-semibold text-zinc-900">{total.toLocaleString()}</span>{" "}
          agent requests
        </div>
        <div className="flex gap-1 rounded-lg border border-zinc-200 bg-white p-1">
          {ranges.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium ${
                range === r.key ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error} />

      <Card title="Requests over time">
        {chartData.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-400">
            No agent traffic yet. Requests to your llms.txt, page mirrors, and
            MCP endpoint will show up here.
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} />
                <Tooltip />
                <Area type="monotone" dataKey="count" stroke="#0ea5e9" fill="#e0f2fe" name="requests" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Top agents">
          {topAgents.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-400">No data</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topAgents} layout="vertical" margin={{ left: 24 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="key" width={110} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#0ea5e9" radius={[0, 4, 4, 0]} name="requests" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="MCP tool calls">
          <EntryTable entries={topTools} empty="No MCP traffic yet" />
        </Card>
      </div>

      <Card title="Top paths">
        <EntryTable entries={topPaths} empty="No data" />
      </Card>
    </div>
  );
}

function EntryTable({ entries, empty }: { entries: TopEntry[]; empty: string }) {
  if (entries.length === 0) {
    return <p className="py-4 text-center text-sm text-zinc-400">{empty}</p>;
  }
  return (
    <table className="w-full text-sm">
      <tbody>
        {entries.map((e) => (
          <tr key={e.key} className="border-b border-zinc-100 last:border-0">
            <td className="max-w-0 truncate py-2 pr-4 font-mono text-xs">{e.key}</td>
            <td className="py-2 text-right tabular-nums text-zinc-600">{e.count.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
