import { describe, expect, it } from "vitest";
import { AgentClassifier } from "../src/agents.js";

describe("AgentClassifier", () => {
  const c = new AgentClassifier();

  it("identifies declared agents by UA substring", () => {
    const cases: [string, string, string, string][] = [
      ["Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "", "declared-agent", "GPTBot"],
      ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "", "declared-agent", "ClaudeBot"],
      ["Mozilla/5.0 (compatible; PerplexityBot/1.0)", "", "declared-agent", "PerplexityBot"],
    ];
    for (const [ua, lang, cls, name] of cases) {
      const got = c.classify(ua, lang);
      expect(got.class, ua).toBe(cls);
      expect(got.name, ua).toBe(name);
    }
  });

  it("matches Applebot-Extended before Applebot (order matters)", () => {
    expect(c.classify("Mozilla/5.0 (compatible; Applebot-Extended/1.0)", "").name).toBe("Applebot-Extended");
    expect(c.classify("Mozilla/5.0 (compatible; Applebot/1.0)", "").name).toBe("Applebot");
  });

  it("flags bot-ish tools as suspected", () => {
    expect(c.classify("curl/8.4.0", "").class).toBe("suspected-agent");
    expect(c.classify("python-requests/2.31", "").class).toBe("suspected-agent");
    expect(c.classify("", "").class).toBe("suspected-agent");
    // Browser UA but no Accept-Language is suspicious too.
    expect(c.classify("Mozilla/5.0 (Macintosh) Safari/605.1.15", "").class).toBe("suspected-agent");
  });

  it("treats normal browsers as unknown", () => {
    expect(c.classify("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "en-US").class).toBe("unknown");
  });

  it("loads a healthy signature table", () => {
    expect(c.list().length).toBeGreaterThanOrEqual(20);
  });
});
