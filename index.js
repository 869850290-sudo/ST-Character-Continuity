const MODULE_NAME = "character_continuity";
const API_ROOT = "/api/plugins/character-continuity";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  storyId: "默认故事",
  timelineId: "主线",
  recentMessages: 8,
  profileLimit: 4,
  milestoneLimit: 6,
  relationLimit: 8,
  maxChars: 6000,
  includeQuiet: false,
  showToastOnRecall: false,
});

let lastRecall = null;

function context() {
  return SillyTavern.getContext();
}

function settings() {
  const ctx = context();
  ctx.extensionSettings[MODULE_NAME] ??= structuredClone(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(ctx.extensionSettings[MODULE_NAME], key)) {
      ctx.extensionSettings[MODULE_NAME][key] = value;
    }
  }
  return ctx.extensionSettings[MODULE_NAME];
}

function notify(type, message, title = "人物连续性记忆") {
  if (window.toastr?.[type]) window.toastr[type](message, title);
  else console[type === "error" ? "error" : "log"](`[${title}] ${message}`);
}

function callBackend(endpoint, payload = {}) {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: `${API_ROOT}${endpoint}`,
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify(payload),
      timeout: 30000,
      success: resolve,
      error: (xhr, status) => {
        let message = xhr.responseJSON?.error || xhr.responseText || xhr.statusText;
        if (status === "timeout") message = "后端请求超过 30 秒。";
        reject(new Error(String(message || "无法连接人物连续性后端。")));
      },
    });
  });
}

function recentText(chat) {
  const count = Math.max(1, Number(settings().recentMessages || 8));
  return chat
    .filter((message) => message && !message.is_system && message.mes)
    .slice(-count)
    .map((message) => `${message.is_user ? "USER" : message.name || "CHAR"}: ${message.mes}`)
    .join("\n\n");
}

function candidateCharacters() {
  const ctx = context();
  const candidates = new Set();
  const current = ctx.characters?.[ctx.characterId];
  if (current?.name) candidates.add(current.name);
  if (ctx.name1) candidates.add(ctx.name1);
  return [...candidates];
}

async function runRecall(chat = context().chat) {
  const cfg = settings();
  const response = await callBackend("/recall", {
    storyId: cfg.storyId,
    timelineId: cfg.timelineId,
    text: recentText(chat),
    candidateCharacters: candidateCharacters(),
    profileLimit: cfg.profileLimit,
    milestoneLimit: cfg.milestoneLimit,
    relationLimit: cfg.relationLimit,
    maxChars: cfg.maxChars,
  });
  lastRecall = response.result;
  renderStatus();
  return response.result;
}

globalThis.characterContinuityInterceptor = async function (chat, _contextSize, _abort, type) {
  const cfg = settings();
  if (!cfg.enabled) return;
  if (type === "quiet" && !cfg.includeQuiet) return;

  try {
    const result = await runRecall(chat);
    if (!result.injection) return;
    const insertionIndex = Math.max(0, chat.length - 1);
    chat.splice(insertionIndex, 0, {
      is_user: false,
      is_system: true,
      name: "Character Continuity Memory",
      send_date: 0,
      mes: result.injection,
      extra: {
        type: "character_continuity_injection",
        detected_characters: result.detectedCharacters,
      },
    });
    if (cfg.showToastOnRecall) {
      notify(
        "info",
        `画像 ${result.stats.profileCount} · 成长 ${result.stats.milestoneCount} · 关系 ${result.stats.relationCount}`,
      );
    }
  } catch (error) {
    notify("warning", `本轮未注入：${error.message}`);
  }
};

function formHtml() {
  return `
    <div id="ccm_settings" class="ccm-panel">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-diagram-project"></i> 人物连续性记忆</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label ccm-toggle">
            <input id="ccm_enabled" type="checkbox">
            <span>生成前自动召回并注入</span>
          </label>
          <div class="ccm-grid">
            <label>故事<input id="ccm_story" class="text_pole" type="text"></label>
            <label>时间线<input id="ccm_timeline" class="text_pole" type="text"></label>
            <label>读取最近消息数<input id="ccm_recent" class="text_pole" type="number" min="1" max="30"></label>
            <label>最大注入字符<input id="ccm_chars" class="text_pole" type="number" min="500" max="20000"></label>
            <label>画像上限<input id="ccm_profiles" class="text_pole" type="number" min="1" max="8"></label>
            <label>成长上限<input id="ccm_milestones" class="text_pole" type="number" min="0" max="20"></label>
            <label>关系上限<input id="ccm_relations" class="text_pole" type="number" min="0" max="24"></label>
          </div>
          <div class="ccm-actions">
            <button id="ccm_health" class="menu_button">检查后端</button>
            <button id="ccm_preview" class="menu_button">预览本轮召回</button>
            <button id="ccm_import" class="menu_button">导入实验室状态</button>
            <button id="ccm_export" class="menu_button">导出备份</button>
            <input id="ccm_file" type="file" accept=".json,application/json" hidden>
          </div>
          <div id="ccm_status" class="ccm-status">尚未召回</div>
          <p class="ccm-help">事件记忆仍由 Anima 负责；此扩展只注入人物画像、成长里程碑和有向关系。</p>
        </div>
      </div>
    </div>`;
}

function bindValue(id, key, parser = String) {
  const element = document.querySelector(id);
  if (!element) return;
  element.value = settings()[key];
  element.addEventListener("change", () => {
    settings()[key] = parser(element.value);
    context().saveSettingsDebounced();
  });
}

function renderStatus(message) {
  const target = document.querySelector("#ccm_status");
  if (!target) return;
  if (message) {
    target.textContent = message;
    return;
  }
  target.textContent = lastRecall
    ? `识别：${lastRecall.detectedCharacters.join("、") || "无"}｜` +
      `画像 ${lastRecall.stats.profileCount} · 成长 ${lastRecall.stats.milestoneCount} · ` +
      `关系 ${lastRecall.stats.relationCount} · ${lastRecall.stats.characterCount} 字符`
    : "尚未召回";
}

async function showPreview() {
  const result = await runRecall();
  const text = result.injection || "本轮没有找到可注入的人物记忆。";
  const ctx = context();
  if (ctx.Popup?.show?.text) await ctx.Popup.show.text("本轮人物记忆", text);
  else alert(text);
}

function downloadJson(fileName, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function initializeUi() {
  if (document.querySelector("#ccm_settings")) return;
  document.querySelector("#extensions_settings2")?.insertAdjacentHTML("beforeend", formHtml());

  const enabled = document.querySelector("#ccm_enabled");
  enabled.checked = settings().enabled;
  enabled.addEventListener("change", () => {
    settings().enabled = enabled.checked;
    context().saveSettingsDebounced();
  });

  bindValue("#ccm_story", "storyId");
  bindValue("#ccm_timeline", "timelineId");
  bindValue("#ccm_recent", "recentMessages", Number);
  bindValue("#ccm_chars", "maxChars", Number);
  bindValue("#ccm_profiles", "profileLimit", Number);
  bindValue("#ccm_milestones", "milestoneLimit", Number);
  bindValue("#ccm_relations", "relationLimit", Number);

  document.querySelector("#ccm_health").addEventListener("click", async () => {
    try {
      const response = await callBackend("/health");
      renderStatus(`后端正常 · v${response.version} · ${response.batches} 个批次`);
      notify("success", "前后端连接正常。");
    } catch (error) {
      notify("error", error.message);
    }
  });

  document.querySelector("#ccm_preview").addEventListener("click", async () => {
    try {
      await showPreview();
    } catch (error) {
      notify("error", error.message);
    }
  });

  const fileInput = document.querySelector("#ccm_file");
  document.querySelector("#ccm_import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const state = JSON.parse(await file.text());
      const response = await callBackend("/state/replace", {
        state,
        reason: `import-${file.name}`,
      });
      notify("success", response.message);
      renderStatus(`已导入：${file.name}`);
    } catch (error) {
      notify("error", `导入失败：${error.message}`);
    } finally {
      fileInput.value = "";
    }
  });

  document.querySelector("#ccm_export").addEventListener("click", async () => {
    try {
      const response = await callBackend("/state/get");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadJson(`character-continuity-${stamp}.json`, response.state);
    } catch (error) {
      notify("error", `导出失败：${error.message}`);
    }
  });
}

const ctx = context();
const readyEvent = ctx.eventTypes?.APP_READY ?? "app_ready";
ctx.eventSource?.on(readyEvent, initializeUi);
if (document.readyState !== "loading") setTimeout(initializeUi, 0);
else document.addEventListener("DOMContentLoaded", initializeUi, { once: true });

console.log("[Character Continuity] 前端扩展已加载");

