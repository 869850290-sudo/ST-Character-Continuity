"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { recall } = require("../server/recall.cjs");
const { materializeProfiles, materializeRelationships } = require("../server/state.cjs");

function state() {
  return {
    version: 2,
    baseProfiles: {
      "恶役::主线::傅远平": {
        story_id: "恶役",
        timeline_id: "主线",
        character: "傅远平",
        current_profile: {
          personality: "克制、冷静",
          behavior_pattern: "先观察，再控制局势",
          core_need: "保持自己在Fi计划中的中心位置",
          current_stage: "学习尊重Fi的选择",
        },
        growth_synopsis: "傅远平逐渐把控制改造成协商。",
        residual_patterns: [],
        active_milestone_ids: [],
        version: 1,
      },
      "恶役::主线::牧知傲": {
        story_id: "恶役",
        timeline_id: "主线",
        character: "牧知傲",
        current_profile: {
          personality: "冲动、忠诚",
          behavior_pattern: "开始自行判断后果",
          core_need: "获得Fi认可",
          current_stage: "从服从工具转向同伴",
        },
        growth_synopsis: "牧知傲开始主动承担责任。",
        residual_patterns: [],
        active_milestone_ids: [],
        version: 1,
      },
    },
    baseRelations: {
      "恶役::主线::傅远平→fi": {
        story_id: "恶役",
        timeline_id: "主线",
        from: "傅远平",
        to: "Fi",
        primary_type: "未婚夫",
        tags: ["控制", "克制"],
        attitude: "重视且希望保持中心位置",
        interaction_pattern: "以安排和协商介入Fi的计划",
        visibility: "private",
        strength: 0.9,
        active: true,
        version: 1,
      },
      "恶役::主线::陈耀章→fi": {
        story_id: "恶役",
        timeline_id: "主线",
        from: "陈耀章",
        to: "Fi",
        primary_type: "试探者",
        tags: [],
        attitude: "试图取得文件",
        interaction_pattern: "借行政要求施压",
        visibility: "private",
        strength: 0.5,
        active: true,
        version: 1,
      },
    },
    profileLocks: {},
    relationOverrides: {},
    graphPositions: {},
    batches: {
      a: {
        batchId: "a",
        storyId: "恶役",
        timelineId: "主线",
        order: 1,
        status: "committed",
        acceptedAt: "2026-07-28T00:00:00Z",
        result: {
          profile_updates: [{
            character: "傅远平",
            decision: "update",
            proposed_profile: {
              current_profile: {
                personality: "克制、冷静",
                behavior_pattern: "先观察，再控制局势",
                core_need: "保持自己在Fi计划中的中心位置",
                current_stage: "学习尊重Fi的选择",
              },
              growth_synopsis: "傅远平逐渐把控制改造成协商。",
              residual_patterns: [],
            },
            milestone_candidates: [{
              character: "傅远平",
              title: "克制嫉妒",
              narrative: "傅远平得知Fi准备见牧知傲后没有发怒，而是提出同行。",
              change_trace: "直接控制 → 以协商保持参与",
              evidence: ["他说会陪Fi一起去"],
              time: "2025-05-08",
              location: "高定沙龙",
              related_characters: ["Fi", "牧知傲"],
            }],
          }],
          relation_changes: [],
        },
      },
    },
  };
}

test("按名字取画像，并只带相关人物的一跳关系", () => {
  const result = recall(state(), {
    storyId: "恶役",
    timelineId: "主线",
    text: "傅远平问Fi明天是不是要去见牧知傲。",
    candidateCharacters: ["Fi"],
  });
  assert.deepEqual(
    new Set(result.detectedCharacters),
    new Set(["傅远平", "牧知傲", "Fi"]),
  );
  assert.equal(result.profiles.length, 2);
  assert.equal(result.milestones.length, 1);
  assert.equal(result.relations.length, 1);
  assert.match(result.injection, /傅远平 → Fi/);
  assert.doesNotMatch(result.injection, /陈耀章 → Fi/);
});

test("故事和时间线不匹配时不会误注入", () => {
  const result = recall(state(), {
    storyId: "另一个故事",
    timelineId: "主线",
    text: "傅远平与Fi",
  });
  assert.equal(result.injection, "");
});

test("人工画像覆盖模型结果，并可继续被召回", () => {
  const memory = state();
  memory.profileOverrides ??= {};
  memory.profileOverrides["恶役::主线::牧知傲"] = {
    story_id: "恶役",
    timeline_id: "主线",
    character: "牧知傲",
    current_profile: {
      personality: "人工修订后的性格",
      behavior_pattern: "先观察再行动",
      core_need: "确认自己被主动选择",
      current_stage: "成为有主体性的同伴",
    },
    growth_synopsis: "人工修订后的成长历史。",
    residual_patterns: [],
    active_milestone_ids: [],
    active: true,
    version: 9,
    updated_at: "2026-07-28T00:00:00.000Z",
    last_batch_id: "manual",
    last_source: "人工编辑",
  };

  const profiles = materializeProfiles(memory, "恶役", "主线");
  assert.equal(profiles["恶役::主线::牧知傲"].current_profile.personality, "人工修订后的性格");

  const result = recall(memory, {
    storyId: "恶役",
    timelineId: "主线",
    text: "牧知傲走进房间。",
  });
  assert.match(result.injection, /人工修订后的性格/);
});

test("停用的人工关系不会出现在图谱物化结果中", () => {
  const memory = state();
  memory.relationOverrides ??= {};
  memory.relationOverrides["恶役::主线::傅远平→fi"] = {
    story_id: "恶役",
    timeline_id: "主线",
    from: "傅远平",
    to: "Fi",
    primary_type: "旧关系",
    tags: [],
    attitude: "",
    interaction_pattern: "",
    visibility: "private",
    strength: 0.5,
    active: false,
    version: 2,
  };

  const relations = materializeRelationships(memory, "恶役", "主线");
  assert.equal(relations["恶役::主线::傅远平→fi"], undefined);
});
