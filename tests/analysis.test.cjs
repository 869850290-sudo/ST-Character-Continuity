"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildUserContent,
  normalizeOpenAiUrl,
  normalizeResult,
  requestModel,
} = require("../server/analysis.cjs");
const { AnalysisConfigStore, publicConfig } = require("../server/analysis-config.cjs");
const { __test: serverTest } = require("../server/index.cjs");
const { cleanAssistantContent, cleanMessages } = require("../server/preprocess.cjs");
const { normalizeState } = require("../server/state.cjs");

test("内部清洗提取 content 并移除思考链、样式和状态栏", () => {
  const raw = `<!-- Start --><thinking>不应进入人物记忆</thinking>
    <style>.title{color:red}</style><content><div>傅远平说：“我会同行。”</div>
    {{ANIMA_STATUS::78}}</content><!-- End -->`;
  assert.equal(cleanAssistantContent(raw), "傅远平说：“我会同行。”");
});

test("开场白与用户消息保留原文，普通角色回复执行固定清洗", () => {
  const messages = cleanMessages([
    { mes: "<b>开场白</b>", name: "角色" },
    { mes: "<thinking>秘密</thinking><content>用户原样</content>", is_user: true, name: "Fi" },
    { mes: "<thinking>计划</thinking><content>角色正文</content>", name: "角色" },
  ]);
  assert.equal(messages[0].content, "<b>开场白</b>");
  assert.equal(messages[1].content, "<thinking>秘密</thinking><content>用户原样</content>");
  assert.equal(messages[2].content, "角色正文");
});

test("模型结果被规范成画像、里程碑和有向关系结构", () => {
  const result = normalizeResult(JSON.stringify({
    character_audit: [{ character: "牧知傲", decision: "update", evidence: ["自行保留证据"] }],
    profile_updates: [{
      character: "牧知傲",
      decision: "update",
      milestone_candidates: [{
        title: "主动承担责任",
        narrative: "他没有等待命令，而是自行保留证据。",
        change_trace: "等待命令 → 自行判断 → 主动承担",
        source: { start_floor: 99, end_floor: 100 },
      }],
      proposed_profile: {
        current_profile: {
          personality: "冲动、忠诚",
          behavior_pattern: "开始自行判断",
          core_need: "获得认可",
          current_stage: "形成主体性",
        },
        growth_synopsis: "他开始主动承担责任。",
        residual_patterns: [],
      },
    }],
    relation_changes: [{
      decision: "update",
      from: "牧知傲",
      to: "Fi",
      primary_type: "忠诚同伴",
      strength: 2,
    }],
    warnings: [],
  }), { start: 10, end: 19 });
  assert.equal(result.profile_updates[0].milestone_candidates[0].source.start_floor, 10);
  assert.equal(result.profile_updates[0].milestone_candidates[0].source.end_floor, 19);
  assert.equal(result.relation_changes[0].strength, 1);
});

test("构造人物分析上下文时包含全部选中楼层与已有画像", () => {
  const state = normalizeState({
    version: 3,
    libraries: {
      "library-main": { id: "library-main", name: "恶役主线", archived: false },
    },
    baseProfiles: {
      "library-main::牧知傲": {
        library_id: "library-main",
        character: "牧知傲",
        current_profile: {},
      },
    },
  });
  const built = buildUserContent({
    libraryId: "library-main",
    libraryName: "恶役主线",
    chatTitle: "测试聊天",
    startFloor: 0,
    endFloor: 1,
    messages: [
      { floor: 0, name: "牧知傲", mes: "第一层" },
      { floor: 1, is_user: true, name: "Fi", mes: "第二层" },
    ],
  }, state);
  assert.match(built.userContent, /\[楼层 0]/);
  assert.match(built.userContent, /\[楼层 1]/);
  assert.match(built.userContent, /牧知傲/);
});

test("OpenAI 兼容地址只补一次 chat completions 路径", () => {
  assert.equal(
    normalizeOpenAiUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(
    normalizeOpenAiUrl("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions",
  );
});

test("分析进度只跨过连续区间，不会因手动跳段而漏掉中间楼层", () => {
  const batches = [
    { status: "committed", startFloor: 0, endFloor: 9 },
    { status: "committed", startFloor: 20, endFloor: 29 },
  ];
  assert.equal(serverTest.contiguousProcessedThrough(batches), 9);
  batches.push({ status: "committed", startFloor: 10, endFloor: 19 });
  assert.equal(serverTest.contiguousProcessedThrough(batches), 29);
});

test("分析配置不会把 API Key 返回前端，留空保存时保留原 Key", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccm-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new AnalysisConfigStore(root);
  await store.save({
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "test-secret",
  });
  const saved = await store.save({ model: "deepseek-chat-v2", apiKey: "" });
  assert.equal(saved.apiKey, "test-secret");
  assert.equal(publicConfig(saved).apiKey, "");
  assert.equal(publicConfig(saved).hasApiKey, true);
});

test("DeepSeek/GLM 兼容流式响应能够被完整拼接", async (t) => {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"ok\":" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "true}" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const output = await requestModel({
    provider: "openai",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "deepseek-test",
    apiKey: "test-key",
    prompt: "只返回 JSON",
    temperature: 0.2,
    maxTokens: 1000,
    timeoutMs: 5000,
    thinkingMode: "fast",
  }, "测试内容");
  assert.equal(output, "{\"ok\":true}");
  assert.equal(receivedBody.stream, true);
  assert.deepEqual(receivedBody.thinking, { type: "disabled" });
});
