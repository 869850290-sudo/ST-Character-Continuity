"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { runAnalysis } = require("./analysis.cjs");
const { AnalysisConfigStore, publicConfig } = require("./analysis-config.cjs");
const { recall } = require("./recall.cjs");
const { StateStore } = require("./store.cjs");
const {
  allMilestones,
  chatBindingKey,
  cloneLibraryData,
  createLibrary,
  materializeProfiles,
  materializeRelationships,
  profileKey,
  progressKey,
  relationKey,
  resolveLibrary,
} = require("./state.cjs");

const DATA_ROOT = path.join(__dirname, "..", "data");
const store = new StateStore(DATA_ROOT);
const analysisConfigStore = new AnalysisConfigStore(DATA_ROOT);
const analysisJobs = new Map();

function analysisBatches(state, libraryId, chatKey) {
  return Object.values(state.batches)
    .filter((batch) => batch?.libraryId === libraryId)
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
    job.payload.libraryId === payload.libraryId &&
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
  const libraryId = text(raw?.library_id, 200);
  const character = text(raw?.character, 200);
  if (!libraryId || !character) {
    throw new Error("人物画像缺少档案库或人物姓名。");
  }
  return {
    library_id: libraryId,
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
  const libraryId = text(raw?.library_id, 200);
  const from = text(raw?.from, 200);
  const to = text(raw?.to, 200);
  if (!libraryId || !from || !to) {
    throw new Error("人物关系缺少档案库或关系两端。");
  }
  if (from === to) throw new Error("同一个人不能与自己建立关系。");
  const strength = Number(raw?.strength);
  return {
    library_id: libraryId,
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

function workspacePayload(state, cardKey, cardName, chatKey = "", chatTitle = "") {
  const binding = resolveLibrary(state, cardKey, chatKey);
  const libraryId = binding.libraryId;
  const explicitBinding = state.chatBindings[chatBindingKey(cardKey, chatKey)];
  const cardDefault = state.cardDefaults[cardKey];
  const key = libraryId && chatKey ? progressKey(libraryId, chatKey) : "";
  return {
    context: { cardKey, cardName, chatKey, chatTitle },
    binding: {
      mode: binding.mode,
      libraryId,
      library: binding.library,
    },
    explicitLibraryId: explicitBinding?.libraryId ?? "",
    cardDefaultLibraryId: cardDefault?.libraryId ?? "",
    libraries: Object.values(state.libraries)
      .filter((library) => !library.archived)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
    profiles: materializeProfiles(state, libraryId),
    milestones: allMilestones(state, libraryId),
    relations: materializeRelationships(state, libraryId),
    graphPositions: state.graphPositions,
    progress: key ? state.analysisProgress[key] ?? null : null,
    batches: libraryId ? analysisBatches(state, libraryId).slice(0, 50) : [],
    counts: {
      batches: libraryId
        ? analysisBatches(state, libraryId).filter(
          (batch) => batch?.status === "committed",
        ).length
        : 0,
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
        version: "0.4.0",
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
      const cardKey = text(req.body?.cardKey, 500);
      const cardName = text(req.body?.cardName, 500);
      const chatKey = text(req.body?.chatKey, 500);
      const chatTitle = text(req.body?.chatTitle, 500);
      const state = await store.read();
      res.json({
        success: true,
        workspace: workspacePayload(state, cardKey, cardName, chatKey, chatTitle),
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/library/create", async (req, res) => {
    try {
      const state = await store.read();
      const library = createLibrary({
        name: text(req.body?.name, 200),
        description: text(req.body?.description, 2000),
      });
      state.libraries[library.id] = library;
      const saved = await store.replace(state, `library-create-${library.id}`);
      res.json({
        success: true,
        library: saved.libraries[library.id],
        message: `已创建档案库“${library.name}”。`,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/library/clone", async (req, res) => {
    try {
      const state = await store.read();
      const sourceLibraryId = text(req.body?.sourceLibraryId, 200);
      const source = state.libraries[sourceLibraryId];
      if (!source) throw new Error("找不到要克隆的档案库。");
      const library = createLibrary({
        name: text(req.body?.name, 200) || `${source.name}（副本）`,
        description: text(req.body?.description, 2000) || source.description,
        sourceLibraryId,
      });
      const cloned = cloneLibraryData(state, sourceLibraryId, library);
      const saved = await store.replace(cloned, `library-clone-${library.id}`);
      res.json({
        success: true,
        library: saved.libraries[library.id],
        message: `已克隆为“${library.name}”，之后两套资料会各自更新。`,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/library/update", async (req, res) => {
    try {
      const state = await store.read();
      const libraryId = text(req.body?.libraryId, 200);
      const library = state.libraries[libraryId];
      if (!library) throw new Error("找不到要修改的档案库。");
      library.name = text(req.body?.name, 200) || library.name;
      library.description = text(req.body?.description, 2000);
      library.updated_at = new Date().toISOString();
      const saved = await store.replace(state, `library-update-${libraryId}`);
      res.json({
        success: true,
        library: saved.libraries[libraryId],
        message: "档案库资料已保存。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/binding/chat/set", async (req, res) => {
    try {
      const state = await store.read();
      const cardKey = text(req.body?.cardKey, 500);
      const chatKey = text(req.body?.chatKey, 500);
      const libraryId = text(req.body?.libraryId, 200);
      if (!cardKey || !chatKey || !state.libraries[libraryId]) {
        throw new Error("当前角色卡、聊天或档案库信息不完整。");
      }
      state.chatBindings[chatBindingKey(cardKey, chatKey)] = {
        cardKey,
        chatKey,
        libraryId,
        boundAt: new Date().toISOString(),
      };
      const saved = await store.replace(state, `bind-chat-${chatKey}`);
      res.json({
        success: true,
        workspace: workspacePayload(
          saved,
          cardKey,
          text(req.body?.cardName, 500),
          chatKey,
          text(req.body?.chatTitle, 500),
        ),
        message: "当前聊天已绑定到所选档案库。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/binding/chat/unset", async (req, res) => {
    try {
      const state = await store.read();
      const cardKey = text(req.body?.cardKey, 500);
      const chatKey = text(req.body?.chatKey, 500);
      delete state.chatBindings[chatBindingKey(cardKey, chatKey)];
      const saved = await store.replace(state, `unbind-chat-${chatKey}`);
      const resolved = resolveLibrary(saved, cardKey, chatKey);
      res.json({
        success: true,
        binding: resolved,
        message: resolved.mode === "card"
          ? "已解除当前聊天的单独绑定，现改用角色卡默认档案库。"
          : "已解除当前聊天绑定；现在不会写入或注入人物资料。",
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/binding/card/set", async (req, res) => {
    try {
      const state = await store.read();
      const cardKey = text(req.body?.cardKey, 500);
      const libraryId = text(req.body?.libraryId, 200);
      if (!cardKey || !state.libraries[libraryId]) {
        throw new Error("当前角色卡或档案库信息不完整。");
      }
      state.cardDefaults[cardKey] = {
        cardKey,
        libraryId,
        boundAt: new Date().toISOString(),
      };
      await store.replace(state, `bind-card-${cardKey}`);
      res.json({ success: true, message: "已设为这张角色卡的新聊天默认档案库。" });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/binding/card/unset", async (req, res) => {
    try {
      const state = await store.read();
      const cardKey = text(req.body?.cardKey, 500);
      delete state.cardDefaults[cardKey];
      await store.replace(state, `unbind-card-${cardKey}`);
      res.json({ success: true, message: "已取消这张角色卡的默认档案库。" });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/profile/save", async (req, res) => {
    try {
      const state = await store.read();
      const profile = profileFromRequest(req.body?.profile);
      if (!state.libraries[profile.library_id]) throw new Error("人物画像对应的档案库不存在。");
      const key = profileKey(profile.library_id, profile.character);
      state.profileOverrides[key] = profile;
      const saved = await store.replace(state, `profile-${profile.character}`);
      res.json({
        success: true,
        profile: materializeProfiles(saved, profile.library_id)[key],
        message: `${profile.character}的画像已保存。`,
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/profile/release", async (req, res) => {
    try {
      const state = await store.read();
      const libraryId = text(req.body?.libraryId, 200);
      const key = profileKey(libraryId, req.body?.character);
      delete state.profileOverrides[key];
      const saved = await store.replace(state, `profile-release-${text(req.body?.character, 100)}`);
      res.json({
        success: true,
        profile: materializeProfiles(saved, libraryId)[key] ?? null,
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
          previous.library_id,
          previous.from,
          previous.to,
        );
        const newKey = relationKey(
          relation.library_id,
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
        relation.library_id,
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
        relation.library_id,
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
      const libraryId = text(req.body?.libraryId, 200);
      const character = text(req.body?.character, 200);
      const x = Number(req.body?.x);
      const y = Number(req.body?.y);
      if (!libraryId || !character || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("关系图坐标不完整。");
      }
      const state = await store.read();
      const key = profileKey(libraryId, character);
      state.graphPositions[key] = { x: Math.round(x), y: Math.round(y) };
      await store.replace(state, `graph-${character}`, false);
      res.json({ success: true });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post("/graph/reset", async (req, res) => {
    try {
      const libraryId = text(req.body?.libraryId, 200);
      const prefix = `${profileKey(libraryId, "").replace(/unknown$/, "")}`;
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
      const cardKey = text(req.body?.cardKey, 500);
      const chatKey = text(req.body?.chatKey, 500);
      const binding = resolveLibrary(state, cardKey, chatKey);
      res.json({
        success: true,
        result: {
          ...recall(state, { ...(req.body ?? {}), libraryId: binding.libraryId }),
          binding: { mode: binding.mode, libraryId: binding.libraryId, library: binding.library },
        },
      });
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
      const state = await store.read();
      const cardKey = text(req.body?.cardKey, 500);
      const chatKey = text(req.body?.chatKey, 500);
      const binding = resolveLibrary(state, cardKey, chatKey);
      if (!binding.libraryId) {
        throw new Error("当前聊天尚未绑定人物档案库，请先在工作台顶部选择或创建档案库。");
      }
      const payload = {
        libraryId: binding.libraryId,
        libraryName: binding.library.name,
        libraryDescription: binding.library.description,
        cardKey,
        chatKey,
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
      if (!payload.chatKey) {
        throw new Error("人物分析缺少聊天标识。");
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
        state,
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
        libraryId: job.payload.libraryId,
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
      const key = progressKey(job.payload.libraryId, job.payload.chatKey);
      const committed = analysisBatches(
        state,
        job.payload.libraryId,
        job.payload.chatKey,
      ).filter((batch) => batch.status === "committed");
      state.analysisProgress[key] = {
        libraryId: job.payload.libraryId,
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
        batch.libraryId,
        batch.chatKey,
      ).filter((item) => item.status === "committed" && item.batchId !== batchId);
      const key = progressKey(batch.libraryId, batch.chatKey);
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
