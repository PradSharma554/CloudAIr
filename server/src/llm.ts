// Wraps the Gemini API with free-tier quota discipline: a hard
// requests-per-minute throttle, single retry on quota errors, and a disabled
// mode (no API key) that callers must treat as "use the fallback".
import { GoogleGenAI } from "@google/genai";
import { setTimeout as sleep } from "node:timers/promises";

// 8 RPM stays under the free tier's ~10-15 RPM ceiling.
const MIN_INTERVAL_MS = 60_000 / 8;

export interface PageMeta {
  path: string;
  title: string;
  summary: string;
}

export interface Overview {
  site_summary: string;
  sections: { name: string; paths: string[] }[];
}

export class LlmClient {
  private ai: GoogleGenAI | null;
  private callCount = 0;
  private lastCallAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(apiKey: string, private model: string) {
    this.ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  enabled(): boolean {
    return this.ai !== null;
  }

  /** Gemini requests made since boot — lets "0 calls on unchanged recrawl" be verified. */
  calls(): number {
    return this.callCount;
  }

  private async generate(prompt: string, jsonOut: boolean): Promise<string> {
    if (!this.ai) throw new Error("llm disabled");
    // Serialize calls through a queue so the RPM throttle holds even with
    // concurrent callers.
    const result = this.queue.then(async () => {
      const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      return this.generateOnce(prompt, jsonOut);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async generateOnce(prompt: string, jsonOut: boolean, retried = false): Promise<string> {
    this.callCount++;
    try {
      const resp = await this.ai!.models.generateContent({
        model: this.model,
        contents: prompt,
        config: jsonOut ? { responseMimeType: "application/json" } : undefined,
      });
      return (resp.text ?? "").trim();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!retried && (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED"))) {
        console.warn("gemini quota hit, retrying once in 30s");
        await sleep(30_000);
        return this.generateOnce(prompt, jsonOut, true);
      }
      throw err;
    }
  }

  /** One-sentence description for the llms.txt index. */
  async summarizePage(title: string, markdown: string): Promise<string> {
    const prompt = `You are writing an index of a website for AI agents (an llms.txt file).
Write a single-sentence description (25 words or fewer) of the following page.
Return ONLY the sentence — no quotes, no preamble.

Page title: ${title}

Page content (markdown, truncated):
${markdown.slice(0, 4000)}`;
    const out = await this.generate(prompt, false);
    // Keep it to one line regardless of what the model returns.
    return out.split("\n")[0].trim();
  }

  /** Site summary + H2 section grouping for llms.txt. */
  async siteOverview(domain: string, pages: PageMeta[]): Promise<Overview> {
    const prompt = `You are generating the structure of an llms.txt file for the website ${domain}.
Given this JSON list of pages (path, title, summary), return JSON with:
- "site_summary": one paragraph (2-3 sentences) describing the site for AI agents
- "sections": 2-6 groups, each {"name": "Section Name", "paths": ["/path", ...]} covering the most important pages. Put low-value pages (legal, login, etc.) in a section named "Optional" or omit them.

Pages:
${JSON.stringify(pages)}`;
    const out = await this.generate(prompt, true);
    const parsed = JSON.parse(out) as Overview;
    if (typeof parsed.site_summary !== "string" || !Array.isArray(parsed.sections)) {
      throw new Error("overview JSON has wrong shape");
    }
    return parsed;
  }
}
