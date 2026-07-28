// The paywall seam: a design-only stub for v1 that returns HTTP 402 with an
// x402-spec payment-required body when a site has monetization enabled and
// the request carries no X-PAYMENT header.
//
// The real integration (verifying X-PAYMENT via a facilitator, settling on
// Base) plugs into this same check later — see docs/x402.md.
import type { Request, Response } from "express";
import type { Site } from "./store/types.js";

/**
 * Returns true if the request may proceed; otherwise writes the 402 response
 * itself. v1 stub: any X-PAYMENT header passes — verification via a
 * facilitator is the later phase.
 */
export function paywallCheck(site: Site, req: Request, res: Response): boolean {
  const mon = site.settings.monetization;
  if (!mon?.enabled || req.header("X-PAYMENT")) return true;

  const priceUsd = mon.price_usd && mon.price_usd > 0 ? mon.price_usd : 0.01;
  res.status(402).json({
    x402Version: 1,
    error: "payment required to access this resource",
    accepts: [
      {
        scheme: "exact",
        network: mon.network || "base-sepolia",
        // USDC atomic units (6 decimals).
        maxAmountRequired: String(Math.round(priceUsd * 1e6)),
        resource: req.originalUrl,
        description: `Access to ${site.domain} agent content via CloudAIr`,
        payTo: mon.pay_to ?? "",
        asset: "USDC",
        mimeType: "text/markdown",
      },
    ],
  });
  return false;
}
