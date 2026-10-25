import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../src/config";
import { createTargets } from "../src/notifications";
import { runMonitor } from "../src/monitor";
import { emptyState, writeState } from "../src/state";

const token = "test-only-private-pushplus-token";
const post = { id: "2", text: "A new update.", createdAt: "2026-10-25T00:00:00Z", url: "https://x.com/thsottiaux/status/2", media: [] };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const config = () => loadConfig({ PUSHPLUS_TOKEN: token, TRANSLATE_ZH: "true", NOTIFY_ALL_POSTS: "true", SMTP_HOST: "smtp.gmail.com", SMTP_USER: "sender@example.test", SMTP_PASSWORD: "fake-app-password", EMAIL_TO: "recipient@example.test" });
async function seededConfig() {
  const dir = await mkdtemp(join(tmpdir(), "tibo-wechat-")); dirs.push(dir);
  const result = { ...config(), statePath: join(dir, "state.json") };
  await writeState(result.statePath, { ...emptyState(result.username, result.keyword), sinceId: "1" });
  return result;
}

describe("WeChat and email delivery", () => {
  it("keeps email accepted while retrying a rejected WeChat request after restart", async () => {
    const cfg = await seededConfig();
    const source = { resolveUserId: vi.fn().mockResolvedValue("42"), getPosts: vi.fn().mockResolvedValue({ posts: [post], newestId: post.id }) };
    const sendSmtp = vi.fn().mockResolvedValue(undefined);
    let rejectPush = true;
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com")
      ? Response.json([[["发布了新动态。"]]])
      : Response.json(rejectPush ? { code: 905, msg: token } : { code: 200, data: "receipt-id" }));
    await expect(runMonitor(cfg, { source, targets: createTargets(cfg, fetcher, { sendSmtp }) })).rejects.toThrow("pushplus delivery failed; will retry");
    const saved = JSON.parse(await readFile(cfg.statePath, "utf8"));
    expect(saved.sinceId).toBe("2"); expect(saved.outbox).toHaveLength(1);
    expect(saved.outbox[0].delivered).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(sendSmtp).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("translate.googleapis.com"))).toHaveLength(1);
    const pushBody = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("pushplus.plus"))![1]?.body));
    expect(pushBody.content).toContain("发布了新动态。"); expect(pushBody.content).toContain(post.text);
    expect(pushBody.content).toContain(post.url); expect(pushBody.content).toContain("北京时间");
    rejectPush = false;
    source.getPosts.mockResolvedValue({ posts: [], newestId: null });
    const state = await runMonitor(cfg, { source, targets: createTargets(cfg, fetcher, { sendSmtp }) });
    expect(state.outbox).toEqual([]); expect(sendSmtp).toHaveBeenCalledTimes(1);
    await runMonitor(cfg, { source, targets: createTargets(cfg, fetcher, { sendSmtp }) });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("pushplus.plus"))).toHaveLength(2);
  });

  it("defers a burst above four attempts and delivers only the pending WeChat items next run", async () => {
    const cfg = await seededConfig();
    const posts = Array.from({ length: 6 }, (_, i) => ({ ...post, id: String(i + 2), url: `https://x.com/thsottiaux/status/${i + 2}` }));
    const source = { resolveUserId: vi.fn().mockResolvedValue("42"), getPosts: vi.fn().mockResolvedValue({ posts, newestId: "7" }) };
    const sendSmtp = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com") ? Response.json([[["新动态。"]]]) : Response.json({ code: 200, data: "receipt" }));
    await expect(runMonitor(cfg, { source, targets: createTargets(cfg, fetcher, { sendSmtp }) })).rejects.toThrow("will retry");
    expect(sendSmtp).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("pushplus.plus"))).toHaveLength(4);
    source.getPosts.mockResolvedValue({ posts: [], newestId: null });
    const state = await runMonitor(cfg, { source, targets: createTargets(cfg, fetcher, { sendSmtp }) });
    expect(state.outbox).toEqual([]); expect(sendSmtp).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("pushplus.plus"))).toHaveLength(6);
  });

  it("supports WeChat alone, trims the token, and disables the channel when no token exists", () => {
    const cfg = loadConfig({ PUSHPLUS_TOKEN: ` ${token} ` });
    expect(cfg.pushplusToken).toBe(token); expect(validateConfig(cfg)).toEqual([]);
    expect(createTargets(cfg).map((target) => target.channel)).toEqual(["pushplus"]);
    expect(createTargets(loadConfig({}))).toEqual([]);
  });

  it("marks a manual test and safely fits oversized text with the original link", async () => {
    const cfg = loadConfig({ PUSHPLUS_TOKEN: token, TRANSLATE_ZH: "true" });
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com") ? Response.json([[["<&🙂".repeat(4000)]]]) : Response.json({ code: 200, data: "receipt" }));
    const target = createTargets(cfg, fetcher)[0];
    await target.send({ key: "test-pushplus:123", post, events: [], targets: [target.id], delivered: [] });
    const body = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("pushplus.plus"))![1]?.body));
    expect(body.title).toContain("【部署测试】");
    expect(body.content.length).toBeLessThan(20_000); expect(body.content).toContain("节选");
    expect(body.content).toContain(post.url); expect(body.content).toContain("&lt;&amp;");
  });
});
