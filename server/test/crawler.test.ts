import { describe, expect, it } from "vitest";
import { normalize, sameSite } from "../src/crawler/crawler.js";
import { extract } from "../src/crawler/extract.js";
import type { Site } from "../src/store/types.js";

const site = { domain: "example.com" } as Site;

describe("normalize", () => {
  it("canonicalizes and filters URLs", () => {
    const cases: Record<string, string> = {
      "https://example.com/docs/": "https://example.com/docs",
      "https://EXAMPLE.com/a#frag": "https://example.com/a",
      "https://example.com/a?utm_source=x&q=1": "https://example.com/a?q=1",
      "https://www.example.com/": "https://www.example.com/",
      "https://docs.example.com/guide": "https://docs.example.com/guide",
      "https://other.com/page": "",
      "mailto:hi@example.com": "",
      "https://example.com/logo.png": "",
      "https://example.com/style.css": "",
      "https://notexample.com/": "",
      "https://evil-example.com/": "",
    };
    for (const [input, want] of Object.entries(cases)) {
      expect(normalize(site, input), input).toBe(want);
    }
  });
});

describe("sameSite", () => {
  it("allows domain, www, and subdomains only", () => {
    expect(sameSite(site, "example.com")).toBe(true);
    expect(sameSite(site, "www.example.com")).toBe(true);
    expect(sameSite(site, "docs.example.com")).toBe(true);
    expect(sameSite(site, "evil-example.com")).toBe(false);
    expect(sameSite(site, "other.com")).toBe(false);
  });
});

describe("extract", () => {
  it("pulls title, meta, markdown, hash, and links", () => {
    const html = `<html><head><title>Test Page</title>
<meta name="description" content="A test page.">
</head><body><nav><a href="/nav">Nav</a></nav>
<article><h1>Heading</h1><p>This is the body text of the article, long enough for readability to keep it around hopefully.</p>
<a href="/docs/next">Next</a><a href="https://other.com/x">External</a></article></body></html>`;
    const ex = extract(html, "https://example.com/page");
    expect(ex.title).toBe("Test Page");
    expect(ex.metaDesc).toBe("A test page.");
    expect(ex.markdown.length).toBeGreaterThan(0);
    expect(ex.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ex.links).toContain("https://example.com/docs/next");
    // External links are extracted; filtering happens in normalize.
    expect(ex.links).toContain("https://other.com/x");
  });
});
