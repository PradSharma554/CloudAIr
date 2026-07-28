# Maintaining the agent signature table

`server/src/signatures.json` maps
User-Agent substrings to known AI agents. Each entry:

```json
{
  "name": "GPTBot",              // canonical name shown in analytics
  "operator": "OpenAI",
  "ua_substrings": ["GPTBot"],   // case-insensitive substring match
  "purpose": "training",         // training | search | user-action | research
  "respects_robots": true
}
```

Matching is first-match-wins, so keep more specific substrings (e.g.
`Applebot-Extended`) **before** their prefixes (`Applebot`) — order entries
accordingly.

Good sources for new signatures:
- <https://platform.openai.com/docs/bots>
- <https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler>
- <https://docs.perplexity.ai/guides/bots>
- <https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers>
- community lists like `ai-robots-txt/ai.robots.txt` on GitHub

After editing, run `npm test` in `server/` (validates the JSON parses and
classification still works).
