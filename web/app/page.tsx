import Link from "next/link";
import { auth } from "@/auth";

const DEMO_LLMS = "https://cloudair-673n.onrender.com/sites/pradsharma554-github-io/llms.txt";
const DEMO_MCP = "https://cloudair-673n.onrender.com/sites/pradsharma554-github-io/mcp";

export default async function LandingPage() {
  const session = await auth();
  const cta = session ? { href: "/sites", label: "Open dashboard" } : { href: "/login", label: "Sign in" };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <span className="font-semibold tracking-tight">CloudAIr</span>
          <nav className="flex items-center gap-4 text-sm">
            <a
              href="https://github.com/PradSharma554/CloudAIr"
              className="text-zinc-400 hover:text-zinc-100"
            >
              GitHub
            </a>
            <Link
              href={cta.href}
              className="rounded-lg bg-zinc-100 px-4 py-1.5 font-medium text-zinc-900 hover:bg-white"
            >
              {cta.label}
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-5xl px-4 pb-16 pt-20 text-center">
          <p className="mb-4 text-xs font-medium uppercase tracking-widest text-sky-400">
            llms.txt · MCP · analytics · rate limiting
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            The access layer between your website and AI agents
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">
            GPTBot, ClaudeBot, and Perplexity already read your site. CloudAIr
            makes that traffic legible, measurable, and controllable — it crawls
            your site, generates its llms.txt, serves clean markdown to agents,
            and exposes your content as an MCP server. You watch who shows up
            and set the rules.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link
              href={cta.href}
              className="rounded-lg bg-sky-500 px-6 py-2.5 font-medium text-white hover:bg-sky-400"
            >
              {session ? "Open dashboard" : "Add your site"}
            </Link>
            <a
              href={DEMO_LLMS}
              className="rounded-lg border border-zinc-700 px-6 py-2.5 font-medium text-zinc-300 hover:border-zinc-500 hover:text-white"
            >
              See a live llms.txt
            </a>
          </div>
        </section>

        {/* Flow diagram */}
        <section className="mx-auto max-w-5xl px-4 pb-16">
          <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex min-w-[640px] items-stretch justify-between gap-3 text-center text-sm">
              <div className="flex-1 rounded-xl border border-zinc-700 bg-zinc-950 p-4">
                <div className="font-medium">AI agents</div>
                <div className="mt-1 text-xs text-zinc-500">
                  GPTBot · ClaudeBot · PerplexityBot · MCP clients
                </div>
              </div>
              <div className="flex items-center text-zinc-600">→</div>
              <div className="flex-1 rounded-xl border border-sky-800 bg-sky-950/40 p-4">
                <div className="font-medium text-sky-300">CloudAIr</div>
                <div className="mt-1 text-xs text-zinc-400">
                  identify → rate limit → record → serve
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  /llms.txt · /pages/* · /mcp
                </div>
              </div>
              <div className="flex items-center text-zinc-600">→</div>
              <div className="flex-1 rounded-xl border border-zinc-700 bg-zinc-950 p-4">
                <div className="font-medium">Your website</div>
                <div className="mt-1 text-xs text-zinc-500">
                  crawled politely, mirrored as markdown
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-5xl px-4 pb-16">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: "llms.txt, generated",
                body: "A crawler indexes your site and Gemini writes the spec-compliant llms.txt — page summaries, section structure, always up to date. Works even without an LLM via a deterministic fallback.",
              },
              {
                title: "Your site as an MCP server",
                body: "Every site gets a Streamable HTTP MCP endpoint with search_site, get_page, and list_pages tools — agents query your content instead of scraping it.",
              },
              {
                title: "Know your agents",
                body: "Requests are classified against a signature table of ~30 AI crawlers, and MCP clients identify themselves in the handshake. Dashboards show who came, what they read, which tools they called.",
              },
              {
                title: "Rate limits you control",
                body: "Per-agent token buckets with rules you set: give ClaudeBot 60 rpm, GPTBot 5, unknown bots less. Proper 429s with Retry-After.",
              },
              {
                title: "Clean markdown mirrors",
                body: "Every crawled page is served as readability-extracted markdown — no nav, no cookie banners, no JavaScript. What agents actually want.",
              },
              {
                title: "Survives free-tier infrastructure",
                body: "Crash-resumable crawls via per-page checkpoints, stateless MCP, and quota-aware LLM usage — the whole stack runs at $0/month.",
              },
            ].map((f) => (
              <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
                <h3 className="mb-2 font-medium">{f.title}</h3>
                <p className="text-sm leading-relaxed text-zinc-400">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-5xl px-4 pb-16">
          <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight">
            Live in four steps
          </h2>
          <ol className="grid gap-4 sm:grid-cols-4">
            {[
              ["Register", "Sign in and add your domain."],
              ["Verify", "Prove ownership with a DNS TXT record or a well-known file."],
              ["Crawl", "CloudAIr indexes up to 50 pages, robots.txt-aware, and generates your llms.txt."],
              ["Point agents", "Redirect /llms.txt to CloudAIr and share your MCP endpoint. Watch analytics roll in."],
            ].map(([title, body], i) => (
              <li key={title} className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="mb-2 text-xs font-semibold text-sky-400">STEP {i + 1}</div>
                <div className="font-medium">{title}</div>
                <p className="mt-1 text-sm text-zinc-400">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Live demo */}
        <section className="mx-auto max-w-5xl px-4 pb-20">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <h2 className="text-xl font-semibold">See it running</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">
              This isn&apos;t a mockup — a real site is served through CloudAIr right
              now. Read its generated llms.txt, or connect the MCP endpoint to
              Claude Code and ask questions about it.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3 text-sm">
              <a
                href={DEMO_LLMS}
                className="rounded-lg border border-zinc-700 px-4 py-2 font-mono text-xs text-zinc-300 hover:border-zinc-500"
              >
                {DEMO_LLMS.replace("https://", "")}
              </a>
            </div>
            <pre className="mx-auto mt-5 max-w-2xl overflow-x-auto rounded-lg bg-zinc-950 p-4 text-left text-xs text-zinc-400">
              {`claude mcp add --transport http portfolio ${DEMO_MCP}`}
            </pre>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800 py-8 text-center text-sm text-zinc-500">
        Built by{" "}
        <a href="https://pradsharma554.github.io" className="text-zinc-300 hover:text-white">
          Pradyuman Sharma
        </a>{" "}
        ·{" "}
        <a href="https://github.com/PradSharma554/CloudAIr" className="text-zinc-300 hover:text-white">
          Source on GitHub
        </a>
      </footer>
    </div>
  );
}
