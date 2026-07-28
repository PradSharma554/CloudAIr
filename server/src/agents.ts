// Classifies incoming requests by the AI agent behind them, using an
// embedded User-Agent signature table plus heuristics.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Trust level of an identified agent. "verified-agent" is reserved for Web
 * Bot Auth (RFC 9421 HTTP message signatures) in a later phase — the enum and
 * analytics schema include it now so no migration is needed then.
 */
export type AgentClass = "verified-agent" | "declared-agent" | "suspected-agent" | "unknown";

export interface Signature {
  name: string;
  operator: string;
  ua_substrings: string[];
  purpose: string;
  respects_robots: boolean;
}

export interface AgentInfo {
  class: AgentClass;
  name: string;
  operator: string;
}

const SUSPECTED_MARKERS = [
  "bot", "crawler", "spider", "scraper", "python-requests", "python/",
  "curl/", "wget/", "go-http-client", "httpx", "aiohttp", "axios",
  "node-fetch", "libwww", "java/", "okhttp",
];

export class AgentClassifier {
  private signatures: Signature[];

  constructor() {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "signatures.json");
    this.signatures = JSON.parse(readFileSync(file, "utf8")) as Signature[];
    if (this.signatures.length === 0) throw new Error("signatures.json is empty");
  }

  classify(userAgent: string, acceptLanguage: string): AgentInfo {
    const ua = userAgent.toLowerCase();
    for (const sig of this.signatures) {
      for (const sub of sig.ua_substrings) {
        if (ua.includes(sub.toLowerCase())) {
          return { class: "declared-agent", name: sig.name, operator: sig.operator };
        }
      }
    }
    if (SUSPECTED_MARKERS.some((m) => ua.includes(m))) {
      return { class: "suspected-agent", name: "", operator: "" };
    }
    if (!userAgent || !acceptLanguage) {
      return { class: "suspected-agent", name: "", operator: "" };
    }
    return { class: "unknown", name: "", operator: "" };
  }

  list(): Signature[] {
    return this.signatures;
  }
}
