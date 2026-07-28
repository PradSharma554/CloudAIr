// Exposes each registered site as a stateless Streamable HTTP MCP server
// with search_site / get_page / list_pages tools. All SDK types are confined
// to this module.
//
// Stateless mode: a fresh server + transport per POST, no session IDs. Each
// request is self-contained, so free-tier instance spin-downs are invisible
// to connected clients beyond cold-start latency.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import type { PageStore } from "./store/pages.js";
import { NotFoundError, type Site } from "./store/types.js";

export class McpManager {
  constructor(private pages: PageStore, private publicBaseUrl: string) {}

  async handleRequest(site: Site, req: Request, res: Response): Promise<void> {
    if (req.method !== "POST") {
      // Stateless servers have no SSE stream to GET and no session to DELETE.
      res.status(405).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "stateless server: POST only" },
      });
      return;
    }
    const server = this.buildServer(site);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  private buildServer(site: Site): McpServer {
    const server = new McpServer(
      { name: `cloudair-${site.slug}`, title: `${site.domain} (via CloudAIr)`, version: "1.0.0" },
      {
        instructions:
          `This server exposes the content of ${site.domain}. Use search_site to find relevant pages, ` +
          `then get_page to read one. list_pages returns the full index. ` +
          `An llms.txt overview is available at ${this.publicBaseUrl}/sites/${site.slug}/llms.txt.`,
      }
    );

    server.registerTool(
      "search_site",
      {
        description: `Full-text search over the pages of ${site.domain}. Returns matching pages with snippets.`,
        inputSchema: {
          query: z.string().describe("the search query"),
          limit: z.number().int().optional().describe("max results to return (default 5, max 20)"),
        },
      },
      async ({ query, limit }) => {
        if (!query.trim()) throw new Error("query is required");
        const results = await this.pages.search(site.id, query, limit ?? 5);
        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
          structuredContent: { results },
        };
      }
    );

    server.registerTool(
      "get_page",
      {
        description: `Fetch one page of ${site.domain} as clean markdown by its path.`,
        inputSchema: {
          path: z.string().describe("page path starting with /, e.g. /docs/start"),
        },
      },
      async ({ path }) => {
        let p = path || "/";
        if (!p.startsWith("/")) p = `/${p}`;
        try {
          const page = await this.pages.byPath(site.id, p);
          return {
            content: [
              { type: "text", text: `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}` },
            ],
          };
        } catch (err) {
          if (err instanceof NotFoundError) {
            throw new Error(`no page at ${p} — use list_pages or search_site to find valid paths`);
          }
          throw err;
        }
      }
    );

    server.registerTool(
      "list_pages",
      {
        description: `List all indexed pages of ${site.domain} with titles and summaries.`,
      },
      async () => {
        const pages = await this.pages.list(site.id);
        const out = {
          pages: pages.map((p) => ({ path: p.path, title: p.title, summary: p.summary })),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        };
      }
    );

    return server;
  }
}
