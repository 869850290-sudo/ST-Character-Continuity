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

function textTokens(text) {
  const normalized = cleanText(text).toLocaleLowerCase();
  const tokens = new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
  const compactHan = normalized.replace(/[^\p{Script=Han}]/gu, "");
  for (let width = 2; width <= 3; width += 1) {
    for (let index = 0; index + width <= compactHan.length; index += 1) {
      tokens.add(compactHan.slice(index, index + width));
    }
  }
  return tokens;
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

function formatProfile(profile) {
  const current = profile.current_profile ?? {};
  const residual = (profile.residual_patterns ?? []).slice(0, 3).map((item) =>
    `触发「${cleanText(item.trigger)}」时可能${cleanText(item.likely_response)}；` +
    `制衡因素：${cleanText(item.counterweight)}`,
  );
  return [
    `### ${profile.character}`,
    `性格：${cleanText(current.personality)}`,
    `行动方式：${cleanText(current.behavior_pattern)}`,
    `核心需求：${cleanText(current.core_need)}`,
    `当前阶段：${cleanText(current.current_stage)}`,
    profile.growth_synopsis ? `成长概览：${cleanText(profile.growth_synopsis)}` : "",
    residual.length ? `旧模式残留：${residual.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

function formatMilestone(item) {
  return [
    `- [${cleanText(item.character)}｜${cleanText(item.title)}]`,
    item.time ? `${cleanText(item.time)}` : "",
    item.location ? `@ ${cleanText(item.location)}` : "",
    cleanText(item.narrative),
    item.change_trace ? `变化：${cleanText(item.change_trace)}` : "",
  ].filter(Boolean).join(" ");
}

function formatRelation(edge) {
  return [
    `- ${edge.from} → ${edge.to}`,
    `【${cleanText(edge.primary_type)}】`,
    cleanText(edge.attitude),
    edge.interaction_pattern ? `互动：${cleanText(edge.interaction_pattern)}` : "",
  ].filter(Boolean).join(" ");
}

function cutSections(sections, maxChars) {
  const output = [];
  let remaining = Math.max(500, maxChars);
  for (const section of sections) {
    if (!section.content) continue;
    const header = `\n<${section.tag}>\n`;
    const footer = `\n</${section.tag}>`;
    const room = remaining - header.length - footer.length;
    if (room <= 0) break;
    const content = section.content.slice(0, room);
    output.push(`${header}${content}${footer}`);
    remaining -= header.length + content.length + footer.length;
  }
  return output.join("").trim();
}

function recall(state, options = {}) {
  const storyId = cleanText(options.storyId);
  const timelineId = cleanText(options.timelineId);
  const text = cleanText(options.text);
  const limits = {
    profiles: Math.max(1, Math.min(8, Number(options.profileLimit ?? 4))),
    milestones: Math.max(0, Math.min(20, Number(options.milestoneLimit ?? 6))),
    relations: Math.max(0, Math.min(24, Number(options.relationLimit ?? 8))),
    maxChars: Math.max(500, Math.min(20000, Number(options.maxChars ?? 6000))),
  };

  const profileMap = materializeProfiles(state, storyId, timelineId);
  const relationMap = materializeRelationships(state, storyId, timelineId);
  const milestones = allMilestones(state, storyId, timelineId);
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
        score: characterBoost + relatedBoost + overlapScore(queryTokens, searchable),
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
      return { edge, score: direct ? 3 : safeOneHop ? 1 : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score ||
      Number(b.edge.strength ?? 0) - Number(a.edge.strength ?? 0))
    .slice(0, limits.relations);

  const sections = [
    {
      tag: "character_profiles",
      content: profiles.map(formatProfile).join("\n\n"),
    },
    {
      tag: "character_growth",
      content: growth.map(({ item }) => formatMilestone(item)).join("\n"),
    },
    {
      tag: "character_relationships",
      content: relations.map(({ edge }) => formatRelation(edge)).join("\n"),
    },
  ];
  const body = cutSections(sections, limits.maxChars);
  const injection = body
    ? [
        "<character_continuity_memory>",
        "以下内容是只读的角色连续性资料。它描述人物当前状态、成长轨迹和有向关系；",
        "请把它作为既有事实参考，不要复述标签，也不要让角色知道其无权知晓的私密关系。",
        body,
        "</character_continuity_memory>",
      ].join("\n")
    : "";

  return {
    storyId,
    timelineId,
    detectedCharacters: detected,
    profiles,
    milestones: growth,
    relations,
    injection,
    stats: {
      profileCount: profiles.length,
      milestoneCount: growth.length,
      relationCount: relations.length,
      characterCount: injection.length,
    },
  };
}

module.exports = { recall, textTokens };
