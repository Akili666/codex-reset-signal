import { describe, expect, it, vi } from "vitest";
import { sendPushPlusMessage } from "../src/pushplus";

const token = "test-only-pushplus-secret";
const message = { title: "Tibo 中文动态", html: "<p>额度已重置。</p>" };

describe("PushPlus WeChat API", () => {
  it("uses HTTPS POST with a private body and explicitly selects personal WeChat", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: "receipt-123" }));
    expect(await sendPushPlusMessage(token, message, fetcher)).toBe("receipt-123");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://www.pushplus.plus/send");
    expect(String(url)).not.toContain(token);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ token, title: message.title, content: message.html, template: "html", channel: "wechat" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("limits the title to 100 Unicode characters and removes line breaks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: "receipt" }));
    await sendPushPlusMessage(token, { title: "中🙂\r\n".repeat(100), html: "原文" }, fetcher);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(Array.from(body.title).length).toBeLessThanOrEqual(100);
    expect(body.title).not.toMatch(/[\r\n]/);
    expect(body.title).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it.each([401, 429, 500])("rejects HTTP %s without echoing a secret response body", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(token, { status }));
    await expect(sendPushPlusMessage(token, message, fetcher)).rejects.toThrow(`PushPlus HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects vendor failures without echoing provider messages or credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 905, msg: token }));
    await expect(sendPushPlusMessage(token, message, fetcher)).rejects.toThrow("PushPlus rejected request (code 905)");
  });

  it.each([{}, { code: "200", data: "receipt" }, { code: 200 }, { code: 200, data: "" }, { code: 200, data: {} }])("requires a valid queue acknowledgement and receipt", async (payload) => {
    await expect(sendPushPlusMessage(token, message, vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)))).rejects.toThrow("PushPlus");
  });

  it("sanitizes network and malformed JSON failures", async () => {
    await expect(sendPushPlusMessage(token, message, vi.fn<typeof fetch>().mockRejectedValue(new Error(token)))).rejects.toThrow("PushPlus request failed or timed out");
    await expect(sendPushPlusMessage(token, message, vi.fn<typeof fetch>().mockResolvedValue(new Response(token)))).rejects.toThrow("PushPlus returned an invalid response");
  });
});
