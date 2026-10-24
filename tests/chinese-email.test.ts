import { describe, expect, it } from "vitest";
import { renderChineseEmail, type ChineseEmailInput } from "../src/chinese-email";

const input: ChineseEmailInput = {
  username: "thsottiaux",
  postUrl: "https://x.com/thsottiaux/status/123456",
  publishedAt: "2026-10-24T00:00:00Z",
  translatedText: "今天发布了更新。",
  originalText: "We shipped an update today.",
  mediaUrls: ["https://pbs.twimg.com/media/example.jpg"],
};

describe("Chinese post email", () => {
  it("includes translation, original text, and the source link in both formats", () => {
    const mail = renderChineseEmail(input);
    expect(mail.subject).toContain("中文");
    expect(mail.subject).toContain("@thsottiaux");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain(input.translatedText);
      expect(body).toContain(input.originalText);
      expect(body).toContain(input.postUrl);
    }
    expect(mail.text).toContain("机器翻译");
  });
  it("renders the published time in Beijing time", () => {
    const mail = renderChineseEmail(input);
    expect(mail.text).toMatch(/2026.*10.*24/);
    expect(mail.text).toContain("08:00");
    expect(mail.text).toMatch(/北京|上海|GMT\+8|UTC\+8/);
  });
  it("escapes HTML in original and translated public content", () => {
    const mail = renderChineseEmail({ ...input, originalText: '<script>alert("x")</script>', translatedText: '<b onclick="x">中文 & 内容</b>' });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain('<b onclick="x">');
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("&amp;");
    expect(mail.text).toContain('<script>alert("x")</script>');
  });
  it("filters unsafe media URLs and keeps HTTPS image references", () => {
    const mail = renderChineseEmail({ ...input, mediaUrls: ["javascript:alert(1)", "http://unsafe.test/x", 'https://safe.test/a?x="onerror=bad'] });
    expect(mail.html).not.toContain("javascript:");
    expect(mail.html).not.toContain("http://unsafe.test");
    expect(mail.html).toContain("https://safe.test");
    expect(mail.html).not.toContain('x="onerror=bad');
  });
  it("does not create a clickable unsafe original URL", () => {
    const mail = renderChineseEmail({ ...input, postUrl: 'javascript:alert("x")' });
    expect(mail.html).not.toContain('href="javascript:');
  });
  it("handles unknown dates and missing media", () => {
    const mail = renderChineseEmail({ ...input, publishedAt: null, mediaUrls: undefined });
    expect(mail.text).toMatch(/未知|未提供|未确定/);
    expect(mail.html).not.toContain("Invalid Date");
    expect(mail.html).not.toContain("undefined");
  });
  it("prevents line breaks in the subject", () => {
    const mail = renderChineseEmail({ ...input, username: "thsottiaux\r\nBcc: victim" });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
