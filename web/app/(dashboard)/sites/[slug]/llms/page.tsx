"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CopyField, ErrorNote } from "@/components/ui";

type LLMSTxtResponse = {
  llms_txt: string;
  generated_at: string | null;
  public_url: string;
  mcp_url: string;
};

export default function LLMSTxtPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<LLMSTxtResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<LLMSTxtResponse>(`/sites/${slug}/llms-txt`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [slug]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-4">
      <CopyField label="Public URL" value={data.public_url} />
      {data.llms_txt ? (
        <Card title={`llms.txt${data.generated_at ? ` — generated ${new Date(data.generated_at).toLocaleString()}` : ""}`}>
          <pre className="max-h-144 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100">
            {data.llms_txt}
          </pre>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-zinc-600">
            Not generated yet. Run a crawl from the Overview tab first.
          </p>
        </Card>
      )}
    </div>
  );
}
