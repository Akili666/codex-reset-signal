import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

export type PushPlusRateOptions = {
  checkpointPath?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

// Four attempts per rolling 61 seconds leave headroom below the free provider's
// five-per-minute limit. The workflow concurrency lock serializes processes;
// this checkpoint also protects a manual test or restarted job's first request.
export class PushPlusRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private attempts: number[] | undefined;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: PushPlusRateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async (milliseconds) => { await setTimeout(milliseconds); });
  }

  acquire(): Promise<void> {
    const result = this.tail.then(() => this.reserve());
    this.tail = result.catch(() => {});
    return result;
  }

  private async load(): Promise<void> {
    if (this.attempts) return;
    if (!this.options.checkpointPath) { this.attempts = []; return; }
    let source: string;
    try { source = await readFile(this.options.checkpointPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.attempts = []; return; }
      throw new Error("PushPlus rate checkpoint could not be read");
    }
    let raw: unknown;
    try { raw = JSON.parse(source); }
    catch { throw new Error("PushPlus rate checkpoint is invalid"); }
    const record = raw as { version?: unknown; attempts?: unknown } | null;
    if (!record || record.version !== 1 || !Array.isArray(record.attempts) || record.attempts.length > 4 ||
        !record.attempts.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0))
      throw new Error("PushPlus rate checkpoint is invalid");
    this.attempts = [...record.attempts].sort((a, b) => a - b);
  }

  private async reserve(): Promise<void> {
    await this.load();
    while (true) {
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("PushPlus clock is invalid");
      if (this.attempts!.some((stamp) => stamp > now + 61_000))
        throw new Error("PushPlus rate checkpoint is ahead of the current clock");
      this.attempts = this.attempts!.filter((stamp) => stamp > now - 61_000);
      if (this.attempts.length < 4) {
        // Reserve before contacting the provider, including rejected requests.
        this.attempts.push(now);
        this.attempts.sort((a, b) => a - b);
        if (this.options.checkpointPath) {
          const path = this.options.checkpointPath;
          const temporaryPath = `${path}.${process.pid}.tmp`;
          try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(temporaryPath, JSON.stringify({ version: 1, attempts: this.attempts }) + "\n", "utf8");
            await rename(temporaryPath, path);
          } catch { throw new Error("PushPlus rate checkpoint could not be saved"); }
        }
        return;
      }
      await this.sleep(Math.max(1, this.attempts[0] + 61_000 - now));
    }
  }
}
