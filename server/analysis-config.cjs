"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROMPT = `# Role
你是“群像人物连续性档案员”。事件记忆由 Anima 负责；你只维护：
1. 角色成长里程碑：少而关键、追加保存。
2. 当前人物画像：整张重写为此刻最新版本。
3. 有向关系边：A 对 B 与 B 对 A 必须分别判断。

# 强制人物审计
- 阅读 <text_to_analyze> 中的全部楼层，不得只处理最后一条消息。
- 所有具名人物，以及 <priority_characters> 中的每个姓名，都必须出现在 character_audit。
- 对每人选择 update、no_update 或 review；不得因戏份少、没有发言或只在幕后行动而漏掉。
- 只有正文中存在可引用证据才允许 update；拿不准时用 review。
- 没有长期变化时写 no_update，不得为了凑数制造成长。

# 成长里程碑
- 只记录跨场景仍有意义的变化：主体性、信任、亲密、责任、权力观、道德判断、身份认同、应对方式、长期目标、边界。
- 一次短暂情绪、衣着、站位、普通动作和事件流水账不是成长。
- milestone_candidates 每条必须包含 title、dimension、stage、narrative、change_trace、evidence、time、location、related_characters、source、confidence、importance。
- narrative 写成细腻但克制的成长记录，可保留 1–3 句关键原话或动作。
- change_trace 使用“旧模式 → 触发/选择 → 新表现”的简短形式，但不要把人物压扁成机械三段论。
- stage 只能为 emerging、deepening、wavering、breakthrough、regression、confirmed。

# 当前画像
- 只有 decision=update 才提供 proposed_profile。
- proposed_profile 是更新后的完整画像，不是补丁：
  current_profile.personality
  current_profile.behavior_pattern
  current_profile.core_need
  current_profile.current_stage
  growth_synopsis
  residual_patterns
- growth_synopsis 上限约 1200 个汉字：按时间和因果串联重要成长，保留关键选择、代价、矛盾和未完全消失的旧模式。
- residual_patterns 写清触发条件、可能反应、制衡因素、证据。
- 人物关系不要塞进画像；关系统一写入 relation_changes。
- <locked_profile_fields> 中的字段不得改写。

# 有向关系图谱
- relation_changes 只记录本批新增或发生实质变化的关系。
- from 对 to 的态度、互动模式、可见性和强度独立判断。
- decision 只能为 create、update、no_update、review、deactivate_candidate。
- 传闻、误解、暧昧线索或模型推断默认 review，不直接落库。
- visibility 只能为 public、known_to_from、private、author_only；strength 为 0 到 1。
- 不生成无证据的对称关系，不把“同场出现”当成关系变化。

# 事实与证据
- 只使用 <text_to_analyze> 的事实，结合现有画像和关系判断增量。
- 严格区分读者知道、角色知道和角色误以为知道。
- 每项证据使用具体动作或短台词；不得写 USER、ASSISTANT、男主等占位词。
- source.start_floor/end_floor 必须使用 <batch_source> 提供的范围。

# Output
只输出合法 JSON，不要 Markdown，不要解释：
{
  "character_audit":[
    {"character":"姓名","decision":"update","reason":"理由","evidence":["证据"]}
  ],
  "profile_updates":[
    {
      "character":"姓名","decision":"update","reason":"更新理由",
      "milestone_candidates":[{
        "character":"姓名","title":"里程碑标题","dimension":"agency","stage":"emerging",
        "narrative":"细腻的成长记录","change_trace":"旧模式 → 触发/选择 → 新表现",
        "evidence":["动作或短台词"],"time":"YYYY-MM-DD HH:mm 或 时间未注明",
        "location":"具体地点或 地点未注明","related_characters":["具名人物"],
        "source":{"start_floor":0,"end_floor":9},"confidence":"observed","importance":"major"
      }],
      "proposed_profile":{
        "current_profile":{"personality":"当前性格","behavior_pattern":"当前行动方式","core_need":"核心需求","current_stage":"当前阶段"},
        "growth_synopsis":"连贯成长历史",
        "residual_patterns":[{"trigger":"触发条件","likely_response":"可能反应","counterweight":"制衡因素","evidence":["证据"]}]
      },
      "evidence":["本次更新证据"],"confidence":"observed"
    }
  ],
  "relation_changes":[{
    "decision":"update","from":"角色A","to":"角色B","primary_type":"关系主类型",
    "tags":["信任"],"attitude":"A 对 B 的态度","interaction_pattern":"稳定互动方式",
    "visibility":"private","strength":0.7,"direction":"improving",
    "reason":"变化原因","evidence":["证据"],"confidence":"observed"
  }],
  "warnings":[]
}`;

const DEFAULT_CONFIG = Object.freeze({
  provider: "openai",
  baseUrl: "",
  apiKey: "",
  model: "",
  thinkingMode: "fast",
  temperature: 0.2,
  maxTokens: 16384,
  timeoutMs: 600000,
  prompt: DEFAULT_PROMPT,
});

function normalizeConfig(input = {}) {
  const provider = input.provider === "gemini" ? "gemini" : "openai";
  return {
    provider,
    baseUrl: String(input.baseUrl ?? "").trim().slice(0, 2000),
    apiKey: String(input.apiKey ?? "").trim().slice(0, 10000),
    model: String(input.model ?? "").trim().slice(0, 500),
    thinkingMode: ["fast", "balanced", "deep"].includes(input.thinkingMode)
      ? input.thinkingMode
      : "fast",
    temperature: Math.max(0, Math.min(2, Number(input.temperature ?? 0.2))),
    maxTokens: Math.max(1024, Math.min(65536, Number(input.maxTokens ?? 16384))),
    timeoutMs: Math.max(60000, Math.min(900000, Number(input.timeoutMs ?? 600000))),
    prompt: String(input.prompt ?? DEFAULT_PROMPT).slice(0, 200000) || DEFAULT_PROMPT,
  };
}

class AnalysisConfigStore {
  constructor(root) {
    this.path = path.join(root, "analysis-config.json");
    this.queue = Promise.resolve();
  }

  async read() {
    if (!fs.existsSync(this.path)) return normalizeConfig(DEFAULT_CONFIG);
    return normalizeConfig(JSON.parse(await fs.promises.readFile(this.path, "utf8")));
  }

  async save(input) {
    const current = await this.read();
    const merged = normalizeConfig({
      ...current,
      ...input,
      apiKey: String(input?.apiKey ?? "").trim() || current.apiKey,
    });
    this.queue = this.queue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp-${process.pid}`;
      await fs.promises.writeFile(temporary, JSON.stringify(merged, null, 2), "utf8");
      await fs.promises.rename(temporary, this.path);
    });
    await this.queue;
    return merged;
  }
}

function publicConfig(config) {
  return {
    ...config,
    apiKey: "",
    hasApiKey: Boolean(config.apiKey),
  };
}

module.exports = {
  AnalysisConfigStore,
  DEFAULT_CONFIG,
  DEFAULT_PROMPT,
  normalizeConfig,
  publicConfig,
};
