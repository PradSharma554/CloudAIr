// Generates spec-compliant llms.txt files from crawled pages, using Gemini
// when available and a deterministic fallback (meta descriptions + path-based
// sections) otherwise — generation never fails because the LLM is down.
import type { LlmClient, Overview } from "./llm.js";
import type { PageStore } from "./store/pages.js";
import type { SiteStore } from "./store/sites.js";
import type { Page, Site } from "./store/types.js";

export class LlmsTxtGenerator {
  private publicBaseUrl: string;

  constructor(
    private sites: SiteStore,
    private pages: PageStore,
    private llm: LlmClient,
    publicBaseUrl: string
  ) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
  }

  /**
   * Summarizes pages (cached by content hash), builds the section structure,
   * renders llms.txt, and stores it on the site.
   */
  async generate(site: Site): Promise<void> {
    if (await this.nothingChanged(site)) {
      console.log(`llms.txt up to date for ${site.domain}, skipping generation (0 LLM calls)`);
      return;
    }
    try {
      await this.summarizePages(site);
    } catch (err) {
      console.warn(`page summarization incomplete for ${site.domain}, continuing with fallbacks:`, (err as Error).message);
    }
    const pages = await this.pages.list(site.id);
    if (pages.length === 0) {
      throw new Error(`no pages crawled for ${site.domain}`);
    }
    const overview = await this.overview(site, pages);
    const txt = this.render(site, overview, pages);
    await this.sites.updateLlmsTxt(site.id, txt);
  }

  /**
   * A recrawl produced identical content: llms.txt exists and every page
   * summary matches its content hash. Only meaningful with the LLM enabled —
   * fallback summaries carry no summary_hash so they are retried (and
   * upgraded) once a key is configured.
   */
  private async nothingChanged(site: Site): Promise<boolean> {
    if (!this.llm.enabled() || !site.llmsTxt) return false;
    const pages = await this.pages.list(site.id);
    if (pages.length === 0) return false;
    return pages.every((p) => p.summaryHash === p.contentHash && p.summary !== "");
  }

  /** Fills in Gemini summaries for pages whose content changed. Unchanged pages cost zero quota. */
  private async summarizePages(site: Site): Promise<void> {
    if (!this.llm.enabled()) return;
    let firstErr: Error | null = null;
    for await (const p of this.pages.iterateFull(site.id)) {
      if (p.summaryHash === p.contentHash && p.summary !== "") continue;
      try {
        const summary = await this.llm.summarizePage(p.title, p.markdown);
        await this.pages.setSummary(site.id, p.url, summary, p.contentHash);
      } catch (err) {
        firstErr ??= err as Error; // keep going; fallback covers this page
      }
    }
    if (firstErr) throw firstErr;
  }

  private async overview(site: Site, pages: Page[]): Promise<Overview> {
    if (this.llm.enabled()) {
      try {
        const ov = await this.llm.siteOverview(
          site.domain,
          pages.map((p) => ({ path: p.path, title: p.title, summary: displaySummary(p) }))
        );
        if (ov.site_summary) return ov;
      } catch (err) {
        console.warn(`site overview LLM call failed for ${site.domain}, using fallback sections:`, (err as Error).message);
      }
    }
    return fallbackOverview(pages);
  }

  /**
   * Renders the llms.txt document: H1 title, blockquote summary, H2 sections
   * with "- [title](url): description" link lists. Links point at the
   * CloudAIr markdown mirror so agent traffic flows through the access layer.
   */
  render(site: Site, ov: Overview, pages: Page[]): string {
    const byPath = new Map(pages.map((p) => [p.path, p]));
    const used = new Set<string>();
    const lines: string[] = [`# ${site.domain}`, ""];

    const summary = ov.site_summary?.trim().replaceAll("\n", " ");
    if (summary) lines.push(`> ${summary}`, "");
    lines.push(
      "This site is served to AI agents by CloudAIr. Machine-readable page mirrors and an MCP endpoint are available.",
      `MCP endpoint (Streamable HTTP): ${this.publicBaseUrl}/sites/${site.slug}/mcp`,
      ""
    );

    const writeSection = (name: string, paths: string[]) => {
      const items = paths
        .map((path) => byPath.get(path))
        .filter((p): p is Page => !!p && !used.has(p.path));
      if (items.length === 0) return;
      lines.push(`## ${name}`, "");
      for (const p of items) {
        used.add(p.path);
        lines.push(this.linkLine(site, p));
      }
      lines.push("");
    };

    for (const sec of ov.sections ?? []) {
      writeSection(sec.name, sec.paths ?? []);
    }
    writeSection(
      "Other",
      pages.filter((p) => !used.has(p.path)).map((p) => p.path)
    );

    return lines.join("\n").replace(/\n+$/, "") + "\n";
  }

  private linkLine(site: Site, p: Page): string {
    const title = p.title || p.path;
    const mirror = `${this.publicBaseUrl}/sites/${site.slug}/pages${p.path}`;
    const desc = displaySummary(p);
    return desc ? `- [${title}](${mirror}): ${desc}` : `- [${title}](${mirror})`;
  }
}

/** Groups pages by first path segment; site summary comes from the homepage. */
export function fallbackOverview(pages: Page[]): Overview {
  const ov: Overview = { site_summary: "", sections: [] };
  const groups = new Map<string, string[]>();
  for (const p of pages) {
    if (p.path === "/" || p.path === "") {
      if (!ov.site_summary) ov.site_summary = displaySummary(p);
      groups.set("Overview", [...(groups.get("Overview") ?? []), p.path]);
      continue;
    }
    const seg = p.path.replace(/^\//, "").split("/")[0];
    const name = titleCase(seg.replaceAll("-", " ").replaceAll("_", " "));
    groups.set(name, [...(groups.get(name) ?? []), p.path]);
  }
  const names = [...groups.keys()].sort((a, b) => {
    if (a === "Overview") return -1;
    if (b === "Overview") return 1;
    return a.localeCompare(b);
  });
  ov.sections = names.map((name) => ({ name, paths: groups.get(name)! }));
  return ov;
}

/** Prefers the LLM summary, then the meta description, then the first prose slice. */
export function displaySummary(p: Page): string {
  if (p.summary) return p.summary;
  if (p.metaDesc) return oneLine(p.metaDesc, 200);
  return firstProse(p.markdown);
}

/** Pulls the first plain-text paragraph out of markdown. */
function firstProse(md: string): string {
  for (const para of md.split("\n\n")) {
    const t = para.trim();
    if (
      !t || t.startsWith("#") || t.startsWith("!") || t.startsWith("|") ||
      t.startsWith("```") || t.startsWith("-") || t.startsWith("*")
    ) {
      continue;
    }
    return oneLine(t, 200);
  }
  return "";
}

function oneLine(s: string, max: number): string {
  const joined = s.split(/\s+/).join(" ");
  if (joined.length <= max) return joined;
  let cut = joined.slice(0, max);
  const i = cut.lastIndexOf(" ");
  if (i > 0) cut = cut.slice(0, i);
  return cut + "…";
}

function titleCase(s: string): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Pages";
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
