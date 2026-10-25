# 个人微信通知的独立定时触发

状态：Cloudflare Worker 与五分钟 Cron 已部署，GitHub 授权已保存为加密 Secret。原生 GitHub 定时器保留作备用。

自动运行实测：2026-10-25 北京时间15:57，Cloudflare Cron 自动创建 [GitHub 监控运行 40174717164](https://github.com/Akili666/codex-reset-signal/actions/runs/40174717164)，监控和状态持久化均成功。15:55的手动验收另有记录，不计入自动触发证据。

2026-10-25 排查发现：GitHub 自动运行停在北京时间11:28，14:51检查时没有后续运行；数据源已出现7条游标之后的新动态。7条已补发，用户确认微信全部收到。原有每次运行最多发送4条的限制已改为滚动61秒内最多4次请求，单次运行最多20次；待发消息和限流时间戳均持久化，不会因一次触发结束而丢弃。

本配置使用现有 `../scheduler/index.mjs`，由 Cloudflare Cron 每五分钟调用本人仓库 `Akili666/codex-reset-signal` 的 `monitor.yml`，抓取、翻译、微信通知和状态仍由现有 GitHub Actions 完成。无公开 HTTP 入口，不需要把 PushPlus 令牌交给定时器。外部触发减少对 GitHub 原生 schedule 事件的依赖，GitHub 运行器仍可能排队。

启用步骤（需账号本人完成授权）：

1. 登录 Cloudflare 账号。
2. 在 GitHub 创建仅授权 `Akili666/codex-reset-signal`、具有 Actions 读写权限的细粒度令牌；令牌只用于触发此仓库工作流，直接填入 Cloudflare Secret `GITHUB_TOKEN`，不要发送到聊天或提交到源码。
3. 在项目根执行 `npx wrangler@4 deploy --config workers/personal-scheduler/wrangler.jsonc`，并通过 `npx wrangler@4 secret put GITHUB_TOKEN --config workers/personal-scheduler/wrangler.jsonc` 直接输入令牌。
4. 验证 Cloudflare 定时事件和新产生的 GitHub `workflow_dispatch` 运行记录，连续核对多个五分钟周期后才报告定时器已运行。最初的 Cron 配置同步可能需要等待。

本配置与原生 GitHub 计划共用工作流并发锁和持久化去重游标；偶尔重叠触发不会主动补发已完成的消息。邮件继续关闭。

维护要点：

- 当前 GitHub 细粒度令牌于 **2027-01-23** 到期，需在到期前由账号本人更新 Cloudflare 的 `GITHUB_TOKEN` Secret。
- 已开启 Workers 日志，便于查看 `cron_started` 和 `github_workflow_dispatch_succeeded` / `github_workflow_dispatch_failed`；日志不包含令牌或 GitHub 响应正文。
- Workers 的 `fetch` 不支持 `redirect: "error"`，会在请求发出前抛错。调度器使用 `redirect: "manual"`，并将所有非成功状态（包括跳转）视为失败，避免把授权头带到跳转目标。参见 [Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。
- `workers_dev` 和 `preview_urls` 均关闭，调度器只接收 Cron 事件。
