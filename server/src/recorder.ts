// Buffers agent-request events in memory and batch-writes them to Postgres,
// so recording never blocks agent traffic.
import type { AnalyticsStore } from "./store/analytics.js";
import type { AgentRequestEvent } from "./store/types.js";

const BUFFER_CAP = 1000;
const FLUSH_EVERY_MS = 5000;
const FLUSH_AT = 100;

export class Recorder {
  private buffer: AgentRequestEvent[] = [];
  private droppedCount = 0;
  private timer: NodeJS.Timeout;
  private flushing = false;
  private closed = false;

  constructor(private store: AnalyticsStore) {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.timer.unref();
  }

  /** Enqueues an event; drops (with a counter) rather than blocking when full. */
  record(e: AgentRequestEvent): void {
    if (this.closed) return;
    if (this.buffer.length >= BUFFER_CAP) {
      this.droppedCount++;
      return;
    }
    this.buffer.push(e);
    if (this.buffer.length >= FLUSH_AT) void this.flush();
  }

  dropped(): number {
    return this.droppedCount;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.store.insertEvents(batch);
    } catch (err) {
      console.error(`analytics flush failed (${batch.length} events):`, (err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  /** Final flush on graceful shutdown (Render sends SIGTERM before spin-down). */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }
}
