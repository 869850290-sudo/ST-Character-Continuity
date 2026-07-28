"use strict";

const crypto = require("node:crypto");

const EMPTY_STATE = Object.freeze({
  version: 3,
  libraries: {},
  cardDefaults: {},
  chatBindings: {},
  baseProfiles: {},
  profileOverrides: {},
  baseRelations: {},
  profileLocks: {},
  relationOverrides: {},
  graphPositions: {},
  batches: {},
  analysisProgress: {},
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

function profileKey(libraryId, character) {
  return `${normalizeId(libraryId)}::${normalizeId(character)}`;
}

function relationKey(libraryId, from, to) {
  return `${normalizeId(libraryId)}::${normalizeId(from)}→${normalizeId(to)}`;
}

function chatBindingKey(cardKey, chatKey) {
  return JSON.stringify([String(cardKey ?? ""), String(chatKey ?? "")]);
}

function progressKey(libraryId, chatKey) {
  return `${normalizeId(libraryId)}::chat::${normalizeId(chatKey)}`;
}

function createLibrary({ name, description = "", sourceLibraryId = "", legacy = null } = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: String(name || "未命名人物档案库").trim().slice(0, 200),
    description: String(description || "").trim().slice(0, 2000),
    source_library_id: String(sourceLibraryId || ""),
    legacy: legacy && typeof legacy === "object" ? clone(legacy) : null,
    archived: false,
    created_at: now,
    updated_at: now,
  };
}

function legacyLibraryId(storyId, timelineId) {
  return `legacy_${normalizeId(storyId)}_${normalizeId(timelineId)}`;
}

function ensureLegacyLibrary(state, storyId, timelineId) {
  const id = legacyLibraryId(storyId, timelineId);
  if (!state.libraries[id]) {
    const now = new Date().toISOString();
    state.libraries[id] = {
      id,
      name: [storyId, timelineId].filter(Boolean).join(" · ") || "旧版人物档案",
      description: "由 v0.3 及更早版本的故事/时间线资料自动迁移。",
      source_library_id: "",
      legacy: { storyId: String(storyId || ""), timelineId: String(timelineId || "") },
      archived: false,
      created_at: now,
      updated_at: now,
    };
  }
  return id;
}

function migrateMap(state, source, kind) {
  const migrated = {};
  for (const [oldKey, raw] of Object.entries(source ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const oldParts = oldKey.split("::");
    const storyId = raw.story_id || raw.storyId ||
      (kind === "position" ? oldParts[0] : "") || "默认故事";
    const timelineId = raw.timeline_id || raw.timelineId ||
      (kind === "position" ? oldParts[1] : "") || "主线";
    const libraryId = raw.library_id || ensureLegacyLibrary(state, storyId, timelineId);
    const item = { ...clone(raw), library_id: libraryId };
    delete item.story_id;
    delete item.timeline_id;
    const key = kind === "relation"
      ? relationKey(libraryId, item.from, item.to)
      : kind === "position"
        ? profileKey(libraryId, oldParts.at(-1))
        : profileKey(libraryId, item.character || oldParts.at(-1));
    migrated[key] = item;
  }
  return migrated;
}

function migrateV2(input) {
  const state = {
    ...clone(EMPTY_STATE),
    ...clone(input),
    version: 3,
    libraries: {},
    cardDefaults: {},
    chatBindings: {},
  };
  state.baseProfiles = migrateMap(state, input.baseProfiles, "profile");
  state.profileOverrides = migrateMap(state, input.profileOverrides, "profile");
  state.baseRelations = migrateMap(state, input.baseRelations, "relation");
  state.relationOverrides = migrateMap(state, input.relationOverrides, "relation");
  state.graphPositions = migrateMap(state, input.graphPositions, "position");
  state.profileLocks = {};
  for (const [oldKey, locks] of Object.entries(input.profileLocks ?? {})) {
    const parts = oldKey.split("::");
    const libraryId = ensureLegacyLibrary(state, parts[0] || "默认故事", parts[1] || "主线");
    state.profileLocks[profileKey(libraryId, parts.at(-1))] = clone(locks);
  }
  state.batches = {};
  for (const [batchId, raw] of Object.entries(input.batches ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const libraryId = raw.libraryId ||
      ensureLegacyLibrary(state, raw.storyId || "默认故事", raw.timelineId || "主线");
    state.batches[batchId] = {
      ...clone(raw),
      libraryId,
      legacyStoryId: raw.storyId || "",
      legacyTimelineId: raw.timelineId || "",
    };
    delete state.batches[batchId].storyId;
    delete state.batches[batchId].timelineId;
  }
  state.analysisProgress = {};
  for (const raw of Object.values(input.analysisProgress ?? {})) {
    if (!raw || typeof raw !== "object" || !raw.chatKey) continue;
    const libraryId = ensureLegacyLibrary(
      state,
      raw.storyId || "默认故事",
      raw.timelineId || "主线",
    );
    state.analysisProgress[progressKey(libraryId, raw.chatKey)] = {
      ...clone(raw),
      libraryId,
    };
  }
  return state;
}

function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("状态文件必须是 JSON 对象。");
  }
  const source = Number(input.version ?? 0) < 3 ? migrateV2(input) : input;
  const state = {
    ...clone(EMPTY_STATE),
    ...clone(source),
    version: 3,
  };
  for (const key of [
    "libraries",
    "cardDefaults",
    "chatBindings",
    "baseProfiles",
    "profileOverrides",
    "baseRelations",
    "profileLocks",
    "relationOverrides",
    "graphPositions",
    "batches",
    "analysisProgress",
  ]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) {
      state[key] = {};
    }
  }
  return state;
}

function resolveLibrary(stateInput, cardKey, chatKey) {
  const state = normalizeState(stateInput);
  const explicit = state.chatBindings[chatBindingKey(cardKey, chatKey)];
  const cardDefault = state.cardDefaults[String(cardKey ?? "")];
  const candidate = explicit?.libraryId
    ? { libraryId: explicit.libraryId, mode: "chat" }
    : cardDefault?.libraryId
      ? { libraryId: cardDefault.libraryId, mode: "card" }
      : { libraryId: "", mode: "unbound" };
  const library = candidate.libraryId ? state.libraries[candidate.libraryId] : null;
  if (!library || library.archived) {
    return { libraryId: "", library: null, mode: "unbound" };
  }
  return { ...candidate, library: clone(library) };
}

function orderedBatches(state, libraryId) {
  return Object.values(state.batches)
    .filter((batch) => batch && batch.status === "committed")
    .filter((batch) => !libraryId || batch.libraryId === libraryId)
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0) ||
      String(a.batchId ?? "").localeCompare(String(b.batchId ?? "")));
}

function createEmptyProfile(libraryId, character) {
  return {
    library_id: libraryId,
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

function materializeProfiles(stateInput, libraryId) {
  if (!libraryId) return {};
  const state = normalizeState(stateInput);
  const profiles = Object.fromEntries(
    Object.entries(state.baseProfiles)
      .filter(([, profile]) => profile.library_id === libraryId)
      .map(([, value]) => [profileKey(libraryId, value.character), clone(value)]),
  );
  for (const batch of orderedBatches(state, libraryId)) {
    for (const update of batch.result?.profile_updates ?? []) {
      if (update.decision !== "update" || !update.proposed_profile) continue;
      const key = profileKey(libraryId, update.character);
      const current = profiles[key] ?? createEmptyProfile(libraryId, update.character);
      const milestoneIds = (update.milestone_candidates ?? []).map(
        (_, index) => `${batch.batchId}:milestone:${normalizeId(update.character)}:${index}`,
      );
      profiles[key] = applyProfileLocks({
        ...current,
        library_id: libraryId,
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
    if (override?.library_id !== libraryId) continue;
    if (override?.active === false) {
      delete profiles[key];
      continue;
    }
    profiles[key] = clone(override);
  }
  return profiles;
}

function allMilestones(stateInput, libraryId) {
  if (!libraryId) return [];
  const state = normalizeState(stateInput);
  const milestones = [];
  for (const batch of orderedBatches(state, libraryId)) {
    for (const update of batch.result?.profile_updates ?? []) {
      if (update.decision !== "update") continue;
      (update.milestone_candidates ?? []).forEach((candidate, index) => {
        milestones.push({
          ...clone(candidate),
          milestone_id: `${batch.batchId}:milestone:${normalizeId(update.character)}:${index}`,
          batch_id: batch.batchId,
          library_id: libraryId,
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
  const key = relationKey(batch.libraryId, change.from, change.to);
  const before = edges[key];
  edges[key] = {
    library_id: batch.libraryId,
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

function materializeRelationships(stateInput, libraryId) {
  if (!libraryId) return {};
  const state = normalizeState(stateInput);
  const edges = Object.fromEntries(
    Object.entries(state.baseRelations)
      .filter(([, edge]) => edge.library_id === libraryId)
      .map(([, value]) => [relationKey(libraryId, value.from, value.to), clone(value)]),
  );
  for (const batch of orderedBatches(state, libraryId)) {
    for (const change of batch.result?.relation_changes ?? []) {
      applyRelationChange(edges, batch, change);
    }
  }
  for (const [key, override] of Object.entries(state.relationOverrides)) {
    if (override?.library_id === libraryId) edges[key] = clone(override);
  }
  return Object.fromEntries(
    Object.entries(edges).filter(([, edge]) => edge.active !== false),
  );
}

function cloneLibraryData(stateInput, sourceLibraryId, targetLibrary) {
  const state = normalizeState(stateInput);
  if (!state.libraries[sourceLibraryId]) throw new Error("找不到要克隆的档案库。");
  state.libraries[targetLibrary.id] = clone(targetLibrary);
  const copyMap = (source, target, kind) => {
    for (const value of Object.values(source)) {
      if (value?.library_id !== sourceLibraryId) continue;
      const copied = { ...clone(value), library_id: targetLibrary.id };
      const key = kind === "relation"
        ? relationKey(targetLibrary.id, copied.from, copied.to)
        : profileKey(targetLibrary.id, copied.character);
      target[key] = copied;
    }
  };
  copyMap(state.baseProfiles, state.baseProfiles, "profile");
  copyMap(state.profileOverrides, state.profileOverrides, "profile");
  copyMap(state.baseRelations, state.baseRelations, "relation");
  copyMap(state.relationOverrides, state.relationOverrides, "relation");
  for (const [key, locks] of Object.entries(state.profileLocks)) {
    if (!key.startsWith(`${normalizeId(sourceLibraryId)}::`)) continue;
    state.profileLocks[key.replace(
      `${normalizeId(sourceLibraryId)}::`,
      `${normalizeId(targetLibrary.id)}::`,
    )] = clone(locks);
  }
  for (const [key, position] of Object.entries(state.graphPositions)) {
    if (!key.startsWith(`${normalizeId(sourceLibraryId)}::`)) continue;
    state.graphPositions[key.replace(
      `${normalizeId(sourceLibraryId)}::`,
      `${normalizeId(targetLibrary.id)}::`,
    )] = clone(position);
  }
  const orderBase = Math.max(0, ...Object.values(state.batches).map((batch) =>
    Number(batch?.order ?? 0)));
  let offset = 0;
  for (const batch of orderedBatches(state, sourceLibraryId)) {
    offset += 1;
    const batchId = `clone:${targetLibrary.id}:${offset}:${crypto.randomUUID()}`;
    state.batches[batchId] = {
      ...clone(batch),
      batchId,
      libraryId: targetLibrary.id,
      order: orderBase + offset,
      clonedFromBatchId: batch.batchId,
    };
  }
  return state;
}

module.exports = {
  EMPTY_STATE,
  allMilestones,
  chatBindingKey,
  cloneLibraryData,
  createLibrary,
  materializeProfiles,
  materializeRelationships,
  normalizeState,
  profileKey,
  progressKey,
  relationKey,
  resolveLibrary,
  valueAtPath,
};
