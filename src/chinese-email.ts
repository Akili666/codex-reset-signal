export interface ChineseEmailInput {
  username: string;
  postUrl: string;
  publishedAt: string | null;
  notifiedAt?: string | null;
  postType?: "original" | "reply" | "unknown";
  replyToUsername?: string | null;
  replyToPostId?: string | null;
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

function formatBeijingTime(value: string | null | undefined): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}（北京时间）`;
}

function notificationDelay(publishedAt: string | null, notifiedAt?: string | null): string {
  if (!publishedAt || !notifiedAt) return "未知";
  const elapsed = Date.parse(notifiedAt) - Date.parse(publishedAt);
  if (!Number.isFinite(elapsed)) return "未知";
  if (elapsed < 0) return "源时间晚于推送时间，无法计算";
  let seconds = Math.floor(elapsed / 1000);
  const result: string[] = [];
  for (const [unit, size] of [["天", 86400], ["小时", 3600], ["分", 60]] as const) {
    const amount = Math.floor(seconds / size);
    if (amount) result.push(`${amount}${unit}`);
    seconds %= size;
  }
  if (seconds || !result.length) result.push(`${seconds}秒`);
  return result.join("");
}

export function renderChineseEmail(input: ChineseEmailInput): ChineseEmail {
  const username = sanitizeUsername(input.username);
  const beijingTime = formatBeijingTime(input.publishedAt);
  const notificationTime = formatBeijingTime(input.notifiedAt);
  const kind = input.postType === "original" ? "原创帖" : input.postType === "reply" ? "回复" : "类型待确认";
  const shortTime = beijingTime === "未知" ? "时间未知" : beijingTime.slice(5, 16);
  const subject = `【${kind}】@${username} · ${shortTime}（中文）`.replace(/[\r\n]+/g, " ").trim();
  const heading = `@${username} · ${kind}`;
  const replyUsername = input.postType === "reply" && input.replyToUsername && /^[A-Za-z0-9_]{1,15}$/.test(input.replyToUsername) ? input.replyToUsername : null;
  const replyUrl = input.postType === "reply" && input.replyToPostId && /^\d+$/.test(input.replyToPostId)
    ? `https://x.com/${replyUsername ?? "i"}/status/${input.replyToPostId}` : null;
  const replyLine = input.postType === "reply" ? `回复对象：${replyUsername ? `@${replyUsername}` : "来源未提供"}` : null;
  const hasValidPostUrl = isSafeHttpsUrl(input.postUrl);
  const safeMediaUrls = (input.mediaUrls ?? []).filter(isSafeHttpsUrl);

  const linkLineText = `原文链接：${input.postUrl}`;
  const timeLines = [
    `发帖时间：${beijingTime}`,
    `推送时间：${notificationTime}`,
    `发帖至推送：${notificationDelay(input.publishedAt, input.notifiedAt)}`,
  ];
  const translationHeader = "中文翻译（机器翻译）";
  const originalHeader = "英文原文";

  const text = [
    heading,
    `动态类型：${kind}`,
    ...(replyLine ? [replyLine] : []),
    ...(replyUrl ? [`回复原帖：${replyUrl}`] : []),
    ...timeLines,
    "",
    translationHeader,
    input.translatedText,
    "",
    originalHeader,
    input.originalText,
    "",
    linkLineText,
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
<h2 style="margin:0 0 16px;">${escapeHtml(heading)}</h2>
<div style="background:#f1f5f9;border-radius:8px;padding:12px;font-size:14px;line-height:1.7;">
<strong>动态类型：${escapeHtml(kind)}</strong>
${replyLine ? `<div>${escapeHtml(replyLine)}</div>` : ""}
${replyUrl ? `<div><a href="${escapeHtml(replyUrl)}">查看被回复的原帖</a></div>` : ""}
${timeLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
</div>
<h3 style="margin:16px 0 8px;">${escapeHtml(translationHeader)}</h3>
<p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(input.translatedText)}</p>
<h3 style="margin:16px 0 8px;">${escapeHtml(originalHeader)}</h3>
<p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(input.originalText)}</p>
${mediaHtml}
<p style="margin:16px 0 4px;">${linkHtml}</p>
</div>
</body>
</html>`;

  return { subject, html, text };
}
