import { createHash } from "node:crypto";
import { Readability } from "@mozilla/readability";
import * as cheerio from "cheerio";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

const MAX_MARKDOWN_BYTES = 200 * 1024; // Neon storage budget: ≤200KB per page

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript"]);

// jsdom logs CSS parse errors from real-world pages; silence them.
const virtualConsole = new VirtualConsole();

export interface Extracted {
  title: string;
  metaDesc: string;
  markdown: string;
  hash: string;
  links: string[];
}

/** Turns raw HTML into clean markdown plus outbound links. */
export function extract(rawHtml: string, pageUrl: string): Extracted {
  const $ = cheerio.load(rawHtml);
  const title = $("title").first().text().trim();
  const metaDesc = ($('meta[name="description"]').attr("content") ?? "").trim();

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href) return;
    try {
      links.push(new URL(href, pageUrl).toString());
    } catch {
      /* unparseable href — skip */
    }
  });

  // Readability strips nav/chrome; fall back to the whole page when it can't
  // find an article (e.g. link-heavy index pages).
  let contentHtml = rawHtml;
  let readTitle = "";
  try {
    const dom = new JSDOM(rawHtml, { url: pageUrl, virtualConsole });
    const article = new Readability(dom.window.document).parse();
    if (article?.content) {
      contentHtml = article.content;
      readTitle = article.title ?? "";
    }
  } catch {
    /* jsdom/readability failure — use full page */
  }

  let markdown = turndown.turndown(contentHtml).trim();
  if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) {
    markdown = Buffer.from(markdown).subarray(0, MAX_MARKDOWN_BYTES).toString("utf8");
  }

  return {
    title: title || readTitle,
    metaDesc,
    markdown,
    hash: createHash("sha256").update(markdown).digest("hex"),
    links,
  };
}

/*
                 Download webpage
                        │
                        ▼
                    raw HTML
                        │
          ┌─────────────┴──────────────┐
          │                            │
          ▼                            ▼
      Cheerio                      JSDOM
          │                            │
    ┌─────┴─────┐                      ▼
    │           │                 Readability
    ▼           ▼                      │
  title     metaDesc             clean HTML
    │                                    │
    │                                    ▼
    │                                Turndown
    │                                    │
    │                                    ▼
    │                                Markdown
    │                                    │
    │                            ┌───────┴──────┐
    │                            ▼              ▼
    │                         200KB limit    SHA-256
    │                            │              │
    └──────────────┬─────────────┴──────────────┘
                   │
                   ▼
              Extracted object
                   │
                   ├── title
                   ├── metaDesc
                   ├── markdown
                   ├── hash
                   └── links
*/