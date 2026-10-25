import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FxEmbedClient } from "../src/fxembed-client";
import { XClient } from "../src/x-client";
import { renderChineseEmail } from "../src/chinese-email";
import { loadConfig, validateConfig } from "../src/config";
import { createTargets } from "../src/notifications";
import { postVersion, runMonitor } from "../src/monitor";
import { emptyState, readState, writeState } from "../src/state";
import type { XPost } from "../src/types";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const post: XPost = { id: "10", text: "A reply without a leading mention.", createdAt: "2026-10-24T16:00:01Z", url: "https://x.com/thsottiaux/status/10", media: [], postType: "reply", replyToUsername: "mitsuhiko", replyToPostId: "8" };
const rawPost = (id: string, extra: Record<string, unknown> = {}) => ({ type: "status", id, text: "Plain text", created_timestamp: 1792857601, author: { id: "42", screen_name: "thsottiaux" }, media: {}, ...extra });
const page = (posts: unknown[]) => Response.json({ code: 200, results: posts, cursor: { top: null, bottom: null } });
const mailInput = { username: "thsottiaux", postUrl: post.url, publishedAt: post.createdAt, notifiedAt: "2026-10-24T16:05:07Z", originalText: post.text, translatedText: "这是一条回复。", postType: post.postType, replyToUsername: post.replyToUsername, replyToPostId: post.replyToPostId };
const cfg = () => loadConfig({ EMAIL_ENABLED: "false", PUSHPLUS_TOKEN: "fake-test-token", NOTIFY_ALL_POSTS: "true", TRANSLATE_ZH: "true", SMTP_HOST: "smtp.gmail.com", SMTP_USER: "sender@example.test", SMTP_PASSWORD: "fake-password", EMAIL_TO: "recipient@example.test" });
async function seededConfig() {
  const dir = await mkdtemp(join(tmpdir(), "tibo-details-")); dirs.push(dir);
  const config = { ...cfg(), statePath: join(dir, "state.json") };
  await writeState(config.statePath, { ...emptyState(config.username, config.keyword), sinceId: "9", userId: "42" });
  return config;
}

describe("source-backed post classification", () => {
  it("uses the FxEmbed reply relationship rather than a leading @ in the text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page([
      rawPost("11", { text: "@someone This is an original announcement.", replying_to: null }),
      rawPost("12", { text: "Plain reply without a mention.", replying_to: { screen_name: "mitsuhiko", status: "8" } }),
      rawPost("13", { text: "@someone Missing source relationship." }),
      rawPost("14", { text: "Invalid relationship metadata.", replying_to: false }),
    ]));
    const result = await new FxEmbedClient(fetcher).getPosts({ userId: "42", username: "thsottiaux", sinceId: "10" });
    expect(result.posts.map((p) => p.postType)).toEqual(["original", "reply", "unknown", "unknown"]);
    expect(result.posts[1]).toMatchObject({ replyToUsername: "mitsuhiko", replyToPostId: "8" });
  });

  it("requests official X reply references and treats a quote as an original post", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
      { id: "11", text: "@someone Original with quote", referenced_tweets: [{ type: "quoted", id: "5" }] },
      { id: "12", text: "Plain reply", referenced_tweets: [{ type: "replied_to", id: "8" }] },
    ] }));
    const result = await new XClient("fake-token", fetcher).getPosts({ userId: "42", username: "thsottiaux" });
    expect(result.posts[0].postType).toBe("original");
    expect(result.posts[1]).toMatchObject({ postType: "reply", replyToPostId: "8" });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("tweet.fields")).toContain("referenced_tweets");
  });

  it("enriches the latest saved post at the cursor without notifying historical posts", async () => {
    const config = await seededConfig();
    const state = await readState(config.statePath, config.username, config.keyword);
    state.sinceId = "10"; state.latestObservedPost = { ...post, postType: undefined, replyToUsername: undefined, replyToPostId: undefined };
    await writeState(config.statePath, state);
    const source = new FxEmbedClient(vi.fn<typeof fetch>().mockResolvedValue(page([rawPost("10", { replying_to: { screen_name: "mitsuhiko", status: "8" } })])));
    const send = vi.fn();
    await runMonitor(config, { source, targets: [{ id: "pushplus:test", channel: "pushplus", send }] });
    const saved = await readState(config.statePath, config.username, config.keyword);
    expect(saved.latestObservedPost).toMatchObject({ postType: "reply", replyToUsername: "mitsuhiko", replyToPostId: "8" });
    expect(saved.outbox).toEqual([]); expect(send).not.toHaveBeenCalled();
  });

  it("preserves the delivery version when only relationship metadata is added", () => {
    expect(postVersion(post)).toBe(postVersion({ ...post, postType: undefined, replyToUsername: undefined, replyToPostId: undefined }));
  });
});

describe("clear Chinese type and time labels", () => {
  it("shows the reply target, Beijing dates across midnight, seconds and elapsed time", () => {
    const rendered = renderChineseEmail(mailInput);
    expect(rendered.subject).toContain("【回复】"); expect(rendered.subject).toContain("10-25 00:00");
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain("动态类型：回复"); expect(body).toContain("回复对象：@mitsuhiko");
      expect(body).toContain("https://x.com/mitsuhiko/status/8");
      expect(body).toContain("发帖时间：2026-10-25 00:00:01（北京时间）");
      expect(body).toContain("推送时间：2026-10-25 00:05:07（北京时间）");
      expect(body).toContain("发帖至推送：5分6秒");
    }
  });

  it("labels originals and legacy unknowns without guessing from the content", () => {
    expect(renderChineseEmail({ ...mailInput, postType: "original", originalText: "@someone New release" }).subject).toContain("【原创帖】");
    const legacy = renderChineseEmail({ ...mailInput, postType: undefined, publishedAt: null, notifiedAt: "bad-date" });
    expect(legacy.subject).toContain("【类型待确认】");
    expect(legacy.text).toContain("发帖时间：未知"); expect(legacy.text).toContain("推送时间：未知");
    expect(legacy.html).not.toContain("Invalid Date"); expect(legacy.html).not.toContain("NaN");
    expect(renderChineseEmail({ ...mailInput, notifiedAt: "2026-10-24T15:00:00Z" }).text).toContain("源时间晚于推送时间");
  });

  it("never converts untrusted reply context into a clickable URL", () => {
    const rendered = renderChineseEmail({ ...mailInput, replyToUsername: '<script>alert(1)</script>', replyToPostId: '8" onclick="bad' });
    expect(rendered.html).not.toContain("<script>"); expect(rendered.html).not.toContain('onclick="bad');
    expect(rendered.text).toContain("回复对象：来源未提供");
  });
});

describe("WeChat only and retired mail deliveries", () => {
  it("ignores residual SMTP settings when email is explicitly disabled and sends only WeChat", async () => {
    const config = await seededConfig();
    expect(validateConfig({ ...config, smtpPassword: undefined, smtpPort: NaN })).toEqual([]);
    const sendSmtp = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com") ? Response.json([[["这是一条回复。"]]]) : Response.json({ code: 200, data: "receipt" }));
    const targets = createTargets(config, fetcher, { sendSmtp, now: () => new Date(mailInput.notifiedAt) });
    expect(targets.map((target) => target.channel)).toEqual(["pushplus"]);
    await runMonitor(config, { source: { resolveUserId: vi.fn(), getPosts: vi.fn().mockResolvedValue({ posts: [post], newestId: post.id }) }, targets });
    expect(sendSmtp).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("pushplus.plus"))![1]?.body));
    expect(body.title).toContain("【回复】"); expect(body.content).toContain("推送时间：2026-10-25 00:05:07");
  });

  it("cancels pending email without discarding a failed WeChat item or sending mail on retry", async () => {
    const config = await seededConfig();
    let accepted = false;
    const sendSmtp = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("translate.googleapis.com") ? Response.json([[["中文回复。"]]]) : Response.json(accepted ? { code: 200, data: "receipt" } : { code: 429 }));
    const targets = createTargets(config, fetcher, { sendSmtp });
    const emailId = createTargets({ ...config, emailEnabled: true }, fetcher, { sendSmtp }).find((target) => target.channel === "email")!.id;
    const state = await readState(config.statePath, config.username, config.keyword);
    state.outbox = [
      { key: "old-both", post, events: [], targets: [emailId, targets[0].id], delivered: [] },
      { key: "old-mail-only", post, events: [], targets: [emailId], delivered: [] },
    ];
    await writeState(config.statePath, state);
    const source = { resolveUserId: vi.fn(), getPosts: vi.fn().mockResolvedValue({ posts: [], newestId: null }) };
    await expect(runMonitor(config, { source, targets })).rejects.toThrow("pushplus delivery failed; will retry");
    const saved = await readState(config.statePath, config.username, config.keyword);
    expect(saved.outbox).toHaveLength(1); expect(saved.outbox![0].key).toBe("old-both");
    expect(saved.outbox![0].targets).toEqual([targets[0].id]);
    accepted = true;
    expect((await runMonitor(config, { source, targets: createTargets(config, fetcher, { sendSmtp }) })).outbox).toEqual([]);
    expect(sendSmtp).not.toHaveBeenCalled();
    expect(validateConfig(loadConfig({ EMAIL_ENABLED: "false", EMAIL_TO: "old@example.test" }))).toContain("Configure at least one notification channel (GitHub Actions summary, email, PushPlus, SMS, Telegram, Discord, or webhook).");
  });
});
