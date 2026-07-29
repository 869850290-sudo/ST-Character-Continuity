"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  bm25Score,
  buildSearchModel,
  estimateTokens,
  recall,
  textTokens,
} = require("../server/recall.cjs");
const { materializeProfiles, materializeRelationships } = require("../server/state.cjs");

const LIBRARY_ID = "library-main";

function state() {
  return {
    version: 3,
    libraries: {
      [LIBRARY_ID]: {
        id: LIBRARY_ID,
        name: "恶役主线",
        description: "",
        archived: false,
      },
    },
    cardDefaults: {},
    chatBindings: {},
    baseProfiles: {
      [`${LIBRARY_ID}::傅远平`]: {
        library_id: LIBRARY_ID,
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
      [`${LIBRARY_ID}::牧知傲`]: {
        library_id: LIBRARY_ID,
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
      [`${LIBRARY_ID}::傅远平→fi`]: {
        library_id: LIBRARY_ID,
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
      [`${LIBRARY_ID}::陈耀章→fi`]: {
        library_id: LIBRARY_ID,
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
    analysisProgress: {},
    batches: {
      a: {
        batchId: "a",
        libraryId: LIBRARY_ID,
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
    libraryId: LIBRARY_ID,
    text: "傅远平问Fi明天是不是要去见牧知傲。",
    candidateCharacters: ["Fi"],
  });
  assert.deepEqual(new Set(result.detectedCharacters), new Set(["傅远平", "牧知傲", "Fi"]));
  assert.equal(result.profiles.length, 2);
  assert.equal(result.milestones.length, 1);
  assert.equal(result.relations.length, 1);
  assert.match(result.injection, /傅远平 → Fi/);
  assert.doesNotMatch(result.injection, /陈耀章 → Fi/);
});

test("档案库不匹配或未绑定时不会误注入", () => {
  assert.equal(recall(state(), { libraryId: "another", text: "傅远平与Fi" }).injection, "");
  assert.equal(recall(state(), { libraryId: "", text: "傅远平与Fi" }).injection, "");
});

test("人工画像覆盖模型结果，并可继续被召回", () => {
  const memory = state();
  memory.profileOverrides ??= {};
  memory.profileOverrides[`${LIBRARY_ID}::牧知傲`] = {
    library_id: LIBRARY_ID,
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
  const profiles = materializeProfiles(memory, LIBRARY_ID);
  assert.equal(profiles[`${LIBRARY_ID}::牧知傲`].current_profile.personality, "人工修订后的性格");
  assert.match(recall(memory, {
    libraryId: LIBRARY_ID,
    text: "牧知傲走进房间。",
  }).injection, /人工修订后的性格/);
});

test("停用的人工关系不会出现在图谱物化结果中", () => {
  const memory = state();
  memory.relationOverrides[`${LIBRARY_ID}::傅远平→fi`] = {
    library_id: LIBRARY_ID,
    from: "傅远平",
    to: "Fi",
    primary_type: "旧关系",
    active: false,
  };
  const relations = materializeRelationships(memory, LIBRARY_ID);
  assert.equal(relations[`${LIBRARY_ID}::傅远平→fi`], undefined);
});

test("召回按真实基础上下文动态计算 token 预算", () => {
  const roomy = recall(state(), {
    libraryId: LIBRARY_ID,
    text: "傅远平问Fi明天是不是要去见牧知傲。",
    candidateCharacters: ["Fi"],
    baseContextTokens: 22000,
    attentionCeilingTokens: 36000,
    recallMaxTokens: 5000,
    safetyReserveTokens: 4000,
    contextSizeExact: true,
  });
  assert.equal(roomy.stats.tokenBudget, 5000);
  assert.equal(roomy.stats.contextSizeExact, true);
  assert.ok(roomy.stats.estimatedTokens <= roomy.stats.tokenBudget);
  assert.equal(
    roomy.stats.projectedInputTokens,
    roomy.stats.baseContextTokens + roomy.stats.estimatedTokens,
  );

  const tight = recall(state(), {
    libraryId: LIBRARY_ID,
    text: "傅远平问Fi。",
    baseContextTokens: 30500,
    attentionCeilingTokens: 36000,
    recallMaxTokens: 5000,
    safetyReserveTokens: 4000,
  });
  assert.equal(tight.stats.tokenBudget, 1500);
  assert.equal(tight.stats.mode, "layered");
  assert.ok(tight.stats.estimatedTokens <= 1500);

  const blocked = recall(state(), {
    libraryId: LIBRARY_ID,
    text: "傅远平问Fi。",
    baseContextTokens: 33000,
    attentionCeilingTokens: 36000,
    recallMaxTokens: 5000,
    safetyReserveTokens: 4000,
  });
  assert.equal(blocked.stats.mode, "blocked");
  assert.equal(blocked.injection, "");
});

test("详细档案保留与当前正文最相关的后段行为细节", () => {
  const memory = state();
  const profile = memory.baseProfiles[`${LIBRARY_ID}::傅远平`];
  profile.current_profile.personality = [
    "他通常保持礼貌。",
    ..."一二三四五六七八九十".split("").map((item) => `无关背景${item}保持稳定。`),
    "面对谈判时，他会故意让对手先表态，从而观察对方暴露的底牌。",
  ].join("");
  memory.batches.a.result.profile_updates[0].proposed_profile.current_profile.personality =
    profile.current_profile.personality;
  const result = recall(memory, {
    libraryId: LIBRARY_ID,
    text: "傅远平让对手先表态，等对方暴露底牌。",
    baseContextTokens: 30000,
    attentionCeilingTokens: 36000,
    recallMaxTokens: 5000,
    safetyReserveTokens: 4000,
  });
  assert.match(result.injection, /让对手先表态/);
  assert.ok(estimateTokens(result.injection) <= result.stats.tokenBudget);
  assert.doesNotMatch(result.injection, /成长脉络：傅远平逐渐把控制改造成协商/);
});

test("不同可用预算下召回都不会突破自己的 token 硬上限", () => {
  for (const baseContextTokens of [22000, 27000, 29000, 30000, 30500, 31000, 32000]) {
    const result = recall(state(), {
      libraryId: LIBRARY_ID,
      text: "傅远平、牧知傲和Fi正在讨论下一步安排。",
      candidateCharacters: ["Fi"],
      baseContextTokens,
      attentionCeilingTokens: 36000,
      recallMaxTokens: 5000,
      safetyReserveTokens: 4000,
    });
    assert.ok(
      result.stats.estimatedTokens <= result.stats.tokenBudget,
      `${baseContextTokens} 基础 tokens 时召回超过预算`,
    );
    assert.ok(
      result.stats.projectedInputTokens <= 32000,
      `${baseContextTokens} 基础 tokens 时没有保留 4000 安全余量`,
    );
  }
});

test("画像字段中的重复描述不会被反复注入", () => {
  const memory = state();
  const repeated = "遇到压力时先观察局势，再通过具体行动控制风险。";
  memory.batches.a.result.profile_updates[0].proposed_profile.current_profile.personality = repeated;
  memory.batches.a.result.profile_updates[0].proposed_profile.current_profile.behavior_pattern = repeated;
  const result = recall(memory, {
    libraryId: LIBRARY_ID,
    text: "傅远平正在观察局势。",
    baseContextTokens: 22000,
  });
  assert.equal(result.injection.match(/遇到压力时先观察局势/g)?.length, 1);
});

test("本地 BM25 会优先选择含有本轮稀有线索的资料", () => {
  const documents = [
    "傅远平平时维持礼貌并安排日常事务",
    "傅远平发现暗号账本后立刻封锁书房",
    "牧知傲在训练场等待新的命令",
  ];
  const model = buildSearchModel(documents);
  const query = textTokens("书房里出现了那本暗号账本");
  assert.ok(
    bm25Score(query, documents[1], model) > bm25Score(query, documents[0], model),
  );
});

test("混合召回同时保留人物核心基座与本轮相关细节", () => {
  const memory = state();
  const personality = [
    "他始终克制情绪，先观察再行动。",
    "一旦发现暗号账本，就会封锁书房并单独核对知情者。",
  ].join("");
  memory.baseProfiles[`${LIBRARY_ID}::傅远平`].current_profile.personality = personality;
  memory.batches.a.result.profile_updates[0].proposed_profile.current_profile.personality =
    personality;
  const result = recall(memory, {
    libraryId: LIBRARY_ID,
    text: "傅远平在书房发现了暗号账本。",
    baseContextTokens: 30000,
    attentionCeilingTokens: 36000,
    recallMaxTokens: 5000,
    safetyReserveTokens: 4000,
  });
  assert.match(result.injection, /始终克制情绪/);
  assert.match(result.injection, /暗号账本/);
  assert.equal(result.stats.retrievalMode, "local_hybrid_bm25");
  assert.ok(result.stats.scannedItems > 0);
  assert.ok(result.stats.retrievalMs >= 0);
});
