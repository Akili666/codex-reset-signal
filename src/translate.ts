/** Public post text only. No mailbox credentials or private email content. */
export async function translateToChinese(text: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!text.trim()) return "此条消息没有可翻译的文字，请查看原帖图片或视频。";
  if (!/[A-Za-z]/.test(text)) return text;
  const characters = Array.from(text);
  const translated: string[] = [];
  for (let start = 0; start < characters.length; start += 1400) {
    const chunk = characters.slice(start, start + 1400).join("");
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.search = new URLSearchParams({ client: "gtx", sl: "auto", tl: "zh-CN", dt: "t", q: chunk }).toString();
    let response: Response;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    } catch {
      throw new Error("Chinese translation request failed; notification remains pending");
    }
    if (!response.ok) throw new Error(`Chinese translation HTTP ${response.status}`);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error("Chinese translation returned invalid JSON"); }
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Chinese translation returned invalid content");
    const value = data[0].map((part: unknown) => Array.isArray(part) && typeof part[0] === "string" ? part[0] : "").join("");
    if (!value.trim()) throw new Error("Chinese translation is empty; notification remains pending");
    translated.push(value);
  }
  return translated.join("");
}
