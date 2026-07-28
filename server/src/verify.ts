// Site ownership verification: DNS TXT record (primary) or a well-known
// file (fallback), like Search Console.
import { Resolver } from "node:dns/promises";

export type VerifyMethod = "dns" | "file";

// Public resolver dodges local DNS caching of the freshly-created TXT record.
const resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(["8.8.8.8"]);

/**
 * Tries DNS TXT first, then the well-known file. Returns the method that
 * succeeded, or throws describing both failures.
 */
export async function checkOwnership(domain: string, token: string): Promise<VerifyMethod> {
  let dnsErr: string;
  try {
    await checkDns(domain, token);
    return "dns";
  } catch (err) {
    dnsErr = (err as Error).message;
  }
  try {
    await checkFile(domain, token);
    return "file";
  } catch (err) {
    throw new Error(`dns: ${dnsErr}; file: ${(err as Error).message}`);
  }
}

async function checkDns(domain: string, token: string): Promise<void> {
  const host = `_cloudair.${domain}`;
  let records: string[][];
  try {
    records = await resolver.resolveTxt(host);
  } catch (err) {
    throw new Error(`TXT lookup for ${host} failed: ${(err as Error).message}`);
  }
  // TXT records arrive as chunked strings; join each record's chunks.
  const found = records.some((chunks) => chunks.join("").trim() === token);
  if (!found) throw new Error(`no matching TXT record at ${host}`);
}

async function checkFile(domain: string, token: string): Promise<void> {
  const url = `https://${domain}/.well-known/cloudair-verify.txt`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "CloudAIrBot/1.0 (+ownership-verification)" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(`fetch ${url}: ${(err as Error).message}`);
  }
  if (!resp.ok) throw new Error(`${url} returned ${resp.status}`);
  const body = (await resp.text()).slice(0, 4096).trim();
  if (body !== token) throw new Error(`${url} content does not match token`);
}
