"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { runAnalysis } = require("./analysis.cjs");
const { AnalysisConfigStore, publicConfig } = require("./analysis-config.cjs");
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
const analysisConfigStore = new AnalysisConfigStore(DATA_ROOT);
const analysisJobs = new Map();

function progressKey(storyId, timelineId, chatKey) {
  return profileKey(storyId, timelineId, `chat:${chatKey}`);
}

function analysisBatches(state, storyId, timelineId, chatKey) {
  return Object.values(state.batches)
    .filter((batch) => batch?.storyId === storyId && batch?.timelineId === timelineId)
    .filter((batch) => !chatKey || batch.chatKey === chatKey)
    .sort((a, b) => Number(b.order ?? 0) - Number(a.order ?? 0));
}

function contiguousProcessedThrough(batches) {
  let processedThrough = -1;
  const ranges = batches
    .filter((batch) => batch?.status === "committed")
    .map((batch) => ({
      start: Math.max(0, Number(batch.startFloor ?? 0)),
      end: Math.max(0, Number(batch.endFloor ?? -1)),
    }))
    .filter((range) => range.end >= range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const range of ranges) {
    if (range.start > processedThrough + 1) break;
    processedThrough = Math.max(processedThrough, range.end);
  }
  return processedThrough;
}

function cleanupJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of analysisJobs) {
    if (job.updatedAt < cutoff && job.status !== "running") analysisJobs.delete(id);
  }
}

function startAnalysisJob(payload, state, config) {
  cleanupJobs();
  const runningForChat = [...analysisJobs.values()].filter((job) =>
    job.status === "running" &&
    job.payload.storyId === payload.storyId &&
    job.payload.timelineId === payload.timelineId &&
    job.payload.chatKey === payload.chatKey);
  const existing = runningForChat.find((job) =>
    Number(job.payload.startFloor) === Number(payload.startFloor) &&
    Number(job.payload.endFloor) === Number(payload.endFloor));
  if (existing) return existing;
  if (runningForChat.length) {
    throw new Error("当前聊天已有一项人物分析正在进行，请等待它完成后再开始下一段。");
  }

  const job = {
    id: crypto.randomUUID(),
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload,
    result: null,
    error: "",
    accepted: false,
  };
  analysisJobs.set(job.id, job);
  Promise.resolve()
    .then(() => runAnalysis(config, payload, state))
    .then((result) => {
      job.result = result;
      job.status = "completed";
      job.updatedAt = Date.now();
    })
    .catch((error) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.updatedAt = Date.now();
      console.error("[Character Continuity] 人物分析失败：", job.error);
    });
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    accepted: job.accepted,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    payload: {
      chatKey: job.payload.chatKey,
      chatTitle: job.payload.chatTitle,
      startFloor: job.payload.startFloor,
      endFloor: job.payload.endFloor,
      mode: job.payload.mode,
    },
    ...(job.status === "completed" ? {
      result: job.result.result,
      cleanedContext: job.result.cleanedContext,
    } : {}),
  };
}

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

function workspacePayload(state, storyId, timelineId, chatKey = "") {
  const key = chatKey ? progressKey(storyId, timelineId, chatKey) : "";
  return {
    storyId,
    timelineId,
    profiles: materializeProfiles(state, storyId, timelineId),
    milestones: allMilestones(state, storyId, timelineId),
    relations: materializeRelationships(state, storyId, timelineId),
    graphPositions: state.graphPositions,
    progress: key ? state.analysisProgress[key] ?? null : null,
    batches: analysisBatches(state, storyId, timelineId, chatKey).slice(0, 50),
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
        version: "0.3.0",
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
      const chatKey = text(req.body?.chatKey, 500);
      const state = await store.read();
      res.json({
        success: true,
        workspace: workspacePayload(state, storyId, timelineId, chatKey),
      });
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

  router.post("/analysis/config/get", async (_req, res) => {
    try {
      res.json({ success: true, config: publicConfig(await analysisConfigStore.read()) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/analysis/config/save", async (req, res) => {
    try {
      const saved = await analysisConfigStore.save(req.body?.config ?? {});
      res.json({
        success: true,
        config: publicConfig(saved),
        message: "人物分析模型和提示词已保存。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/analysis/start", async (req, res) => {
    try {
      const payload = {
        storyId: text(req.body?.storyId, 200),
        timelineId: text(req.body?.timelineId, 200),
        chatKey: text(req.body?.chatKey, 500),
        chatTitle: text(req.body?.chatTitle, 500),
        startFloor: Math.max(0, Number(req.body?.startFloor ?? 0)),
        endFloor: Math.max(0, Number(req.body?.endFloor ?? 0)),
        mode: req.body?.mode === "auto" ? "auto" : "manual",
        priorityCharacters: stringList(req.body?.priorityCharacters, 100),
        messages: Array.isArray(req.body?.messages)
          ? req.body.messages.slice(0, 500).map((message, index) => ({
            floor: Math.max(0, Number(message?.floor ?? index)),
            is_user: Boolean(message?.is_user),
            name: text(message?.name, 300),
            send_date: text(message?.send_date, 500),
            mes: text(message?.mes, 500_000),
          }))
          : [],
      };
      if (!payload.storyId || !payload.timelineId || !payload.chatKey) {
        throw new Error("人物分析缺少故事、时间线或聊天标识。");
      }
      if (payload.endFloor < payload.startFloor) {
        throw new Error("终点楼层不能小于起始楼层。");
      }
      const selected = payload.messages.filter((message) =>
        message.floor >= payload.startFloor && message.floor <= payload.endFloor);
      if (!selected.length) throw new Error("所选楼层没有可分析的聊天内容。");
      payload.messages = selected;
      const job = startAnalysisJob(
        payload,
        await store.read(),
        await analysisConfigStore.read(),
      );
      res.status(202).json({ success: true, job: publicJob(job) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/analysis/status", async (req, res) => {
    try {
      cleanupJobs();
      const job = analysisJobs.get(text(req.body?.jobId, 200));
      if (!job) return res.status(404).json({ success: false, error: "分析任务不存在或已过期。" });
      res.json({ success: true, job: publicJob(job) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/analysis/accept", async (req, res) => {
    try {
      const job = analysisJobs.get(text(req.body?.jobId, 200));
      if (!job) return res.status(404).json({ success: false, error: "分析任务不存在或已过期。" });
      if (job.status !== "completed") throw new Error("分析尚未完成，暂时不能采纳。");
      if (job.accepted) throw new Error("这次分析已经采纳过了。");
      const state = await store.read();
      const batches = Object.values(state.batches);
      const order = Math.max(0, ...batches.map((batch) => Number(batch?.order ?? 0))) + 1;
      const acceptedAt = new Date().toISOString();
      const batchId = `analysis:${acceptedAt}:${job.id}`;
      state.batches[batchId] = {
        batchId,
        rangeKey: `${job.payload.chatKey}:${job.payload.startFloor}-${job.payload.endFloor}`,
        runId: job.id,
        storyId: job.payload.storyId,
        timelineId: job.payload.timelineId,
        chatKey: job.payload.chatKey,
        fileName: job.payload.chatTitle || job.payload.chatKey,
        range: `${job.payload.startFloor}-${job.payload.endFloor}`,
        startFloor: job.payload.startFloor,
        endFloor: job.payload.endFloor,
        mode: job.payload.mode,
        acceptedAt,
        order,
        status: "committed",
        previousRuns: [],
        result: job.result.result,
      };
      const key = progressKey(job.payload.storyId, job.payload.timelineId, job.payload.chatKey);
      const committed = analysisBatches(
        state,
        job.payload.storyId,
        job.payload.timelineId,
        job.payload.chatKey,
      ).filter((batch) => batch.status === "committed");
      state.analysisProgress[key] = {
        storyId: job.payload.storyId,
        timelineId: job.payload.timelineId,
        chatKey: job.payload.chatKey,
        chatTitle: job.payload.chatTitle,
        processedThrough: contiguousProcessedThrough(committed),
        sequence: committed.length,
        lastBatchId: batchId,
        lastRunAt: acceptedAt,
        lastStatus: "success",
        lastError: "",
      };
      const saved = await store.replace(state, `analysis-${job.payload.startFloor}-${job.payload.endFloor}`);
      job.accepted = true;
      job.updatedAt = Date.now();
      res.json({
        success: true,
        batch: saved.batches[batchId],
        progress: saved.analysisProgress[key],
        message: `已采纳 ${job.payload.startFloor}-${job.payload.endFloor} 楼的人物更新。`,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/analysis/batch/revert", async (req, res) => {
    try {
      const batchId = text(req.body?.batchId, 1000);
      const state = await store.read();
      const batch = state.batches[batchId];
      if (!batch) return res.status(404).json({ success: false, error: "没有找到这批人物更新。" });
      batch.status = "reverted";
      batch.revertedAt = new Date().toISOString();
      const remaining = analysisBatches(
        state,
        batch.storyId,
        batch.timelineId,
        batch.chatKey,
      ).filter((item) => item.status === "committed" && item.batchId !== batchId);
      const key = progressKey(batch.storyId, batch.timelineId, batch.chatKey);
      state.analysisProgress[key] = {
        ...(state.analysisProgress[key] ?? {}),
        processedThrough: contiguousProcessedThrough(remaining),
        sequence: remaining.length,
        lastBatchId: remaining[0]?.batchId ?? "",
        lastRunAt: new Date().toISOString(),
        lastStatus: "reverted",
        lastError: "",
      };
      await store.replace(state, `revert-${batchId}`);
      res.json({ success: true, message: "这批人物更新已撤回，旧版本备份仍保留。" });
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
  __test: {
    contiguousProcessedThrough,
  },
};
