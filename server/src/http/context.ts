// Typed accessors for per-request state (res.locals). Handlers never parse
// URLs for the site — they read it from here; resolvers decide how a request
// maps to a site.
import type { Request, RequestHandler, Response } from "express";
import type { AgentInfo } from "../agents.js";
import type { Site } from "../store/types.js";

export function setSite(res: Response, site: Site): void {
  res.locals.site = site;
}

export function getSite(res: Response): Site {
  return res.locals.site as Site;
}

export function setAgent(res: Response, info: AgentInfo): void {
  res.locals.agent = info;
}

export function getAgent(res: Response): AgentInfo {
  return (res.locals.agent as AgentInfo) ?? { class: "unknown", name: "", operator: "" };
}

export function setUserId(res: Response, id: string): void {
  res.locals.userId = id;
}

export function getUserId(res: Response): string {
  return res.locals.userId as string;
}

/** Express 4 does not catch async handler rejections; this wrapper does. */
export function wrap(
  fn: (req: Request, res: Response) => Promise<void> | void
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
