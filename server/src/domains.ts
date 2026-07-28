// Site registration helpers: domain normalization, slug generation, and
// verification tokens.
import { randomBytes } from "node:crypto";
import { getDomain, getPublicSuffix } from "tldts";

/**
 * Accepts what users paste ("https://www.Example.com/path", "example.com")
 * and returns the domain, lowercased, www-stripped. Rejects bare public
 * suffixes like "co.uk"; allows subdomains (docs.example.com).
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  if (!d) throw new Error("domain is required");
  if (d.includes("://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      throw new Error("invalid URL");
    }
  }
  d = d.split("/")[0].replace(/\.$/, "").replace(/^www\./, "");
  if (!d.includes(".") || /[ :@]/.test(d)) {
    throw new Error(`invalid domain "${d}"`);
  }
  if (getPublicSuffix(d) === d || getDomain(d) === null) {
    throw new Error(`"${d}" is not a registrable domain`);
  }
  return d;
}

/**
 * URL/subdomain-safe label: docs.example.com → docs-example-com.
 * Doubles as the future <slug>.cloudair.dev subdomain.
 */
export function slugify(domain: string): string {
  return domain.replaceAll(".", "-").replaceAll("_", "-");
}

export function newVerificationToken(): string {
  return `cloudair-verify=${randomBytes(16).toString("hex")}`;
}
