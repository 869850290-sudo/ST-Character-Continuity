"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  chatBindingKey,
  cloneLibraryData,
  createLibrary,
  materializeProfiles,
  normalizeState,
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
