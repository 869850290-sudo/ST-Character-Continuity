"use strict";

const EMPTY_STATE = Object.freeze({
  version: 2,
  baseProfiles: {},
  profileOverrides: {},
  baseRelations: {},
  profileLocks: {},
  relationOverrides: {},
  graphPositions: {},
  batches: {},
});

const PROFILE_FIELDS = new Set([
  "current_profile.personality",
  "current_profile.behavior_pattern",
  "current_profile.core_need",
  "current_profile.current_stage",
  "growth_synopsis",
  "residual_patterns",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeId(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function profileKey(storyId, timelineId, character) {
  return `${normalizeId(storyId)}::${normalizeId(timelineId)}::${normalizeId(character)}`;
}

function relationKey(storyId, timelineId, from, to) {
  return `${normalizeId(storyId)}::${normalizeId(timelineId)}::${normalizeId(from)}→${normalizeId(to)}`;
}

function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("状态文件必须是 JSON 对象。");
  }
  const state = {
    ...clone(EMPTY_STATE),
    ...clone(input),
    version: 2,
  };
  for (const key of [
    "baseProfiles",
    "profileOverrides",
    "baseRelations",
    "profileLocks",
    "relationOverrides",
    "graphPositions",
    "batches",
  ]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) {
      state[key] = {};
    }
  }
  return state;
}

function orderedBatches(state, storyId, timelineId) {
  return Object.values(state.batches)
    .filter((batch) => batch && batch.status === "committed")
    .filter((batch) => !storyId || batch.storyId === storyId)
    .filter((batch) => !timelineId || batch.timelineId === timelineId)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) ||
      String(a.batchId ?? "").localeCompare(String(b.batchId ?? "")));
}

function createEmptyProfile(storyId, timelineId, character) {
  return {
    story_id: storyId,
    timeline_id: timelineId,
    character,
    current_profile: {
      personality: "",
      behavior_pattern: "",
      core_need: "",
      current_stage: "",
    },
    growth_synopsis: "",
    residual_patterns: [],
    active_milestone_ids: [],
    version: 0,
    updated_at: "",
    last_batch_id: "",
    last_source: "",
  };
}

function valueAtPath(root, path) {
  let cursor = root;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setValueAtPath(root, path, value) {
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = clone(value);
}

function applyProfileLocks(profile, locks) {
  if (!locks) return profile;
  for (const [path, value] of Object.entries(locks)) {
    if (PROFILE_FIELDS.has(path)) setValueAtPath(profile, path, value);
  }
  return profile;
}

function materializeProfiles(stateInput, storyId, timelineId) {
  const state = normalizeState(stateInput);
  const profiles = clone(state.baseProfiles);

  for (const batch of orderedBatches(state, storyId, timelineId)) {
    for (const update of batch.result?.profile_updates ?? []) {
      if (update.decision !== "update" || !update.proposed_profile) continue;
      const key = profileKey(batch.storyId, batch.timelineId, update.character);
      const current = profiles[key] ??
        createEmptyProfile(batch.storyId, batch.timelineId, update.character);
      const milestoneIds = (update.milestone_candidates ?? []).map(
        (_, index) => `${batch.batchId}:milestone:${normalizeId(update.character)}:${index}`,
      );
      profiles[key] = applyProfileLocks({
        ...current,
        character: update.character,
        current_profile: clone(update.proposed_profile.current_profile),
        growth_synopsis: String(update.proposed_profile.growth_synopsis ?? ""),
        residual_patterns: clone(update.proposed_profile.residual_patterns ?? []),
        active_milestone_ids: [...new Set([
          ...(current.active_milestone_ids ?? []),
          ...milestoneIds,
        ])],
        version: Number(current.version ?? 0) + 1,
        updated_at: batch.acceptedAt,
        last_batch_id: batch.batchId,
        last_source: `${batch.fileName ?? ""} · ${batch.range ?? ""}`,
      }, state.profileLocks[key]);
    }
  }

  for (const [key, locks] of Object.entries(state.profileLocks)) {
    if (profiles[key]) profiles[key] = applyProfileLocks(profiles[key], locks);
  }

  for (const [key, override] of Object.entries(state.profileOverrides)) {
    if (override?.active === false) {
      delete profiles[key];
      continue;
    }
    profiles[key] = clone(override);
  }

  return Object.fromEntries(
    Object.entries(profiles).filter(([, profile]) =>
      (!storyId || profile.story_id === storyId) &&
      (!timelineId || profile.timeline_id === timelineId)),
  );
}

function allMilestones(stateInput, storyId, timelineId) {
  const state = normalizeState(stateInput);
  const milestones = [];
  for (const batch of orderedBatches(state, storyId, timelineId)) {
    for (const update of batch.result?.profile_updates ?? []) {
      if (update.decision !== "update") continue;
      (update.milestone_candidates ?? []).forEach((candidate, index) => {
        milestones.push({
          ...clone(candidate),
          milestone_id: `${batch.batchId}:milestone:${normalizeId(update.character)}:${index}`,
          batch_id: batch.batchId,
          story_id: batch.storyId,
          timeline_id: batch.timelineId,
          status: "active",
          created_at: batch.acceptedAt,
        });
      });
    }
  }
  return milestones;
}

function applyRelationChange(edges, batch, change) {
  if (change.decision !== "create" && change.decision !== "update") return;
  const key = relationKey(batch.storyId, batch.timelineId, change.from, change.to);
  const before = edges[key];
  edges[key] = {
    story_id: batch.storyId,
    timeline_id: batch.timelineId,
    from: change.from,
    to: change.to,
    primary_type: change.primary_type || before?.primary_type || "未分类",
    tags: [...new Set((change.tags ?? []).map(String))],
    attitude: String(change.attitude ?? ""),
    interaction_pattern: String(change.interaction_pattern ?? ""),
    visibility: change.visibility ?? "private",
    strength: typeof change.strength === "number"
      ? Math.max(0, Math.min(1, change.strength))
      : before?.strength,
    active: true,
    version: Number(before?.version ?? 0) + 1,
    updated_at: batch.acceptedAt,
    last_batch_id: batch.batchId,
  };
}

function materializeRelationships(stateInput, storyId, timelineId) {
  const state = normalizeState(stateInput);
  const edges = clone(state.baseRelations);
  for (const batch of orderedBatches(state, storyId, timelineId)) {
    for (const change of batch.result?.relation_changes ?? []) {
      applyRelationChange(edges, batch, change);
    }
  }
  for (const [key, override] of Object.entries(state.relationOverrides)) {
    edges[key] = clone(override);
  }
  return Object.fromEntries(
    Object.entries(edges).filter(([, edge]) =>
      edge.active !== false &&
      (!storyId || edge.story_id === storyId) &&
      (!timelineId || edge.timeline_id === timelineId)),
  );
}

module.exports = {
  EMPTY_STATE,
  allMilestones,
  materializeProfiles,
  materializeRelationships,
  normalizeState,
  profileKey,
  relationKey,
  valueAtPath,
};
