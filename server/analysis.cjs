"use strict";

const { formatMessages } = require("./preprocess.cjs");
const { materializeProfiles, materializeRelationships } = require("./state.cjs");

const MAX_CONTEXT_LENGTH = 900_000;
const VALID_PROFILE_DECISIONS = new Set(["update", "no_update", "review"]);
const VALID_RELATION_DECISIONS = new Set([
  "create",
  "update",
  "no_update",
  "review",
  "deactivate_candidate",
]);
const VALID_STAGES = new Set([
  "emerging",
  "deepening",
  "wavering",
  "breakthrough",
  "regression",
  "confirmed",
]);
const VALID_RETENTION_TIERS = new Set(["core", "recurring", "watchlist", "ephemeral"]);
const VALID_IDENTITY_STATUSES = new Set(["named", "title_only", "relationship_only", "ambiguous"]);
const VALID_NARRATIVE_ROLES = new Set([
  "protagonist",
  "major_support",
  "antagonist",
  "recurring",
  "minor",
  "extra",
  "unknown",
]);
const PROFILE_GROUP_SIZE = 4;

const CENSUS_PROMPT = `你是群像叙事的“人物登记员”。你的唯一任务是完整点名本批文本中出现、
被明确提及、在幕后采取行动、通过消息/电话/命令影响剧情的所有人物。

必须识别：
- 有正式姓名的人物；
- 只有职称、亲属称谓或稳定身份的人物，例如“秘书长”“Fi的父亲”；
- 没有姓名但有独立意图、权力、秘密、关键行动或未解决剧情线的人物。

没有姓名时创建可长期沿用且避免混淆的稳定名称：
- 职称：组织或地点·职称，例如“兰芝高中·秘书长”；
- 亲属：核心人物·关系，例如“Fi·父亲”；
- 同类多人：场景·身份A/B，例如“西楼茶叙·女职员A”。
不得使用“某人”“路人”“NPC”等无法持续识别的名称。

分别判断：
- retention_tier：core（核心人物/永久亲属关系）、recurring（已有持续参与）、
  watchlist（有独立目的、关键权力、冲突或未解决线索）、ephemeral（纯工具人）；
- narrative_role：protagonist、major_support、antagonist、recurring、minor、extra、unknown；
- identity_status：named、title_only、relationship_only、ambiguous。

重要性不等于成长。不要在此阶段判断成长，也不要因为本轮没有成长而漏掉人物。
只输出合法 JSON：
{"characters":[{
  "character":"稳定姓名或代号",
  "aliases":["正文称谓"],
  "identity_status":"named",
  "identification_basis":"如何确定是此人",
  "retention_tier":"watchlist",
  "narrative_role":"antagonist",
  "reason":"为何保留或为何只是工具人",
  "evidence":["具体动作、短台词或出现位置"]
}],"warnings":[]}`;

const RELATION_PROMPT = `你是群像叙事的“关系变化审计员”。只分析给定人物之间在本批文本中
新增或发生实质变化的有向关系。A 对 B 与 B 对 A 分开判断；同场出现不等于关系变化。
传闻、误解和不确定推断用 review。只输出合法 JSON：
{"character_audit":[],"profile_updates":[],"relation_changes":[{
  "decision":"create|update|no_update|review|deactivate_candidate",
  "from":"人物A","to":"人物B","primary_type":"关系主类型","tags":["标签"],
  "attitude":"A对B的态度","interaction_pattern":"稳定互动方式",
  "visibility":"public|known_to_from|private|author_only","strength":0.5,
  "direction":"improving|declining|mixed|stable","reason":"变化原因",
  "evidence":["具体证据"],"confidence":"observed|inferred|uncertain"
}],"warnings":[]}`;

function string(value, max = 50_000) {
  return String(value ?? "").trim().slice(0, max);
}

function strings(value, maxItems = 50, maxLength = 1000) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => string(item, maxLength)).filter(Boolean)
    : [];
}

function normalizeOpenAiUrl(input) {
  const trimmed = string(input, 2000).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("OpenAI 兼容地址必须以 http:// 或 https:// 开头。");
  }
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function providerSignature(baseUrl, model) {
  const signature = `${baseUrl} ${model}`.toLowerCase();
  if (signature.includes("deepseek")) return "deepseek";
  if (signature.includes("bigmodel.cn") || signature.includes("z.ai") || /\bglm[-_]/.test(signature)) {
    return "glm";
  }
  return "generic";
}

function geminiThinkingConfig(model, mode) {
  if (model.startsWith("gemini-2.5")) {
    return { thinkingBudget: mode === "fast" ? 0 : mode === "balanced" ? 1024 : -1 };
  }
  if (model.startsWith("gemini-3")) {
    return { thinkingLevel: mode === "fast" ? "minimal" : mode === "balanced" ? "low" : "high" };
  }
  return undefined;
}

function contentPart(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) =>
    typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
  ).join("");
}

async function readOpenAiStream(response) {
  if (!response.body) throw new Error("模型已连接，但没有返回可读取的数据流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  function consume(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const chunk = JSON.parse(payload);
      const choice = chunk.choices?.[0];
      output += contentPart(choice?.delta?.content ?? choice?.message?.content);
    } catch {
      // SSE 心跳或供应商元数据，不属于模型正文。
    }
  }
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
    if (done) break;
  }
  if (buffer) consume(buffer);
  return output;
}

async function readError(response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return string(parsed.error?.message ?? parsed.error ?? parsed.message ?? raw, 1000);
  } catch {
    return string(raw || `HTTP ${response.status}`, 1000);
  }
}

function extractJson(raw) {
  const trimmed = string(raw, 2_000_000);
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("模型没有返回可识别的 JSON 对象。");
  return JSON.parse(fenced.slice(first, last + 1));
}

function confidence(value) {
  return ["observed", "inferred", "uncertain"].includes(value) ? value : "observed";
}

function normalizedName(value) {
  return string(value, 200).toLocaleLowerCase().replace(/\s+/g, "");
}

function normalizeRegistry(raw, priority = []) {
  const value = extractJson(raw);
  const characters = Array.isArray(value.characters) ? value.characters : [];
  const seen = new Set();
  const normalized = characters.map((item) => {
    const character = string(item?.character ?? item?.name, 200);
    return {
      character,
      aliases: strings(item?.aliases, 20, 200),
      identity_status: VALID_IDENTITY_STATUSES.has(item?.identity_status)
        ? item.identity_status
        : "ambiguous",
      identification_basis: string(item?.identification_basis, 3000),
      retention_tier: VALID_RETENTION_TIERS.has(item?.retention_tier)
        ? item.retention_tier
        : "watchlist",
      narrative_role: VALID_NARRATIVE_ROLES.has(item?.narrative_role)
        ? item.narrative_role
        : "unknown",
      reason: string(item?.reason, 5000),
      evidence: strings(item?.evidence, 30, 1500),
    };
  }).filter((item) => {
    const key = normalizedName(item.character);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const name of priority) {
    const key = normalizedName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      character: string(name, 200),
      aliases: [],
      identity_status: "named",
      identification_basis: "由当前角色卡、Persona 或既有人物档案指定。",
      retention_tier: "core",
      narrative_role: "protagonist",
      reason: "优先人物必须持续追踪；本轮是否成长由后续分析独立判断。",
      evidence: [],
    });
  }
  return {
    characters: normalized,
    warnings: strings(value.warnings, 100, 2000),
  };
}

function mergeAnalysisResults(target, source) {
  const audit = new Map(target.character_audit.map((item) => [normalizedName(item.character), item]));
  for (const item of source.character_audit ?? []) audit.set(normalizedName(item.character), item);
  const updates = new Map(target.profile_updates.map((item) => [normalizedName(item.character), item]));
  for (const item of source.profile_updates ?? []) updates.set(normalizedName(item.character), item);
  const relations = new Map(target.relation_changes.map((item) => [
    `${normalizedName(item.from)}→${normalizedName(item.to)}`,
    item,
  ]));
  for (const item of source.relation_changes ?? []) {
    relations.set(`${normalizedName(item.from)}→${normalizedName(item.to)}`, item);
  }
  target.character_audit = [...audit.values()].filter((item) => item.character);
  target.profile_updates = [...updates.values()].filter((item) => item.character);
  target.relation_changes = [...relations.values()].filter((item) => item.from && item.to);
  target.warnings = [...new Set([...(target.warnings ?? []), ...(source.warnings ?? [])])];
  return target;
}

function normalizeProfile(raw, character) {
  const profile = raw && typeof raw === "object" ? raw : {};
  const current = profile.current_profile && typeof profile.current_profile === "object"
    ? profile.current_profile
    : {};
  return {
    current_profile: {
      personality: string(current.personality),
      behavior_pattern: string(current.behavior_pattern),
      core_need: string(current.core_need),
      current_stage: string(current.current_stage),
    },
    growth_synopsis: string(profile.growth_synopsis, 60_000),
    residual_patterns: Array.isArray(profile.residual_patterns)
      ? profile.residual_patterns.slice(0, 30).map((item) => ({
        trigger: string(item?.trigger, 1000),
        likely_response: string(item?.likely_response, 2000),
        counterweight: string(item?.counterweight, 2000),
        evidence: strings(item?.evidence, 20, 1000),
      })).filter((item) => item.trigger || item.likely_response || item.counterweight)
      : [],
    character,
  };
}

function normalizeResult(raw, range) {
  const value = extractJson(raw);
  if (!Array.isArray(value.character_audit) || !Array.isArray(value.profile_updates)) {
    throw new Error("模型结果缺少 character_audit 或 profile_updates 数组。");
  }
  const character_audit = value.character_audit.slice(0, 100).map((item) => ({
    character: string(item?.character ?? item?.name_in_text, 200),
    decision: VALID_PROFILE_DECISIONS.has(item?.decision) ? item.decision : "review",
    reason: string(item?.reason, 5000),
    evidence: strings(item?.evidence ?? item?.evidence_refs, 30, 1500),
  })).filter((item) => item.character);

  const profile_updates = value.profile_updates.slice(0, 100).map((item) => {
    const character = string(item?.character, 200);
    const decision = VALID_PROFILE_DECISIONS.has(item?.decision) ? item.decision : "review";
    const proposed = item?.proposed_profile && typeof item.proposed_profile === "object"
      ? normalizeProfile(item.proposed_profile, character)
      : null;
    return {
      character,
      decision: decision === "update" && !proposed ? "review" : decision,
      reason: string(item?.reason, 5000),
      milestone_candidates: Array.isArray(item?.milestone_candidates)
        ? item.milestone_candidates.slice(0, 30).map((milestone) => ({
          character: string(milestone?.character ?? character, 200),
          title: string(milestone?.title, 500),
          dimension: string(milestone?.dimension || "other", 100),
          stage: VALID_STAGES.has(milestone?.stage) ? milestone.stage : "emerging",
          narrative: string(milestone?.narrative, 20_000),
          change_trace: string(milestone?.change_trace, 5000),
          evidence: strings(milestone?.evidence, 30, 1500),
          time: string(milestone?.time || "时间未注明", 500),
          location: string(milestone?.location || "地点未注明", 1000),
          related_characters: strings(milestone?.related_characters, 30, 200),
          source: {
            start_floor: range.start,
            end_floor: range.end,
          },
          confidence: confidence(milestone?.confidence),
          importance: milestone?.importance === "major" ? "major" : "minor",
        })).filter((milestone) =>
          milestone.character && milestone.title && milestone.narrative && milestone.change_trace)
        : [],
      proposed_profile: proposed ? {
        current_profile: proposed.current_profile,
        growth_synopsis: proposed.growth_synopsis,
        residual_patterns: proposed.residual_patterns,
      } : undefined,
      evidence: strings(item?.evidence ?? item?.evidence_refs, 30, 1500),
      confidence: confidence(item?.confidence),
    };
  }).filter((item) => item.character);

  const relation_changes = Array.isArray(value.relation_changes)
    ? value.relation_changes.slice(0, 200).map((item) => ({
      decision: VALID_RELATION_DECISIONS.has(item?.decision) ? item.decision : "review",
      from: string(item?.from ?? item?.from_id, 200),
      to: string(item?.to ?? item?.to_id, 200),
      primary_type: string(item?.primary_type || "未分类", 500),
      tags: strings(item?.tags, 30, 200),
      attitude: string(item?.attitude, 20_000),
      interaction_pattern: string(item?.interaction_pattern, 20_000),
      visibility: ["public", "known_to_from", "private", "author_only"].includes(item?.visibility)
        ? item.visibility
        : "author_only",
      strength: Number.isFinite(Number(item?.strength))
        ? Math.max(0, Math.min(1, Number(item.strength)))
        : undefined,
      direction: ["improving", "declining", "mixed", "stable"].includes(item?.direction)
        ? item.direction
        : "stable",
      reason: string(item?.reason, 5000),
      evidence: strings(item?.evidence ?? item?.evidence_refs, 30, 1500),
      confidence: confidence(item?.confidence),
    })).filter((item) => item.from && item.to && item.from !== item.to)
    : [];

  return {
    character_audit,
    profile_updates,
    relation_changes,
    warnings: strings(value.warnings, 100, 2000),
  };
}

function buildUserContent(payload, state) {
  const range = {
    start: Math.max(0, Number(payload.startFloor ?? 0)),
    end: Math.max(0, Number(payload.endFloor ?? 0)),
  };
  const context = formatMessages(payload.messages);
  if (!context) throw new Error("所选楼层清洗后没有可分析的正文。");
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw new Error("所选楼层超过 90 万字符，请缩小范围。");
  }
  const profiles = materializeProfiles(state, payload.libraryId);
  const relations = materializeRelationships(state, payload.libraryId);
  const priority = [...new Set([
    ...strings(payload.priorityCharacters, 100, 200),
    ...Object.values(profiles).map((profile) => profile.character),
  ])];
  const relevantLocks = Object.fromEntries(
    Object.entries(state.profileLocks ?? {}).filter(([key]) =>
      key.startsWith(`${String(payload.libraryId).toLocaleLowerCase()}::`)),
  );
  return {
    range,
    context,
    profiles,
    relations,
    priority,
    relevantLocks,
    userContent:
`<memory_library>
${JSON.stringify({
    id: payload.libraryId,
    name: payload.libraryName ?? "",
    description: payload.libraryDescription ?? "",
  })}
</memory_library>

<batch_source>
${JSON.stringify({ start_floor: range.start, end_floor: range.end, chat: payload.chatTitle ?? "" })}
</batch_source>

<priority_characters>
${JSON.stringify(priority, null, 2)}
</priority_characters>

<current_profiles>
${JSON.stringify(profiles, null, 2)}
</current_profiles>

<current_relationships>
${JSON.stringify(relations, null, 2)}
</current_relationships>

<locked_profile_fields>
${JSON.stringify(relevantLocks, null, 2)}
</locked_profile_fields>

<text_to_analyze>
${context}
</text_to_analyze>`,
  };
}

async function requestModel(config, userContent, options = {}) {
  const prompt = string(options.prompt ?? config.prompt, 300_000);
  const temperature = Number.isFinite(Number(options.temperature))
    ? Number(options.temperature)
    : config.temperature;
  const maxTokens = Math.max(1024, Math.min(
    65536,
    Number(options.maxTokens ?? config.maxTokens),
  ));
  const thinkingMode = options.thinkingMode ?? config.thinkingMode;
  if (!config.apiKey || !config.model || !prompt) {
    throw new Error("请先保存 API Key、模型名称和分析提示词。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (config.provider === "gemini") {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature,
            maxOutputTokens: maxTokens,
            thinkingConfig: geminiThinkingConfig(config.model, thinkingMode),
          },
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    }

    const signature = providerSignature(config.baseUrl, config.model);
    const stream = signature !== "generic";
    const request = {
      model: config.model,
      temperature,
      max_tokens: maxTokens,
      stream,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userContent },
      ],
    };
    if (signature === "deepseek" || signature === "glm") {
      request.thinking = { type: thinkingMode === "fast" ? "disabled" : "enabled" };
      if (thinkingMode !== "fast") {
        request.reasoning_effort = thinkingMode === "deep" ? "high" : "medium";
      }
    }
    const response = await fetch(normalizeOpenAiUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(await readError(response));
    if (stream) return readOpenAiStream(response);
    const data = await response.json();
    return contentPart(data.choices?.[0]?.message?.content);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`模型超过 ${Math.round(config.timeoutMs / 60000)} 分钟仍未返回，任务已停止。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function profileStagePrompt(basePrompt, group) {
  return `${basePrompt}

# 当前分组硬性要求
本次只负责以下人物：${group.map((item) => item.character).join("、")}。
- 每个人都必须出现在 character_audit；不得遗漏。
- retention_tier 与本轮成长分开：重要人物可以 no_update，绝不能为了建档强造成长。
- core、recurring、watchlist 人物若尚无画像且正文有足够事实，可建立当前基础画像；
  milestone_candidates 只有存在真实长期变化时才填写，否则必须为空数组。
- 本分组不要分析人物关系，relation_changes 必须返回空数组。`;
}

function stageContent(built, registry, group, extra = "") {
  return `${built.userContent}

<character_registry>
${JSON.stringify(registry, null, 2)}
</character_registry>

<required_characters>
${JSON.stringify(group, null, 2)}
</required_characters>
${extra}`;
}

async function runAnalysis(config, payload, state, onProgress = () => {}) {
  const built = buildUserContent(payload, state);
  onProgress({ stage: "census", label: "正在识别全部人物、职称与亲属称谓", current: 0, total: 1 });
  const censusRaw = await requestModel(config, stageContent(
    built,
    [],
    [],
    "\n只执行人物登记，不分析画像、成长或关系。",
  ), {
    prompt: CENSUS_PROMPT,
    thinkingMode: "fast",
    temperature: 0,
    maxTokens: Math.min(config.maxTokens, 8192),
  });
  if (!censusRaw) throw new Error("人物点名请求成功，但没有返回正文。");
  const registry = normalizeRegistry(censusRaw, built.priority);
  const tracked = registry.characters.filter((item) => item.retention_tier !== "ephemeral");
  if (!tracked.length) throw new Error("人物点名完成，但没有找到需要持续追踪的人物。");

  const groups = [];
  for (let index = 0; index < tracked.length; index += PROFILE_GROUP_SIZE) {
    groups.push(tracked.slice(index, index + PROFILE_GROUP_SIZE));
  }
  const merged = {
    character_registry: registry.characters,
    character_audit: [],
    profile_updates: [],
    relation_changes: [],
    warnings: [...registry.warnings],
  };
  const rawStages = { census: censusRaw, profiles: [], relationships: "" };
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    onProgress({
      stage: "profiles",
      label: `正在分析人物 ${index + 1}/${groups.length}：${group.map((item) => item.character).join("、")}`,
      current: index + 1,
      total: groups.length,
    });
    const raw = await requestModel(config, stageContent(built, registry.characters, group), {
      prompt: profileStagePrompt(config.prompt, group),
    });
    if (!raw) throw new Error(`人物分组 ${index + 1} 没有返回正文。`);
    rawStages.profiles.push(raw);
    let normalized = normalizeResult(raw, built.range);
    const audited = new Set(normalized.character_audit.map((item) => normalizedName(item.character)));
    const missing = group.filter((item) => !audited.has(normalizedName(item.character)));
    if (missing.length) {
      onProgress({
        stage: "repair",
        label: `正在补查遗漏人物：${missing.map((item) => item.character).join("、")}`,
        current: index + 1,
        total: groups.length,
      });
      const repairRaw = await requestModel(
        config,
        stageContent(built, registry.characters, missing, "\n上一次漏掉了这些人物，本次必须逐人返回。"),
        { prompt: profileStagePrompt(config.prompt, missing) },
      );
      if (repairRaw) {
        rawStages.profiles.push(repairRaw);
        normalized = mergeAnalysisResults(normalized, normalizeResult(repairRaw, built.range));
      }
    }
    mergeAnalysisResults(merged, normalized);
  }

  if (tracked.length > 1) {
    onProgress({ stage: "relationships", label: "正在独立整理人物关系变化", current: 1, total: 1 });
    const relationRaw = await requestModel(
      config,
      stageContent(built, registry.characters, tracked),
      { prompt: RELATION_PROMPT },
    );
    if (relationRaw) {
      rawStages.relationships = relationRaw;
      mergeAnalysisResults(merged, normalizeResult(relationRaw, built.range));
    }
  }
  const finalAudited = new Set(merged.character_audit.map((item) => normalizedName(item.character)));
  for (const item of tracked) {
    if (finalAudited.has(normalizedName(item.character))) continue;
    merged.character_audit.push({
      character: item.character,
      decision: "review",
      reason: "模型补查后仍未提供可靠人物判断，保留登记但不自动生成成长。",
      evidence: item.evidence,
    });
    merged.warnings.push(`人物“${item.character}”已登记，但本轮画像分析仍需人工复核。`);
  }
  onProgress({ stage: "completed", label: `分析完成：登记 ${registry.characters.length} 人`, current: 1, total: 1 });
  return {
    result: merged,
    raw: JSON.stringify(rawStages),
    cleanedContext: built.context,
    range: built.range,
  };
}

module.exports = {
  buildUserContent,
  normalizeRegistry,
  normalizeOpenAiUrl,
  normalizeResult,
  requestModel,
  runAnalysis,
};
