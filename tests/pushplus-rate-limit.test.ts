import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PushPlusRateLimiter } from "../src/pushplus-rate-limit";
import { createTargets } from "../src/notifications";
import { loadConfig } from "../src/config";
import { runMonitor } from "../src/monitor";
import { emptyState, readState, writeState } from "../src/state";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function tempDir() { const path = await mkdtemp(join(tmpdir(), "tibo-rate-")); dirs.push(path); return path; }
function clock() {
  let now = Date.parse("2026-10-25T00:00:00Z");
  const waits: number[] = [];
  return { now: () => now, sleep: async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds; }, waits };
}
const post = { id: "2", text: "New announcement", createdAt: "2026-10-24T23:59:00Z", postType: "original" as const, url: "https://x.com/thsottiaux/status/2", media: [] };

describe("durable PushPlus rate limiting", () => {
  it("reserves concurrent requests serially and never allows a fifth in the same minute", async () => {
    const time = clock();
    const gate = new PushPlusRateLimiter(time);
    const stamps: number[] = [];
    await Promise.all(Array.from({ length: 9 }, async () => { await gate.acquire(); stamps.push(time.now()); }));
    expect(time.waits).toEqual([61_000, 61_000]);
    for (const stamp of stamps) expect(stamps.filter((other) => other >= stamp && other < stamp + 60_000).length).toBeLessThanOrEqual(4);
  });

  it("persists attempts before sending, and a restarted process waits for an available slot", async () => {
    const dir = await tempDir(); const checkpointPath = join(dir, "rate.json"); const time = clock();
    const first = new PushPlusRateLimiter({ checkpointPath, ...time });
    for (let i = 0; i < 4; i++) await first.acquire();
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).attempts).toHaveLength(4);
    await new PushPlusRateLimiter({ checkpointPath, ...time }).acquire();
    expect(time.waits).toEqual([61_000]);
    const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(saved).toEqual({ version: 1, attempts: [time.now()] });
  });

  it("discards expired attempt timestamps without making a new request wait", async () => {
    const dir = await tempDir(); const path = join(dir, "rate.json"); const time = clock();
    await writeFile(path, JSON.stringify({ version: 1, attempts: Array(4).fill(time.now() - 70_000) }));
    await new PushPlusRateLimiter({ checkpointPath: path, ...time }).acquire();
    expect(time.waits).toEqual([]);
  });

  it("rejects malformed checkpoints without echoing their content or making requests", async () => {
    const dir = await tempDir(); const path = join(dir, "rate.json");
    await writeFile(path, 'private-bad-data');
    await expect(new PushPlusRateLimiter({ checkpointPath: path }).acquire()).rejects.toThrow(/^PushPlus rate checkpoint is invalid$/);
    await writeFile(path, JSON.stringify({ version: 1, attempts: ["not-a-number"] }));
    await expect(new PushPlusRateLimiter({ checkpointPath: path }).acquire()).rejects.toThrow(/^PushPlus rate checkpoint is invalid$/);
  });

  it("records rejected provider requests, so retrying does not bypass the minute limit", async () => {
    const dir = await tempDir(); const time = clock();
    const config = loadConfig({ PUSHPLUS_TOKEN: "fake-token", PUSHPLUS_RATE_STATE_PATH: join(dir, "rate.json") });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 905, msg: "private-detail" }));
    const target = createTargets(config, fetcher, { pushplusRate: time })[0];
    const item = { key: "post", post, events: [], targets: [target.id], delivered: [] };
    for (let i = 0; i < 5; i++) await expect(target.send(item)).rejects.toThrow("code 905");
    expect(time.waits).toEqual([61_000]); expect(fetcher).toHaveBeenCalledTimes(5);
    expect(await readFile(config.pushplusRateStatePath!, "utf8")).not.toContain("fake-token");
  });

  it("renders the push time after the rate wait and reuses translations", async () => {
    const time = clock();
    const config = loadConfig({ PUSHPLUS_TOKEN: "fake-token", TRANSLATE_ZH: "true" });
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com") ? Response.json([[["新动态。"]]]) : Response.json({ code: 200, data: "receipt" }));
    const target = createTargets(config, fetcher, { pushplusRate: time, now: () => new Date(time.now()) })[0];
    for (let i = 0; i < 5; i++) await target.send({ key: "same-post", post, events: [], targets: [target.id], delivered: [] });
    const calls = fetcher.mock.calls.filter(([url]) => String(url).includes("pushplus.plus"));
    const body = JSON.parse(String(calls[4][1]?.body));
    expect(body.content).toContain("推送时间：2026-10-25 08:01:01（北京时间）");
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("translate.googleapis.com"))).toHaveLength(1);
  });

  it("bounds very large backlogs while keeping remaining items durable and previously accepted items deduplicated", async () => {
    const dir = await tempDir(); const time = clock();
    const config = loadConfig({ PUSHPLUS_TOKEN: "fake-token", PUSHPLUS_RATE_STATE_PATH: join(dir, "rate.json"), EMAIL_ENABLED: "false", NOTIFY_ALL_POSTS: "true", STATE_PATH: join(dir, "state.json") });
    await writeState(config.statePath, { ...emptyState(config.username, config.keyword), sinceId: "1", userId: "42" });
    const posts = Array.from({ length: 21 }, (_, i) => ({ ...post, id: String(i + 2), url: `https://x.com/thsottiaux/status/${i + 2}` }));
    const source = { resolveUserId: vi.fn(), getPosts: vi.fn().mockResolvedValue({ posts, newestId: "22" }) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 200, data: "receipt" }));
    await expect(runMonitor(config, { source, targets: createTargets(config, fetcher, { pushplusRate: time }) })).rejects.toThrow("will retry");
    expect(fetcher).toHaveBeenCalledTimes(20);
    const state = await readState(config.statePath, config.username, config.keyword);
    expect(state.sinceId).toBe("22"); expect(state.outbox).toHaveLength(1);
    source.getPosts.mockResolvedValue({ posts: [], newestId: null });
    expect((await runMonitor(config, { source, targets: createTargets(config, fetcher, { pushplusRate: time }) })).outbox).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(21);
    expect(time.waits).toEqual([61_000, 61_000, 61_000, 61_000, 61_000]);
  });
});
