/** Returns a queue receipt. PushPlus acceptance does not confirm phone delivery. */
export async function sendPushPlusMessage(
  token: string,
  message: { title: string; html: string },
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        title: Array.from(message.title.replace(/[\r\n]/g, " ")).slice(0, 100).join(""),
        content: message.html,
        template: "html",
        channel: "wechat",
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new Error("PushPlus request failed or timed out");
  }
  if (!response.ok) throw new Error(`PushPlus HTTP ${response.status}`);
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error("PushPlus returned an invalid response");
  }
  if (!result || typeof result !== "object")
    throw new Error("PushPlus returned an invalid response");
  const { code, data } = result as { code?: unknown; data?: unknown };
  if (typeof code !== "number" || !Number.isFinite(code))
    throw new Error("PushPlus returned an invalid response");
  if (code !== 200) throw new Error(`PushPlus rejected request (code ${code})`);
  if (typeof data !== "string" || !data.trim())
    throw new Error("PushPlus returned an invalid response");
  return data;
}
