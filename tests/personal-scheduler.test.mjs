import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../workers/scheduler/index.mjs";

const configuration = JSON.parse(readFileSync(new URL("../workers/personal-scheduler/wrangler.jsonc", import.meta.url), "utf8"));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cron = { cron: configuration.triggers.crons[0], scheduledTime: Date.parse("2026-10-25T07:02:00Z") };

describe("personal Cloudflare scheduler", () => {
  it("dispatches the user's existing workflow without a public HTTP endpoint or notification secrets", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(cron, { ...configuration.vars, GITHUB_TOKEN: "fake-test-only-token" });
    expect(configuration.workers_dev).toBe(false);
    expect(configuration.vars.GITHUB_REPOSITORY).toBe("Akili666/codex-reset-signal");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/Akili666/codex-reset-signal/actions/workflows/monitor.yml/dispatches");
    expect(JSON.parse(request.body)).toEqual({ ref: "main" });
    expect(request.headers.Authorization).toBe("Bearer fake-test-only-token");
    expect(request.signal).toBeInstanceOf(AbortSignal); expect(request.redirect).toBe("manual");
    expect(JSON.stringify(log.mock.calls)).not.toContain("fake-test-only-token");
    expect(worker.fetch).toBeUndefined();
  });

  it("rejects missing credentials and an invalid repository before making any API request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(worker.scheduled(cron, configuration.vars)).rejects.toThrow("GITHUB_TOKEN secret is required");
    await expect(worker.scheduled(cron, { GITHUB_TOKEN: "fake-token", GITHUB_REPOSITORY: "../../someone" })).rejects.toThrow("owner/repo");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports denied GitHub access without leaking the token or response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("fake-private-response", { status: 401 })));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled(cron, { ...configuration.vars, GITHUB_TOKEN: "fake-secret" })).rejects.toThrow("HTTP 401");
    expect(JSON.stringify(error.mock.calls)).not.toContain("fake-secret");
    expect(JSON.stringify(error.mock.calls)).not.toContain("fake-private-response");
  });

  it("sanitizes token-bearing network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fake-private-token-in-network-error")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(worker.scheduled(cron, { ...configuration.vars, GITHUB_TOKEN: "fake-token" })).rejects.toThrow(/^GitHub workflow dispatch request failed or timed out$/);
  });

  it("rejects a redirect without following its destination or logging its body", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("fake-private-redirect-body", {
      status: 302,
      headers: { Location: "https://untrusted.example/collect" },
    }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled(cron, { ...configuration.vars, GITHUB_TOKEN: "fake-secret" })).rejects.toThrow("HTTP 302");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
    expect(JSON.stringify(error.mock.calls)).not.toContain("fake-secret");
    expect(JSON.stringify(error.mock.calls)).not.toContain("fake-private-redirect-body");
    expect(JSON.stringify(error.mock.calls)).not.toContain("untrusted.example");
  });
});
