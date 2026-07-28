import { describe, expect, it } from "vitest";
import { newVerificationToken, normalizeDomain, slugify } from "../src/domains.js";

describe("normalizeDomain", () => {
  it("normalizes valid inputs", () => {
    const cases: Record<string, string> = {
      "example.com": "example.com",
      "EXAMPLE.COM": "example.com",
      "https://www.example.com/path": "example.com",
      "http://example.com": "example.com",
      "docs.example.com": "docs.example.com",
      "www.example.co.uk": "example.co.uk",
      "  example.com  ": "example.com",
    };
    for (const [input, want] of Object.entries(cases)) {
      expect(normalizeDomain(input), input).toBe(want);
    }
  });

  it("rejects invalid inputs", () => {
    for (const bad of ["", "localhost", "co.uk", "not a domain", "http://"]) {
      expect(() => normalizeDomain(bad), bad).toThrow();
    }
  });
});

describe("slugify", () => {
  it("makes subdomain-safe labels", () => {
    expect(slugify("docs.example.com")).toBe("docs-example-com");
  });
});

describe("newVerificationToken", () => {
  it("is unique and well-formed", () => {
    const a = newVerificationToken();
    expect(a).not.toBe(newVerificationToken());
    expect(a).toMatch(/^cloudair-verify=[0-9a-f]{32}$/);
  });
});
