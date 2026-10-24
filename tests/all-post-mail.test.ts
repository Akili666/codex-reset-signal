import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validateConfig } from "../src/config";
import { createTargets } from "../src/notifications";
import { runMonitor } from "../src/monitor";
import { emptyState, writeState } from "../src/state";
import { translateToChinese } from "../src/translate";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const plainPost = { id: "2", text: "We shipped a new feature today.", createdAt: "2026-10-24T00:00:00Z", url: "https://x.com/thsottiaux/status/2", media: [] };
const smtpConfig = () => loadConfig({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "sender@example.test", SMTP_PASSWORD: "test-app-password", EMAIL_TO: "receiver@example.test", NOTIFY_ALL_POSTS: "true", TRANSLATE_ZH: "true" });
async function seededConfig() {
  const dir = await mkdtemp(join(tmpdir(), "tibo-mail-")); dirs.push(dir);
  const config = { ...smtpConfig(), statePath: join(dir, "state.json") };
  await writeState(config.statePath, { ...emptyState(config.username, config.keyword), sinceId: "1" });
  return config;
}

describe("all new Tibo posts", () => {
  it("notifies ordinary posts and replies, and deduplicates a repeated response", async () => {
    const config = await seededConfig();
    const source = { resolveUserId: vi.fn().mockResolvedValue("42"), getPosts: vi.fn().mockResolvedValue({ posts: [plainPost, { ...plainPost, id: "3", text: "@someone Yes, exactly.", url: "https://x.com/thsottiaux/status/3" }], newestId: "3" }) };
    const send = vi.fn().mockResolvedValue(undefined);
    const deps = { source, targets: [{ id: "email:test", channel: "email", send }] };
    await runMonitor(config, deps); await runMonitor(config, deps);
    expect(send).toHaveBeenCalledTimes(2);
    expect(source.getPosts.mock.calls[0][0].excludeReplies).toBe(false);
    expect(send.mock.calls[0][0].post.text).toBe(plainPost.text);
    expect(send.mock.calls[1][0].post.text).toContain("@someone");
  });
  it("does not mass-send historical posts on initial deployment", async () => {
    const config = await seededConfig();
    await writeState(config.statePath, emptyState(config.username, config.keyword));
    const source = { resolveUserId: vi.fn().mockResolvedValue("42"), getPosts: vi.fn().mockResolvedValue({ posts: [plainPost], newestId: "2" }) };
    const send = vi.fn();
    const state = await runMonitor(config, { source, targets: [{ id: "email:test", channel: "email", send }] });
    expect(send).not.toHaveBeenCalled(); expect(state.sinceId).toBe("2");
  });
  it("keeps a failed translation pending, retries after restart, and does not send twice", async () => {
    const config = await seededConfig();
    const source = { resolveUserId: vi.fn().mockResolvedValue("42"), getPosts: vi.fn().mockResolvedValue({ posts: [plainPost], newestId: "2" }) };
    const sendSmtp = vi.fn().mockResolvedValue(undefined);
    const first = createTargets(config, vi.fn().mockRejectedValue(new Error("private-provider-detail")), { sendSmtp });
    await expect(runMonitor(config, { source, targets: first })).rejects.toThrow("will retry");
    const saved = JSON.parse(await readFile(config.statePath, "utf8"));
    expect(saved.sinceId).toBe("2"); expect(saved.outbox).toHaveLength(1);
    expect(sendSmtp).not.toHaveBeenCalled();
    source.getPosts.mockResolvedValue({ posts: [], newestId: null });
    const next = createTargets(config, vi.fn().mockResolvedValue(Response.json([[["今天发布了新功能。"]]])), { sendSmtp });
    const state = await runMonitor(config, { source, targets: next });
    expect(state.outbox).toEqual([]); expect(sendSmtp).toHaveBeenCalledTimes(1);
    await runMonitor(config, { source, targets: next }); expect(sendSmtp).toHaveBeenCalledTimes(1);
    const mail = sendSmtp.mock.calls[0][0];
    expect(mail.text).toContain("今天发布了新功能。"); expect(mail.text).toContain(plainPost.text);
    expect(JSON.stringify(saved)).not.toContain(config.smtpPassword);
    expect(JSON.stringify(saved)).not.toContain(config.emailTo[0]);
  });
  it("requires the complete SMTP configuration", () => {
    expect(validateConfig(smtpConfig())).toEqual([]);
    expect(validateConfig({ ...smtpConfig(), smtpPassword: undefined })).not.toEqual([]);
    expect(validateConfig({ ...smtpConfig(), smtpPort: NaN })).not.toEqual([]);
  });
});

describe("Chinese translation", () => {
  it("uses Chinese output and does not send mail credentials to the translator", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([[["额度已重置。"]]]));
    expect(await translateToChinese("Limits were reset.", fetcher)).toBe("额度已重置。");
    const url = fetcher.mock.calls[0][0] as URL;
    expect(url.hostname).toBe("translate.googleapis.com"); expect(url.searchParams.get("tl")).toBe("zh-CN");
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  });
  it("keeps all content when a long post must be split, including emoji", async () => {
    const text = "A🙂".repeat(2000);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return Response.json([[[url.searchParams.get("q")]]]);
    });
    expect(await translateToChinese(text, fetcher)).toBe(text);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => Array.from(new URL(String(url)).searchParams.get("q")!).length)).toEqual([1400, 1400, 1200]);
  });
  it("fails visibly instead of silently passing English text through", async () => {
    await expect(translateToChinese("New feature.", vi.fn().mockResolvedValue(new Response("blocked", { status: 429 })))).rejects.toThrow("429");
    await expect(translateToChinese("New feature.", vi.fn().mockResolvedValue(Response.json({ unexpected: true })))).rejects.toThrow("invalid");
  });
  it("handles media-only messages without a translation request", async () => {
    const fetcher = vi.fn(); expect(await translateToChinese("", fetcher)).toContain("图片或视频"); expect(fetcher).not.toHaveBeenCalled();
  });
});
