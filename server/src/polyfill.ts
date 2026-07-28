// Node 18 lacks the global File that undici (pulled in via jsdom/cheerio)
// expects; Node 20+ has it. Harmless no-op on newer runtimes.
import { File as NodeFile } from "node:buffer";

if (typeof globalThis.File === "undefined") {
  (globalThis as Record<string, unknown>).File = NodeFile;
}
