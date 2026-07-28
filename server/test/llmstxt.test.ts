import { describe, expect, it } from "vitest";
import { LlmClient } from "../src/llm.js";
import { displaySummary, fallbackOverview, LlmsTxtGenerator } from "../src/llmstxt.js";
import type { Page, Site } from "../src/store/types.js";

function testPages(): Page[] {
  const base: Omit<Page, "path" | "url" | "title"> = {
    id: "", siteId: "", metaDesc: "", contentHash: "", markdown: "",
    summary: "", summaryHash: "", fetchedAt: null,
  };
  return [
    { ...base, path: "/", url: "https://example.com/", title: "Example Home", metaDesc: "The example site for testing.", markdown: "Welcome to Example." },
    { ...base, path: "/docs/start", url: "https://example.com/docs/start", title: "Getting Started", summary: "Install and configure in five minutes." },
    { ...base, path: "/docs/api", url: "https://example.com/docs/api", title: "API Reference", markdown: "The API accepts JSON requests over HTTPS." },
    { ...base, path: "/pricing", url: "https://example.com/pricing", title: "Pricing", metaDesc: "Plans and pricing." },
  ];
}

const site = { domain: "example.com", slug: "example-com" } as Site;

describe("render", () => {
  it("produces a spec-compliant llms.txt", () => {
    const g = new LlmsTxtGenerator(
      null as never, null as never, new LlmClient("", "x"), "https://cloudair.onrender.com/"
    );
    const out = g.render(
      site,
      { site_summary: "An example site.", sections: [{ name: "Docs", paths: ["/docs/start", "/docs/api"] }] },
      testPages()
    );
    for (const want of [
      "# example.com",
      "> An example site.",
      "## Docs",
      "- [Getting Started](https://cloudair.onrender.com/sites/example-com/pages/docs/start): Install and configure in five minutes.",
      "## Other", // pages not covered by sections land here
      "/sites/example-com/pages/pricing",
      "/sites/example-com/mcp",
    ]) {
      expect(out).toContain(want);
    }
    expect(out.startsWith("# example.com\n")).toBe(true);
  });
});

describe("fallbackOverview", () => {
  it("groups by path segment and summarizes from the homepage", () => {
    const ov = fallbackOverview(testPages());
    expect(ov.site_summary).toBe("The example site for testing.");
    const names = ov.sections.map((s) => s.name);
    expect(names[0]).toBe("Overview");
    expect(names).toContain("Docs");
    expect(names).toContain("Pricing");
  });
});

describe("displaySummary", () => {
  it("prefers LLM summary, then meta description, then first prose", () => {
    const p = { summary: "llm", metaDesc: "meta", markdown: "prose here" } as Page;
    expect(displaySummary(p)).toBe("llm");
    p.summary = "";
    expect(displaySummary(p)).toBe("meta");
    p.metaDesc = "";
    expect(displaySummary(p)).toBe("prose here");
  });
});

describe("LlmClient disabled mode", () => {
  it("reports disabled without an API key", () => {
    expect(new LlmClient("", "any-model").enabled()).toBe(false);
  });
});
