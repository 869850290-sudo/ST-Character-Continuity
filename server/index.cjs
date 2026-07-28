"use strict";

const path = require("node:path");
const { recall } = require("./recall.cjs");
const { StateStore } = require("./store.cjs");

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

async function init(router) {
  await store.initialize();

  router.post("/health", async (_req, res) => {
    try {
      const state = await store.read();
      res.json({
        success: true,
        version: "0.1.0",
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

