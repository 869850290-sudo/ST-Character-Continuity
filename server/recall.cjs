"use strict";

const {
  allMilestones,
  materializeProfiles,
  materializeRelationships,
} = require("./state.cjs");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function containsName(text, name) {
  const normalizedText = cleanText(text).toLocaleLowerCase();
  const normalizedName = cleanText(name).toLocaleLowerCase();
  return normalizedName.length > 0 && normalizedText.includes(normalizedName);
}

function tokenList(text) {
  const normalized = cleanText(text).toLocaleLowerCase();
  const tokens = (
    normalized
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
  const compactHan = normalized.replace(/[^\p{Script=Han}]/gu, "");
  for (let width = 2; width <= 3; width += 1) {
    for (let index = 0; index + width <= compactHan.length; index += 1) {
      tokens.push(compactHan.slice(index, index + width));
    }
  }
  return tokens;
}

function textTokens(text) {
  return new Set(tokenList(text));
}

function tokenCounts(text) {
  const counts = new Map();
  for (const token of tokenList(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function buildSearchModel(documents) {
  const rows = documents.map((document) => tokenCounts(document));
  const documentFrequency = new Map();
  let totalLength = 0;
  for (const row of rows) {
    totalLength += row.size;
    for (const token of row.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return {
    documentCount: Math.max(1, rows.length),
    documentFrequency,
    averageLength: rows.length ? Math.max(1, totalLength / rows.length) : 1,
  };
}

function bm25Score(queryTokens, text, model) {
  if (!queryTokens.size || !model) return 0;
  const counts = tokenCounts(text);
  const length = Math.max(1, counts.size);
  let score = 0;
  for (const token of queryTokens) {
    const frequency = counts.get(token) ?? 0;
    if (!frequency) continue;
    const df = model.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (model.documentCount - df + 0.5) / (df + 0.5));
    const denominator = frequency + 1.2 * (
      1 - 0.75 + 0.75 * length / model.averageLength
    );
    score += idf * (frequency * 2.2) / denominator;
  }
  return score;
}

function overlapScore(queryTokens, text) {
  const target = textTokens(text);
  if (!queryTokens.size || !target.size) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (target.has(token)) hits += token.length >= 3 ? 1.4 : 1;
  }
  return hits / Math.sqrt(queryTokens.size * target.size);
}

function hybridScore(queryTokens, text, searchModel) {
  return bm25Score(queryTokens, text, searchModel)
    + overlapScore(queryTokens, text) * 2;
}

function nearDuplicate(value, selected) {
  const target = textTokens(value);
  if (!target.size) return false;
  return selected.some((existing) => {
    const source = textTokens(existing);
    if (!source.size) return false;
    let shared = 0;
    for (const token of target) {
      if (source.has(token)) shared += 1;
    }
    return shared / Math.min(source.size, target.size) >= 0.78;
  });
}

function uniqueNames(profiles, relations) {
  const names = new Set();
  Object.values(profiles).forEach((profile) => names.add(cleanText(profile.character)));
  Object.values(relations).forEach((edge) => {
    names.add(cleanText(edge.from));
    names.add(cleanText(edge.to));
  });
  names.delete("");
  return [...names];
}

function relevantCharacters({ text, candidates, names, limit }) {
  const exact = names.filter((name) => containsName(text, name));
  const allowed = new Set(names.map((name) => name.toLocaleLowerCase()));
  const fallbacks = (candidates ?? [])
    .map(cleanText)
    .filter((name) => allowed.has(name.toLocaleLowerCase()));
  return [...new Set([...exact, ...fallbacks])].slice(0, limit);
}

function estimateTokens(value) {
  const text = String(value ?? "");
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const kanaHangul = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const withoutCjk = text.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    " ",
  );
  const words = withoutCjk.match(/[\p{L}\p{N}]+/gu) ?? [];
  const punctuation = withoutCjk.replace(/[\p{L}\p{N}\s]/gu, "").length;
  return Math.max(0, Math.ceil(
    han * 1.15
    + kanaHangul * 1.1
    + words.reduce((sum, word) => sum + Math.max(1, word.length / 3.5), 0)
    + punctuation / 3,
  ));
}

function textUnits(value) {
  return cleanText(value)
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map(cleanText)
    .filter(Boolean);
}

function truncateTokens(value, tokenLimit) {
  let output = "";
  for (const character of cleanText(value)) {
    if (estimateTokens(output + character) > tokenLimit) break;
    output += character;
  }
  return output.trim();
}

function compactText(value, queryTokens, tokenLimit, searchModel = null, anchorFirst = false) {
  const units = textUnits(value);
  if (!units.length || tokenLimit <= 0) return "";
  const anchored = anchorFirst ? truncateTokens(
    units[0],
    Math.max(20, Math.min(Math.floor(tokenLimit * 0.45), tokenLimit)),
  ) : "";
  const anchoredCost = estimateTokens(anchored);
  const ranked = units.map((unit, index) => ({
    unit,
    index,
    score: hybridScore(queryTokens, unit, searchModel) + (index === 0 ? 0.2 : 0),
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = anchored ? [{ unit: anchored, index: 0 }] : [];
  let used = anchoredCost;
  for (const entry of ranked) {
    if (anchored && entry.index === 0) continue;
    const cost = estimateTokens(entry.unit);
    if (cost > tokenLimit - used) continue;
    picked.push(entry);
    used += cost;
  }
  if (!picked.length) {
    return truncateTokens(units[0], tokenLimit);
  }
  return picked.sort((a, b) => a.index - b.index).map((entry) => entry.unit).join("");
}

function formatProfile(profile, queryTokens, tokenBudget, includeGrowthSynopsis, searchModel) {
  const current = profile.current_profile ?? {};
  const header = `### ${cleanText(profile.character)}`;
  const available = Math.max(0, tokenBudget - estimateTokens(header) - 8);
  const fields = [
    ["性格", current.personality, 0.28],
    ["行动方式", current.behavior_pattern, 0.32],
    ["核心需求", current.core_need, 0.15],
    ["当前阶段", current.current_stage, 0.15],
  ];
  if (includeGrowthSynopsis) fields.push(["成长脉络", profile.growth_synopsis, 0.1]);
  const lines = [header];
  const selectedDetails = [];
  for (const [label, value, ratio] of fields) {
    const compact = compactText(
      value,
      queryTokens,
      Math.max(30, Math.floor(available * ratio)),
      searchModel,
      label === "性格" || label === "行动方式",
    );
    if (compact && !nearDuplicate(compact, selectedDetails)) {
      lines.push(`${label}：${compact}`);
      selectedDetails.push(compact);
    }
  }
  const residual = profile.residual_patterns?.[0];
  if (residual && estimateTokens(lines.join("\n")) < tokenBudget - 80) {
    const compact = compactText(
      `触发${cleanText(residual.trigger)}时可能${cleanText(residual.likely_response)}；` +
      `制衡：${cleanText(residual.counterweight)}`,
      queryTokens,
      Math.min(160, Math.max(40, tokenBudget - estimateTokens(lines.join("\n")))),
      searchModel,
    );
    if (compact && !nearDuplicate(compact, selectedDetails)) lines.push(`旧模式：${compact}`);
  }
  return lines.join("\n");
}

function formatMilestone(item, queryTokens, tokenBudget, searchModel) {
  const prefix = `- [${cleanText(item.character)}｜${cleanText(item.title)}]`;
  const narrative = compactText(
    item.narrative,
    queryTokens,
    Math.floor(tokenBudget * 0.62),
    searchModel,
  );
  const trace = compactText(
    item.change_trace,
    queryTokens,
    Math.floor(tokenBudget * 0.25),
    searchModel,
  );
  return [
    prefix,
    item.time ? cleanText(item.time) : "",
    narrative,
    trace ? `变化：${trace}` : "",
  ].filter(Boolean).join(" ");
}

function formatRelation(edge, queryTokens, tokenBudget, searchModel) {
  const prefix = `- ${edge.from} → ${edge.to}【${cleanText(edge.primary_type)}】`;
  const attitude = compactText(
    edge.attitude,
    queryTokens,
    Math.floor(tokenBudget * 0.42),
    searchModel,
  );
  const interaction = compactText(
    edge.interaction_pattern,
    queryTokens,
    Math.floor(tokenBudget * 0.42),
    searchModel,
  );
  return [
    prefix,
    attitude,
    interaction ? `互动：${interaction}` : "",
  ].filter(Boolean).join(" ");
}

function wrapSection(tag, items) {
  if (!items.length) return "";
  return `<${tag}>\n${items.join("\n")}\n</${tag}>`;
}

function takeItems(items, formatter, sectionBudget, perItemMaximum) {
  const selected = [];
  const output = [];
  let used = 0;
  for (const item of items) {
    const remaining = sectionBudget - used;
    if (remaining < 40) break;
    const formatted = formatter(item, Math.min(perItemMaximum, remaining));
    const cost = estimateTokens(formatted);
    if (!formatted || cost > remaining) continue;
    selected.push(item);
    output.push(formatted);
    used += cost;
  }
  return { selected, output, used };
}

function recall(state, options = {}) {
  const startedAt = Date.now();
  const libraryId = cleanText(options.libraryId);
  const text = cleanText(options.text);
  const limits = {
    profiles: Math.max(1, Math.min(8, Number(options.profileLimit ?? 4))),
    milestones: Math.max(0, Math.min(20, Number(options.milestoneLimit ?? 6))),
    relations: Math.max(0, Math.min(24, Number(options.relationLimit ?? 8))),
    attentionCeiling: Math.max(8000, Math.min(
      1_000_000,
      Number(options.attentionCeilingTokens ?? 36_000),
    )),
    recallMaximum: Math.max(500, Math.min(
      20_000,
      Number(options.recallMaxTokens ?? 5_000),
    )),
    safetyReserve: Math.max(1000, Math.min(
      40_000,
      Number(options.safetyReserveTokens ?? 4_000),
    )),
  };
  const suppliedBaseTokens = Number(options.baseContextTokens);
  const baseContextTokens = Number.isFinite(suppliedBaseTokens) && suppliedBaseTokens >= 0
    ? Math.round(suppliedBaseTokens)
    : null;
  const availableTokens = baseContextTokens == null
    ? limits.recallMaximum
    : Math.max(0, limits.attentionCeiling - limits.safetyReserve - baseContextTokens);
  const tokenBudget = Math.max(0, Math.min(limits.recallMaximum, availableTokens));

  const profileMap = materializeProfiles(state, libraryId);
  const relationMap = materializeRelationships(state, libraryId);
  const milestones = allMilestones(state, libraryId);
  const names = uniqueNames(profileMap, relationMap);
  const detected = relevantCharacters({
    text,
    candidates: options.candidateCharacters,
    names,
    limit: limits.profiles,
  });
  const detectedSet = new Set(detected);
  const profileCharacters = new Set(
    Object.values(profileMap).map((profile) => profile.character),
  );
  const profiles = Object.values(profileMap)
    .filter((profile) => detectedSet.has(profile.character))
    .slice(0, limits.profiles);

  const queryTokens = textTokens(text);
  const searchDocuments = [
    ...Object.values(profileMap).flatMap((profile) => [
      profile.current_profile?.personality,
      profile.current_profile?.behavior_pattern,
      profile.current_profile?.core_need,
      profile.current_profile?.current_stage,
      profile.growth_synopsis,
    ]),
    ...milestones.map((item) => [
      item.character,
      item.title,
      item.narrative,
      item.change_trace,
      ...(item.evidence ?? []),
    ].join(" ")),
    ...Object.values(relationMap).map((edge) => [
      edge.from,
      edge.to,
      edge.primary_type,
      ...(edge.tags ?? []),
      edge.attitude,
      edge.interaction_pattern,
    ].join(" ")),
  ].map(cleanText).filter(Boolean);
  const searchModel = buildSearchModel(searchDocuments);
  const growth = milestones
    .map((item) => {
      const searchable = [
        item.character,
        item.title,
        item.narrative,
        item.change_trace,
        item.time,
        item.location,
        ...(item.evidence ?? []),
        ...(item.related_characters ?? []),
      ].join(" ");
      const characterBoost = detectedSet.has(item.character) ? 2 : 0;
      const relatedBoost = (item.related_characters ?? [])
        .some((name) => detectedSet.has(name)) ? 0.7 : 0;
      return {
        item,
        score: characterBoost + relatedBoost + hybridScore(queryTokens, searchable, searchModel),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score ||
      String(b.item.created_at ?? "").localeCompare(String(a.item.created_at ?? "")))
    .slice(0, limits.milestones);

  const relations = Object.values(relationMap)
    .map((edge) => {
      const fromHit = detectedSet.has(edge.from);
      const toHit = detectedSet.has(edge.to);
      const direct = fromHit && toHit;
      const oneHop = fromHit || toHit;
      const unseenCharacter = fromHit ? edge.to : edge.from;
      // A one-hop edge is useful only when the newly introduced endpoint has
      // a profile of its own. This prevents a hub such as the player persona
      // from pulling every manually recorded relationship into every turn.
      const safeOneHop = oneHop && profileCharacters.has(unseenCharacter);
      const searchable = [
        edge.from,
        edge.to,
        edge.primary_type,
        ...(edge.tags ?? []),
        edge.attitude,
        edge.interaction_pattern,
      ].join(" ");
      const relevance = hybridScore(queryTokens, searchable, searchModel);
      return {
        edge,
        tier: direct ? 2 : safeOneHop ? 1 : 0,
        score: relevance,
      };
    })
    .filter((entry) => entry.tier > 0)
    .sort((a, b) => b.tier - a.tier || b.score - a.score ||
      Number(b.edge.strength ?? 0) - Number(a.edge.strength ?? 0))
    .slice(0, limits.relations);

  const wrapperLead = [
    "<character_continuity_memory>",
    "以下内容是只读的人物连续性资料。优先遵守当前人格、行动规律和关系边界；",
    "只将其作为既有事实，不复述标签，不让人物知道其无权知晓的私密关系。",
  ].join("\n");
  const wrapperTail = "</character_continuity_memory>";
  const wrapperCost = estimateTokens(`${wrapperLead}\n${wrapperTail}`) + 12;
  const sectionOverhead = 60;
  const contentBudget = Math.max(0, tokenBudget - wrapperCost - sectionOverhead);
  const coreOnly = tokenBudget > 0 && tokenBudget < 1400;
  const profileBudget = coreOnly ? contentBudget : Math.floor(contentBudget * 0.55);
  const growthBudget = coreOnly ? 0 : Math.floor(contentBudget * 0.25);
  const relationBudget = coreOnly ? 0 : Math.max(
    0,
    contentBudget - profileBudget - growthBudget,
  );
  const growthCharacters = new Set(growth.map(({ item }) => item.character));
  const profileShare = profiles.length
    ? Math.max(100, Math.floor(profileBudget / profiles.length))
    : 0;
  const packedProfiles = takeItems(
    profiles,
    (profile, budget) => formatProfile(
      profile,
      queryTokens,
      budget,
      !growthCharacters.has(profile.character),
      searchModel,
    ),
    profileBudget,
    profileShare,
  );
  const packedGrowth = takeItems(
    growth,
    (entry, budget) => formatMilestone(entry.item, queryTokens, budget, searchModel),
    growthBudget,
    320,
  );
  const packedRelations = takeItems(
    relations,
    (entry, budget) => formatRelation(entry.edge, queryTokens, budget, searchModel),
    relationBudget,
    220,
  );
  const sections = [
    wrapSection("character_profiles", packedProfiles.output),
    wrapSection("character_growth", packedGrowth.output),
    wrapSection("character_relationships", packedRelations.output),
  ].filter(Boolean);
  const body = sections.join("\n");
  const injection = body
    ? [wrapperLead, body, wrapperTail].join("\n")
    : "";
  const injectionTokens = estimateTokens(injection);

  return {
    libraryId,
    detectedCharacters: detected,
    profiles: packedProfiles.selected,
    milestones: packedGrowth.selected,
    relations: packedRelations.selected,
    injection,
    stats: {
      profileCount: packedProfiles.selected.length,
      milestoneCount: packedGrowth.selected.length,
      relationCount: packedRelations.selected.length,
      characterCount: injection.length,
      estimatedTokens: injectionTokens,
      tokenBudget,
      baseContextTokens,
      projectedInputTokens: baseContextTokens == null
        ? null
        : baseContextTokens + injectionTokens,
      attentionCeilingTokens: limits.attentionCeiling,
      safetyReserveTokens: limits.safetyReserve,
      contextSizeExact: options.contextSizeExact === true,
      mode: !injection ? "blocked" : coreOnly ? "core_only" : "layered",
      retrievalMode: "local_hybrid_bm25",
      retrievalMs: Math.max(0, Date.now() - startedAt),
      scannedItems: searchDocuments.length,
    },
  };
}

module.exports = {
  bm25Score,
  buildSearchModel,
  estimateTokens,
  recall,
  textTokens,
};
