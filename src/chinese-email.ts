export interface ChineseEmailInput {
  username: string;
  postUrl: string;
  publishedAt: string | null;
  translatedText: string;
  originalText: string;
  mediaUrls?: string[];
}

export interface ChineseEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUsername(username: string): string {
  return username.replace(/[\r\n]+/g, " ").trim();
}

function isSafeHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function formatBeijingTime(publishedAt: string | null): string {
  if (publishedAt === null) return "发布时间未知";
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${parts}（北京时间）`;
}

export function renderChineseEmail(input: ChineseEmailInput): ChineseEmail {
  const username = sanitizeUsername(input.username);
  const subject = `@${username} 发布了新帖（中文）`.replace(/[\r\n]+/g, " ").trim();

  const beijingTime = formatBeijingTime(input.publishedAt);
  const hasValidPostUrl = isSafeHttpsUrl(input.postUrl);
  const safeMediaUrls = (input.mediaUrls ?? []).filter(isSafeHttpsUrl);

  const linkLineText = `原文链接：${input.postUrl}`;
  const timeLineText = `发布时间：${beijingTime}`;
  const translationHeader = "中文翻译（机器翻译）";
  const originalHeader = "英文原文";

  const text = [
    `@${username} 发布了新帖`,
    "",
    translationHeader,
    input.translatedText,
    "",
    originalHeader,
    input.originalText,
    "",
    linkLineText,
    timeLineText,
  ].join("\n");

  const mediaHtml = safeMediaUrls.length
    ? safeMediaUrls
        .map(
          (url) =>
            `<img src="${escapeHtml(url)}" alt="media" style="max-width:100%;border-radius:8px;margin:8px 0;" />`
        )
        .join("")
    : "";

  const linkHtml = hasValidPostUrl
    ? `<a href="${escapeHtml(input.postUrl)}">查看原帖</a>（<span>${escapeHtml(input.postUrl)}</span>）`
    : `<span>${escapeHtml(input.postUrl)}</span>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1a1a1a;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
<h2 style="margin:0 0 16px;">@${escapeHtml(username)} 发布了新帖</h2>
<h3 style="margin:16px 0 8px;">${escapeHtml(translationHeader)}</h3>
<p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(input.translatedText)}</p>
<h3 style="margin:16px 0 8px;">${escapeHtml(originalHeader)}</h3>
<p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(input.originalText)}</p>
${mediaHtml}
<p style="margin:16px 0 4px;">${linkHtml}</p>
<p style="margin:4px 0;color:#666;">发布时间：${escapeHtml(beijingTime)}</p>
</div>
</body>
</html>`;

  return { subject, html, text };
}
