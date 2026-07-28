"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  allMilestones,
  chatBindingKey,
  cloneLibraryData,
  createLibrary,
  materializeProfiles,
  materializeRelationships,
  normalizeState,
  renameCharacter,
  resolveLibrary,
} = require("../server/state.cjs");

function library(id, name) {
  return {
    id,
    name,
    description: "",
    archived: false,
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
  };
}

test("聊天显式绑定优先于角色卡默认，单独解绑后回退默认库", () => {
  const state = normalizeState({
    version: 3,
    libraries: {
      default: library("default", "卡默认"),
      branch: library("branch", "聊天分支"),
    },
    cardDefaults: {
      "character:a.png": { libraryId: "default" },
    },
    chatBindings: {
      [chatBindingKey("character:a.png", "chat-a")]: {
        cardKey: "character:a.png",
        chatKey: "chat-a",
        libraryId: "branch",
      },
    },
  });
  assert.deepEqual(
    resolveLibrary(state, "character:a.png", "chat-a"),
    { libraryId: "branch", library: state.libraries.branch, mode: "chat" },
  );
  delete state.chatBindings[chatBindingKey("character:a.png", "chat-a")];
  assert.equal(resolveLibrary(state, "character:a.png", "chat-a").libraryId, "default");
  assert.equal(resolveLibrary(state, "character:a.png", "chat-a").mode, "card");
});

test("多个聊天可共享一库，解绑其中一个不影响其他聊天", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享库") },
    chatBindings: {
      [chatBindingKey("character:a.png", "chat-a")]: { libraryId: "shared" },
      [chatBindingKey("character:a.png", "chat-b")]: { libraryId: "shared" },
    },
  });
  delete state.chatBindings[chatBindingKey("character:a.png", "chat-a")];
  assert.equal(resolveLibrary(state, "character:a.png", "chat-a").mode, "unbound");
  assert.equal(resolveLibrary(state, "character:a.png", "chat-b").libraryId, "shared");
});

test("克隆档案库复制人物内容，但后续修改互不影响", () => {
  const state = normalizeState({
    version: 3,
    libraries: { source: library("source", "主线") },
    baseProfiles: {
      "source::牧知傲": {
        library_id: "source",
        character: "牧知傲",
        current_profile: { personality: "冲动" },
      },
    },
  });
  const target = createLibrary({ name: "平行世界", sourceLibraryId: "source" });
  const cloned = cloneLibraryData(state, "source", target);
  const copied = materializeProfiles(cloned, target.id);
  assert.equal(Object.values(copied)[0].current_profile.personality, "冲动");
  Object.values(copied)[0].current_profile.personality = "冷静";
  assert.equal(
    Object.values(materializeProfiles(cloned, "source"))[0].current_profile.personality,
    "冲动",
  );
});

test("共享档案库会合并不同聊天的更新，克隆后保留已采纳历史", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享主线") },
    batches: {
      chatA: {
        batchId: "chatA",
        libraryId: "shared",
        chatKey: "chat-a",
        order: 1,
        status: "committed",
        acceptedAt: "2026-07-29T01:00:00Z",
        result: {
          profile_updates: [{
            character: "牧知傲",
            decision: "update",
            proposed_profile: {
              current_profile: { personality: "冲动、忠诚" },
              growth_synopsis: "开始主动判断。",
              residual_patterns: [],
            },
          }],
        },
      },
      chatB: {
        batchId: "chatB",
        libraryId: "shared",
        chatKey: "chat-b",
        order: 2,
        status: "committed",
        acceptedAt: "2026-07-29T02:00:00Z",
        result: {
          profile_updates: [{
            character: "牧知傲",
            decision: "update",
            proposed_profile: {
              current_profile: { personality: "直接、忠诚，正在萌生自主判断" },
              growth_synopsis: "开始主动判断，并愿意承担擅自行动的后果。",
              residual_patterns: ["受到刺激时仍会寻求明确命令"],
            },
          }],
        },
      },
    },
  });
  const sharedProfile = Object.values(materializeProfiles(state, "shared"))[0];
  assert.equal(sharedProfile.version, 2);
  assert.match(sharedProfile.current_profile.personality, /自主判断/);

  const target = createLibrary({ name: "平行世界", sourceLibraryId: "shared" });
  const cloned = cloneLibraryData(state, "shared", target);
  const clonedProfile = Object.values(materializeProfiles(cloned, target.id))[0];
  assert.equal(clonedProfile.version, 2);
  assert.match(clonedProfile.growth_synopsis, /承担/);
  assert.equal(
    Object.values(cloned.batches).filter((batch) => batch.libraryId === target.id).length,
    2,
  );
});

test("旧版故事与时间线状态会迁移为独立档案库", () => {
  const migrated = normalizeState({
    version: 2,
    baseProfiles: {
      "恶役::主线::牧知傲": {
        story_id: "恶役",
        timeline_id: "主线",
        character: "牧知傲",
        current_profile: {},
      },
    },
  });
  assert.equal(migrated.version, 3);
  assert.equal(Object.keys(migrated.libraries).length, 1);
  const profile = Object.values(migrated.baseProfiles)[0];
  assert.ok(profile.library_id);
  assert.equal(profile.story_id, undefined);
});

test("人物登记册为无成长的重要角色建立基础档案，纯工具人不建档", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享人物库") },
    batches: {
      census: {
        batchId: "census",
        libraryId: "shared",
        status: "committed",
        order: 1,
        acceptedAt: "2026-07-29T00:00:00Z",
        fileName: "测试聊天",
        range: "0-9",
        result: {
          character_registry: [{
            character: "兰芝高中·秘书长",
            aliases: ["秘书长"],
            identity_status: "title_only",
            retention_tier: "watchlist",
            narrative_role: "antagonist",
            reason: "当前反派，冲突尚未解决。",
          }, {
            character: "会场·服务员A",
            aliases: ["服务员"],
            identity_status: "ambiguous",
            retention_tier: "ephemeral",
            narrative_role: "extra",
          }],
          profile_updates: [],
          relation_changes: [],
        },
      },
    },
  });
  const profiles = Object.values(materializeProfiles(state, "shared"));
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].character, "兰芝高中·秘书长");
  assert.equal(profiles[0].retention_tier, "watchlist");
  assert.equal(profiles[0].current_profile.current_stage, "");
});

test("人物改名会同步画像、成长记录、关系和人工配置", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享主线") },
    baseProfiles: {
      "shared::旧名": {
        library_id: "shared",
        character: "旧名",
        current_profile: { personality: "冷静" },
      },
    },
    profileOverrides: {
      "shared::旧名": {
        library_id: "shared",
        character: "旧名",
        current_profile: { personality: "人工版本" },
        active_milestone_ids: ["batch-1:milestone:旧名:0"],
        active: true,
      },
    },
    baseRelations: {
      "shared::旧名→同伴": {
        library_id: "shared",
        from: "旧名",
        to: "同伴",
        active: true,
      },
    },
    relationOverrides: {
      "shared::同伴→旧名": {
        library_id: "shared",
        from: "同伴",
        to: "旧名",
        active: true,
      },
    },
    profileLocks: {
      "shared::旧名": { "current_profile.personality": "锁定性格" },
    },
    graphPositions: {
      "shared::旧名": { x: 100, y: 200 },
    },
    batches: {
      "batch-1": {
        batchId: "batch-1",
        libraryId: "shared",
        order: 1,
        status: "committed",
        acceptedAt: "2026-07-29T01:00:00Z",
        result: {
          character_audit: [{ character: "旧名" }],
          profile_updates: [{
            character: "旧名",
            decision: "update",
            proposed_profile: {
              current_profile: { personality: "成长后" },
              growth_synopsis: "成长记录",
              residual_patterns: [],
            },
            milestone_candidates: [{
              character: "旧名",
              title: "第一次改变",
              narrative: "人物发生改变。",
              change_trace: "旧模式到新模式",
              related_characters: ["旧名", "同伴"],
            }],
          }],
          relation_changes: [{
            decision: "update",
            from: "旧名",
            to: "同伴",
          }],
        },
      },
    },
  });

  const renamed = renameCharacter(state, "shared", "旧名", "新名");
  const profiles = Object.values(materializeProfiles(renamed, "shared"));
  const milestones = allMilestones(renamed, "shared");
  const relations = Object.values(materializeRelationships(renamed, "shared"));

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].character, "新名");
  assert.ok(profiles[0].active_milestone_ids.includes("batch-1:milestone:新名:0"));
  assert.equal(milestones[0].character, "新名");
  assert.deepEqual(milestones[0].related_characters, ["新名", "同伴"]);
  assert.ok(relations.every((edge) => edge.from !== "旧名" && edge.to !== "旧名"));
  assert.ok(renamed.profileLocks["shared::新名"]);
  assert.ok(renamed.graphPositions["shared::新名"]);
  assert.equal(renamed.batches["batch-1"].result.character_audit[0].character, "新名");
});

test("旧后端误建的同内容人物可在改名时安全合并", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享主线") },
    baseProfiles: {
      "shared::错误名字": {
        library_id: "shared",
        character: "错误名字",
        current_profile: {
          personality: "冷静",
          behavior_pattern: "谨慎",
          core_need: "安全",
          current_stage: "观察期",
        },
        growth_synopsis: "同一份成长记录",
        residual_patterns: [],
        active_milestone_ids: [],
      },
    },
    profileOverrides: {
      "shared::正确名字": {
        library_id: "shared",
        character: "正确名字",
        current_profile: {
          personality: "冷静",
          behavior_pattern: "谨慎",
          core_need: "安全",
          current_stage: "观察期",
        },
        growth_synopsis: "同一份成长记录",
        residual_patterns: [],
        active_milestone_ids: [],
        active: true,
        last_batch_id: "manual",
      },
    },
    baseRelations: {
      "shared::错误名字→同伴": {
        library_id: "shared",
        from: "错误名字",
        to: "同伴",
        active: true,
      },
    },
  });

  assert.throws(
    () => renameCharacter(state, "shared", "错误名字", "正确名字"),
    /已经存在/,
  );

  const repaired = renameCharacter(
    state,
    "shared",
    "错误名字",
    "正确名字",
    { mergeDuplicate: true },
  );
  const profiles = Object.values(materializeProfiles(repaired, "shared"));
  const relations = Object.values(materializeRelationships(repaired, "shared"));

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].character, "正确名字");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].from, "正确名字");
  assert.equal(repaired.profileOverrides["shared::错误名字"], undefined);
});

test("同名目标有独立内容时不会被自动合并", () => {
  const state = normalizeState({
    version: 3,
    libraries: { shared: library("shared", "共享主线") },
    baseProfiles: {
      "shared::甲": {
        library_id: "shared",
        character: "甲",
        current_profile: { personality: "冷静" },
      },
    },
    profileOverrides: {
      "shared::乙": {
        library_id: "shared",
        character: "乙",
        current_profile: { personality: "热情" },
        active: true,
      },
    },
  });

  assert.throws(
    () => renameCharacter(state, "shared", "甲", "乙", { mergeDuplicate: true }),
    /已经存在/,
  );
});
