import { initCharacterWorkspace } from "./scripts/workspace.js?v=0.4.7";

const MODULE_NAME = "character_continuity";
const API_ROOT = "/api/plugins/character-continuity";
const FRONTEND_VERSION = "0.4.7";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  recentMessages: 8,
  profileLimit: 4,
  milestoneLimit: 6,
  relationLimit: 8,
  maxChars: 6000,
  includeQuiet: false,
  showToastOnRecall: false,
  analysisAutoEnabled: false,
  analysisInterval: 10,
});

let lastRecall = null;
let workspace = null;

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

function saveSettings() {
  context().saveSettingsDebounced();
}

function notify(type, message, title = "人物连续性记忆") {
  if (window.toastr?.[type]) window.toastr[type](message, title);
  else console[type === "error" ? "error" : "log"](`[${title}] ${message}`);
}

function callBackend(endpoint, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: `${API_ROOT}${endpoint}`,
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify(payload),
      timeout: Number(options.timeout ?? 45_000),
      success: resolve,
      error: (xhr, status) => {
        let message = xhr.responseJSON?.error || xhr.responseText || xhr.statusText;
        if (status === "timeout") message = "后端请求超过 30 秒。";
        reject(new Error(String(message || "无法连接人物连续性后端。")));
      },
    });
  });
}

function messageFlag(value) {
  if (typeof value === "string") {
    return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  }
  return value === true || value === 1;
}

function messageText(message) {
  return String(message?.mes ?? message?.content ?? message?.text ?? "");
}

function isContinuityInjection(message) {
  return message?.extra?.type === "character_continuity_injection";
}

function currentChatSnapshot() {
  const ctx = context();
  const current = ctx.characters?.[ctx.characterId];
  const firstDate = ctx.chat?.find((message) => message?.send_date)?.send_date ?? "undated";
  const chatId = typeof ctx.getCurrentChatId === "function"
    ? ctx.getCurrentChatId()
    : ctx.chatId;
  const chatKey = String(
    chatId ||
    ctx.chatMetadata?.chat_id ||
    ctx.chatMetadata?.create_date ||
    `${current?.name || ctx.characterId || "chat"}:${firstDate}`,
  );
  const cardKey = ctx.groupId != null
    ? `group:${ctx.groupId}`
    : current?.avatar
      ? `character:${current.avatar}`
      : `character:${ctx.characterId ?? "unknown"}:${current?.name ?? "unknown"}`;
  return {
    cardKey,
    cardName: String(ctx.groupId != null ? ctx.groups?.find?.((group) =>
      group?.id === ctx.groupId)?.name || "当前群聊" : current?.name || "当前角色卡"),
    chatKey,
    chatTitle: String(chatId || current?.name || "当前聊天"),
    latestFloor: Math.max(-1, (ctx.chat?.length ?? 0) - 1),
    messages: (ctx.chat ?? []).map((message, floor) => ({
      floor,
      is_user: messageFlag(message?.is_user),
      is_system: messageFlag(message?.is_system),
      name: String(message?.name ?? ""),
      send_date: String(message?.send_date ?? ""),
      mes: messageText(message),
      is_continuity_injection: isContinuityInjection(message),
    })).filter((message) => message.mes && !message.is_continuity_injection),
    priorityCharacters: candidateCharacters(),
  };
}

function recentText(chat) {
  const count = Math.max(1, Number(settings().recentMessages || 8));
  return chat
    .filter((message) =>
      message && !messageFlag(message.is_system) && !isContinuityInjection(message) && messageText(message))
    .slice(-count)
    .map((message) =>
      `${messageFlag(message.is_user) ? "USER" : message.name || "CHAR"}: ${messageText(message)}`)
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
  const snapshot = currentChatSnapshot();
  const response = await callBackend("/recall", {
    cardKey: snapshot.cardKey,
    chatKey: snapshot.chatKey,
    text: recentText(chat),
    candidateCharacters: candidateCharacters(),
    profileLimit: cfg.profileLimit,
    milestoneLimit: cfg.milestoneLimit,
    relationLimit: cfg.relationLimit,
    maxChars: cfg.maxChars,
  });
  lastRecall = response.result;
  workspace?.setRecall(lastRecall);
  renderCompactStatus();
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

function compactSettingsHtml() {
  return `
    <div id="ccm_settings" class="ccm-panel">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-users-viewfinder"></i> 人物连续性记忆</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label ccm-toggle">
            <input id="ccm_enabled" type="checkbox">
            <span>生成前自动召回并注入</span>
          </label>
          <button id="ccm_open_workspace" class="menu_button ccm-open-workspace">
            <i class="fa-solid fa-address-book"></i> 打开人物记忆工作台
          </button>
          <div id="ccm_status" class="ccm-status">尚未召回</div>
          <p class="ccm-help">事件记忆仍由 Anima 负责；人物画像、成长轨迹和有向关系在独立工作台中管理。</p>
        </div>
      </div>
    </div>`;
}

function renderCompactStatus(message) {
  const target = document.querySelector("#ccm_status");
  if (!target) return;
  if (message) {
    target.textContent = message;
    return;
  }
  target.textContent = lastRecall
    ? `识别：${lastRecall.detectedCharacters.join("、") || "无"}｜画像 ${lastRecall.stats.profileCount} · ` +
      `成长 ${lastRecall.stats.milestoneCount} · 关系 ${lastRecall.stats.relationCount}`
    : "尚未召回";
}

function addExtensionButton() {
  const menu = document.getElementById("extensionsMenu");
  if (!menu) {
    setTimeout(addExtensionButton, 500);
    return;
  }
  if (document.getElementById("ccm-workspace-btn")) return;
  const container = document.createElement("div");
  container.className = "extension_container interactable";
  container.innerHTML = `
    <div id="ccm-workspace-btn" class="list-group-item flex-container flexGap5 interactable"
      title="人物连续性记忆">
      <div class="fa-fw fa-solid fa-users-viewfinder extensionsMenuExtensionButton ccm-menu-icon"></div>
      <span>人物连续性记忆</span>
    </div>`;
  container.addEventListener("click", () => workspace?.open());
  menu.appendChild(container);
}

async function initializeUi() {
  workspace ??= initCharacterWorkspace({
    context,
    settings,
    saveSettings,
    notify,
    callBackend,
    runRecall,
    getLastRecall: () => lastRecall,
    getChatSnapshot: currentChatSnapshot,
  });
  addExtensionButton();
  if (!document.querySelector("#ccm_settings")) {
    document.querySelector("#extensions_settings2")
      ?.insertAdjacentHTML("beforeend", compactSettingsHtml());
    const enabled = document.querySelector("#ccm_enabled");
    if (enabled) {
      enabled.checked = settings().enabled;
      enabled.addEventListener("change", () => {
        settings().enabled = enabled.checked;
        saveSettings();
        workspace?.syncSettings();
      });
    }
    document.querySelector("#ccm_open_workspace")
      ?.addEventListener("click", () => workspace?.open());
  }
}

const ctx = context();
const readyEvent = ctx.eventTypes?.APP_READY ?? "app_ready";
ctx.eventSource?.on(readyEvent, initializeUi);
if (document.readyState !== "loading") setTimeout(initializeUi, 0);
else document.addEventListener("DOMContentLoaded", initializeUi, { once: true });

setInterval(() => {
  if (settings().analysisAutoEnabled) workspace?.autoCheck();
}, 15_000);

console.log(`[Character Continuity] 前端扩展 v${FRONTEND_VERSION} 已加载`);
