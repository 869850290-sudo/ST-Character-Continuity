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
  const profiles = materializeProfiles(state, payload.storyId, payload.timelineId);
  const relations = materializeRelationships(state, payload.storyId, payload.timelineId);
  const priority = [...new Set([
    ...strings(payload.priorityCharacters, 100, 200),
    ...Object.values(profiles).map((profile) => profile.character),
  ])];
  const relevantLocks = Object.fromEntries(
    Object.entries(state.profileLocks ?? {}).filter(([key]) =>
      key.startsWith(`${String(payload.storyId).toLocaleLowerCase()}::`)),
  );
  return {
    range,
    context,
    userContent:
`<batch_source>
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

async function requestModel(config, userContent) {
  if (!config.apiKey || !config.model || !config.prompt) {
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
          systemInstruction: { parts: [{ text: config.prompt }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            thinkingConfig: geminiThinkingConfig(config.model, config.thinkingMode),
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
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream,
      messages: [
        { role: "system", content: config.prompt },
        { role: "user", content: userContent },
      ],
    };
    if (signature === "deepseek" || signature === "glm") {
      request.thinking = { type: config.thinkingMode === "fast" ? "disabled" : "enabled" };
      if (config.thinkingMode !== "fast") {
        request.reasoning_effort = config.thinkingMode === "deep" ? "high" : "medium";
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

async function runAnalysis(config, payload, state) {
  const built = buildUserContent(payload, state);
  const raw = await requestModel(config, built.userContent);
  if (!raw) throw new Error("模型请求成功，但没有返回正文。");
  return {
    result: normalizeResult(raw, built.range),
    raw,
    cleanedContext: built.context,
    range: built.range,
  };
}

module.exports = {
  buildUserContent,
  normalizeOpenAiUrl,
  normalizeResult,
  requestModel,
  runAnalysis,
};
