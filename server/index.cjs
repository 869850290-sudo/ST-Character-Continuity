"use strict";

const path = require("node:path");
const { recall } = require("./recall.cjs");
const { StateStore } = require("./store.cjs");
const {
  allMilestones,
  materializeProfiles,
  materializeRelationships,
  profileKey,
  relationKey,
} = require("./state.cjs");

const DATA_ROOT = path.join(__dirname, "..", "data");
const store = new StateStore(DATA_ROOT);

function errorResponse(res, error) {
  console.error("[Character Continuity]", error);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function text(value, maxLength = 20_000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function stringList(value, maxItems = 40) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => text(item, 300)).filter(Boolean)
    : [];
}

function normalizeResidualPatterns(value) {
  return Array.isArray(value)
    ? value.slice(0, 30).map((item) => ({
      trigger: text(item?.trigger, 500),
      likely_response: text(item?.likely_response, 1_000),
      counterweight: text(item?.counterweight, 1_000),
      evidence: stringList(item?.evidence, 20),
    })).filter((item) => item.trigger || item.likely_response || item.counterweight)
    : [];
}

function profileFromRequest(raw) {
  const storyId = text(raw?.story_id, 200);
  const timelineId = text(raw?.timeline_id, 200);
  const character = text(raw?.character, 200);
  if (!storyId || !timelineId || !character) {
    throw new Error("人物画像缺少故事、时间线或人物姓名。");
  }
  return {
    story_id: storyId,
    timeline_id: timelineId,
    character,
    current_profile: {
      personality: text(raw?.current_profile?.personality),
      behavior_pattern: text(raw?.current_profile?.behavior_pattern),
      core_need: text(raw?.current_profile?.core_need),
      current_stage: text(raw?.current_profile?.current_stage),
    },
    growth_synopsis: text(raw?.growth_synopsis, 50_000),
    residual_patterns: normalizeResidualPatterns(raw?.residual_patterns),
    active_milestone_ids: stringList(raw?.active_milestone_ids, 500),
    active: true,
    version: Math.max(1, Number(raw?.version ?? 0) + 1),
    updated_at: new Date().toISOString(),
    last_batch_id: "manual",
    last_source: "人物连续性工作台人工编辑",
  };
}

function relationFromRequest(raw) {
  const storyId = text(raw?.story_id, 200);
  const timelineId = text(raw?.timeline_id, 200);
  const from = text(raw?.from, 200);
  const to = text(raw?.to, 200);
  if (!storyId || !timelineId || !from || !to) {
    throw new Error("人物关系缺少故事、时间线或关系两端。");
  }
  if (from === to) throw new Error("同一个人不能与自己建立关系。");
  const strength = Number(raw?.strength);
  return {
    story_id: storyId,
    timeline_id: timelineId,
    from,
    to,
    primary_type: text(raw?.primary_type, 300) || "未命名关系",
    tags: stringList(raw?.tags, 30),
    attitude: text(raw?.attitude, 20_000),
    interaction_pattern: text(raw?.interaction_pattern, 20_000),
    visibility: ["public", "known_to_from", "private", "author_only"].includes(raw?.visibility)
      ? raw.visibility
      : "private",
    strength: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0.5,
    active: true,
    version: Math.max(1, Number(raw?.version ?? 0) + 1),
    updated_at: new Date().toISOString(),
    last_batch_id: "manual",
  };
}

function workspacePayload(state, storyId, timelineId) {
  return {
    storyId,
    timelineId,
    profiles: materializeProfiles(state, storyId, timelineId),
    milestones: allMilestones(state, storyId, timelineId),
    relations: materializeRelationships(state, storyId, timelineId),
    graphPositions: state.graphPositions,
    counts: {
      batches: Object.values(state.batches).filter((batch) => batch?.status === "committed").length,
    },
  };
}

async function init(router) {
  await store.initialize();

  router.post("/health", async (_req, res) => {
    try {
      const state = await store.read();
      res.json({
        success: true,
        version: "0.2.1",
        stateVersion: state.version,
        batches: Object.keys(state.batches).length,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/state/get", async (_req, res) => {
    try {
      res.json({ success: true, state: await store.read() });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/state/replace", async (req, res) => {
    try {
      const serialized = JSON.stringify(req.body?.state ?? {});
      if (serialized.length > 15_000_000) {
        return res.status(413).json({
          success: false,
          error: "状态文件超过 15 MB，请先检查是否误把聊天原文或图片放入状态文件。",
        });
      }
      const state = await store.replace(req.body?.state, req.body?.reason ?? "frontend-import");
      res.json({
        success: true,
        state,
        message: "状态已保存，并自动保留旧版本备份。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/workspace", async (req, res) => {
    try {
      const storyId = text(req.body?.storyId, 200);
      const timelineId = text(req.body?.timelineId, 200);
      const state = await store.read();
      res.json({ success: true, workspace: workspacePayload(state, storyId, timelineId) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/profile/save", async (req, res) => {
    try {
      const state = await store.read();
      const profile = profileFromRequest(req.body?.profile);
      const key = profileKey(profile.story_id, profile.timeline_id, profile.character);
      state.profileOverrides[key] = profile;
      const saved = await store.replace(state, `profile-${profile.character}`);
      res.json({
        success: true,
        profile: materializeProfiles(saved, profile.story_id, profile.timeline_id)[key],
        message: `${profile.character}的画像已保存。`,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/profile/release", async (req, res) => {
    try {
      const state = await store.read();
      const key = profileKey(req.body?.storyId, req.body?.timelineId, req.body?.character);
      delete state.profileOverrides[key];
      const saved = await store.replace(state, `profile-release-${text(req.body?.character, 100)}`);
      res.json({
        success: true,
        profile: materializeProfiles(saved, req.body?.storyId, req.body?.timelineId)[key] ?? null,
        message: "已移除人工覆盖，恢复采用模型生成的画像。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/relation/save", async (req, res) => {
    try {
      const state = await store.read();
      const relation = relationFromRequest(req.body?.relation);
      const previous = req.body?.previous;
      if (previous?.from && previous?.to) {
        const oldKey = relationKey(
          previous.story_id,
          previous.timeline_id,
          previous.from,
          previous.to,
        );
        const newKey = relationKey(
          relation.story_id,
          relation.timeline_id,
          relation.from,
          relation.to,
        );
        if (oldKey !== newKey) {
          state.relationOverrides[oldKey] = {
            ...previous,
            active: false,
            updated_at: new Date().toISOString(),
            last_batch_id: "manual",
          };
        }
      }
      const key = relationKey(
        relation.story_id,
        relation.timeline_id,
        relation.from,
        relation.to,
      );
      state.relationOverrides[key] = relation;
      await store.replace(state, `relation-${relation.from}-${relation.to}`);
      res.json({ success: true, relation, message: "人物关系已保存。" });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/relation/deactivate", async (req, res) => {
    try {
      const state = await store.read();
      const relation = relationFromRequest(req.body?.relation);
      const key = relationKey(
        relation.story_id,
        relation.timeline_id,
        relation.from,
        relation.to,
      );
      state.relationOverrides[key] = {
        ...relation,
        active: false,
        updated_at: new Date().toISOString(),
      };
      await store.replace(state, `relation-off-${relation.from}-${relation.to}`);
      res.json({ success: true, message: "人物关系已停用。" });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/graph/position", async (req, res) => {
    try {
      const storyId = text(req.body?.storyId, 200);
      const timelineId = text(req.body?.timelineId, 200);
      const character = text(req.body?.character, 200);
      const x = Number(req.body?.x);
      const y = Number(req.body?.y);
      if (!storyId || !timelineId || !character || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("关系图坐标不完整。");
      }
      const state = await store.read();
      const key = profileKey(storyId, timelineId, character);
      state.graphPositions[key] = { x: Math.round(x), y: Math.round(y) };
      await store.replace(state, `graph-${character}`, false);
      res.json({ success: true });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/graph/reset", async (req, res) => {
    try {
      const storyId = text(req.body?.storyId, 200);
      const timelineId = text(req.body?.timelineId, 200);
      const prefix = `${profileKey(storyId, timelineId, "").replace(/unknown$/, "")}`;
      const state = await store.read();
      for (const key of Object.keys(state.graphPositions)) {
        if (key.startsWith(prefix)) delete state.graphPositions[key];
      }
      await store.replace(state, "graph-reset", false);
      res.json({ success: true });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/recall", async (req, res) => {
    try {
      const state = await store.read();
      res.json({ success: true, result: recall(state, req.body ?? {}) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  console.log(`[Character Continuity] 后端已启动，数据目录：${DATA_ROOT}`);
}

module.exports = {
  init,
  exit: async () => {},
  info: {
    id: "character-continuity",
    name: "Character Continuity Memory",
    description: "角色画像、成长里程碑与有向关系召回服务。",
  },
};
