import { loadConfig, validateConfig } from "./config";
import { createTargets } from "./notifications";
import { readState } from "./state";

const config = loadConfig();
const errors = validateConfig(config);
if (errors.length) throw new Error(errors.join("; "));
const state = await readState(config.statePath, config.username, config.keyword);
const post = state.latestObservedPost;
if (!post) throw new Error("No real Tibo post has been collected; collect before sending a test");
const targets = createTargets(config).filter((target) => target.channel === "pushplus");
if (!targets.length) throw new Error("PUSHPLUS_TOKEN is not configured");
for (const target of targets) {
  await target.send({
    key: `test-pushplus:${process.env.GITHUB_RUN_ID || Date.now()}:${post.id}`,
    post, events: [], targets: [target.id], delivered: [],
  });
}
console.log("Chinese test notification accepted by PushPlus; check delivery records and WeChat.");
