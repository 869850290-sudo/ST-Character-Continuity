const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 660;
const FRONTEND_VERSION = "0.4.6";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeId(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function profileKey(libraryId, character) {
  return `${normalizeId(libraryId)}::${normalizeId(character)}`;
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

function downloadText(fileName, value) {
  const blob = new Blob([String(value ?? "")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function initials(name) {
  return [...String(name || "?")].slice(0, 1).join("");
}

function defaultPositions(names, edges) {
  const degree = new Map(names.map((name) => [name, 0]));
  edges.forEach((edge) => {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  });
  const ordered = [...names].sort((a, b) =>
    (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
  );
  const result = {};
  if (!ordered.length) return result;
  result[ordered[0]] = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
  ordered.slice(1).forEach((name, index, outer) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(outer.length, 1);
    result[name] = {
      x: GRAPH_WIDTH / 2 + Math.cos(angle) * 360,
      y: GRAPH_HEIGHT / 2 + Math.sin(angle) * 245,
    };
  });
  return result;
}

function curveForEdge(edge, positions, reverse) {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / length;
  const uy = dy / length;
  const start = { x: from.x + ux * 45, y: from.y + uy * 45 };
  const end = { x: to.x - ux * 50, y: to.y - uy * 50 };
  const bend = reverse ? 58 : 0;
  const control = {
    x: (start.x + end.x) / 2 - uy * bend,
    y: (start.y + end.y) / 2 + ux * bend,
  };
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    label: {
      x: (start.x + 2 * control.x + end.x) / 4,
      y: (start.y + 2 * control.y + end.y) / 4,
    },
  };
}

function shellHtml() {
  return `
    <div id="ccm-overlay" class="ccm-hidden" aria-hidden="true">
      <header class="ccm-header">
        <div class="ccm-brand">
          <button id="ccm-sidebar-toggle" class="ccm-icon-button" aria-label="展开导航">
            <i class="fa-solid fa-bars"></i>
          </button>
          <div class="ccm-brand-mark"><i class="fa-solid fa-users-viewfinder"></i></div>
          <div><b>Character Continuity <small class="ccm-version">v${FRONTEND_VERSION}</small></b>
            <span>人物连续性记忆</span></div>
        </div>
        <div class="ccm-header-actions">
          <span id="ccm-connection-pill" class="ccm-pill">未连接</span>
          <button id="ccm-refresh" class="ccm-icon-button" title="刷新"><i class="fa-solid fa-rotate"></i></button>
          <button id="ccm-close" class="ccm-icon-button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </header>
      <div class="ccm-layout">
        <nav id="ccm-sidebar" class="ccm-sidebar">
          <button class="ccm-nav" data-tab="analysis"><i class="fa-solid fa-brain"></i><span>人物更新</span></button>
          <button class="ccm-nav active" data-tab="profiles"><i class="fa-solid fa-address-card"></i><span>人物档案</span></button>
          <button class="ccm-nav" data-tab="milestones"><i class="fa-solid fa-route"></i><span>成长历史</span></button>
          <button class="ccm-nav" data-tab="relations"><i class="fa-solid fa-diagram-project"></i><span>关系图谱</span></button>
          <button class="ccm-nav" data-tab="recall"><i class="fa-solid fa-wand-magic-sparkles"></i><span>召回预览</span></button>
          <button class="ccm-nav" data-tab="settings"><i class="fa-solid fa-sliders"></i><span>设置与备份</span></button>
        </nav>
        <main class="ccm-content">
          <div id="ccm-workspace-meta" class="ccm-workspace-meta"></div>
          <section id="ccm-view" class="ccm-view"></section>
        </main>
      </div>
      <div id="ccm-modal-root"></div>
      <input id="ccm-import-file" type="file" accept=".json,application/json" hidden>
    </div>`;
}

export function initCharacterWorkspace(deps) {
  if (!document.querySelector("#ccm-overlay")) {
    document.body.insertAdjacentHTML("beforeend", shellHtml());
  }

  const overlay = document.querySelector("#ccm-overlay");
  const view = document.querySelector("#ccm-view");
  const modalRoot = document.querySelector("#ccm-modal-root");
  const sidebar = document.querySelector("#ccm-sidebar");
  const state = {
    activeTab: "profiles",
    workspace: null,
    loading: false,
    error: "",
    recall: deps.getLastRecall(),
    focus: "",
    zoom: 1,
    positions: {},
    analysisConfig: null,
    analysisJob: null,
    analysisPreview: null,
    analysisRangeChatKey: "",
    analysisRangeStart: "",
    analysisRangeEnd: "",
    analysisBusy: false,
    analysisNotice: null,
    autoRetryAfter: 0,
  };

  function cfg() {
    return deps.settings();
  }

  function activeLibraryId() {
    return state.workspace?.binding?.libraryId || "";
  }

  function selectedLibraryId() {
    return document.querySelector("#ccm-library-select")?.value || activeLibraryId();
  }

  function currentContextPayload() {
    const snapshot = deps.getChatSnapshot();
    return {
      cardKey: snapshot.cardKey,
      cardName: snapshot.cardName,
      chatKey: snapshot.chatKey,
      chatTitle: snapshot.chatTitle,
    };
  }

  function close() {
    overlay.classList.add("ccm-hidden");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("ccm-workspace-open");
    modalRoot.innerHTML = "";
  }

  async function open() {
    overlay.classList.remove("ccm-hidden");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("ccm-workspace-open");
    if (window.innerWidth <= 760) sidebar.classList.add("collapsed");
    await loadWorkspace();
  }

  async function loadWorkspace() {
    state.loading = true;
    state.error = "";
    render();
    try {
      const snapshot = deps.getChatSnapshot();
      const response = await deps.callBackend("/workspace", {
        cardKey: snapshot.cardKey,
        cardName: snapshot.cardName,
        chatKey: snapshot.chatKey,
        chatTitle: snapshot.chatTitle,
      });
      state.workspace = response.workspace;
      if (!state.analysisConfig) {
        const configResponse = await deps.callBackend("/analysis/config/get");
        state.analysisConfig = configResponse.config;
      }
      state.positions = { ...response.workspace.graphPositions };
      document.querySelector("#ccm-connection-pill").textContent = "后端正常";
      document.querySelector("#ccm-connection-pill").classList.add("ok");
    } catch (error) {
      state.error = error.message;
      document.querySelector("#ccm-connection-pill").textContent = "连接失败";
      document.querySelector("#ccm-connection-pill").classList.remove("ok");
    } finally {
      state.loading = false;
      render();
    }
  }

  function renderMeta() {
    const target = document.querySelector("#ccm-workspace-meta");
    const counts = state.workspace
      ? `${Object.keys(state.workspace.profiles).length} 人物 · ${state.workspace.milestones.length} 里程碑 · ` +
        `${Object.keys(state.workspace.relations).length} 条关系`
      : "等待读取人物资料";
    const workspace = state.workspace;
    const binding = workspace?.binding ?? { mode: "unbound", libraryId: "" };
    const bindingLabel = {
      chat: "当前聊天单独绑定",
      card: "继承角色卡默认",
      unbound: "尚未绑定",
    }[binding.mode] ?? "尚未绑定";
    const libraries = workspace?.libraries ?? [];
    target.innerHTML = `
      <div class="ccm-context-card"><span>当前角色卡</span><b>${escapeHtml(workspace?.context?.cardName || "未识别")}</b></div>
      <div class="ccm-context-card"><span>当前聊天</span><b>${escapeHtml(workspace?.context?.chatTitle || "未识别")}</b></div>
      <div class="ccm-context-card"><span>当前档案库</span><b>${escapeHtml(binding.library?.name || "未绑定")}</b>
        <small class="ccm-binding-mode ${escapeHtml(binding.mode)}">${escapeHtml(bindingLabel)}</small></div>
      <div class="ccm-library-binding">
        <select id="ccm-library-select" aria-label="选择人物档案库">
          <option value="">选择档案库……</option>
          ${libraries.map((library) => `<option value="${escapeHtml(library.id)}"
            ${library.id === binding.libraryId ? "selected" : ""}>${escapeHtml(library.name)}</option>`).join("")}
        </select>
        <button type="button" data-action="bind-chat"><i class="fa-solid fa-link"></i> 绑定当前聊天</button>
        <button type="button" data-action="set-card-default"><i class="fa-solid fa-id-card"></i> 设为角色卡默认</button>
        <button type="button" data-action="create-library"><i class="fa-solid fa-plus"></i> 新建</button>
        <button type="button" data-action="clone-library" ${binding.libraryId ? "" : "disabled"}>
          <i class="fa-solid fa-copy"></i> 克隆当前库</button>
        <button type="button" data-action="edit-library" ${binding.libraryId ? "" : "disabled"}>
          <i class="fa-solid fa-pen"></i> 编辑库</button>
        ${binding.mode === "chat" ? `<button type="button" data-action="unbind-chat">
          <i class="fa-solid fa-link-slash"></i> 解绑当前聊天</button>` : ""}
        ${workspace?.cardDefaultLibraryId ? `<button type="button" data-action="unset-card-default">
          <i class="fa-solid fa-ban"></i> 取消角色卡默认</button>` : ""}
      </div>
      <div class="ccm-meta-count"><span>资料概况</span><b>${escapeHtml(counts)}</b></div>`;
  }

  function render() {
    renderMeta();
    if (state.loading) {
      view.innerHTML = `<div class="ccm-loading"><i class="fa-solid fa-circle-notch fa-spin"></i><p>正在读取人物资料……</p></div>`;
      return;
    }
    if (state.error) {
      view.innerHTML = `<div class="ccm-empty error"><i class="fa-solid fa-triangle-exclamation"></i>
        <h3>人物资料暂时打不开</h3><p>${escapeHtml(state.error)}</p>
        <button class="ccm-primary" data-action="reload">重新连接</button></div>`;
      return;
    }
    if (!activeLibraryId() && state.activeTab !== "settings") {
      view.innerHTML = `<div class="ccm-empty ccm-unbound">
        <i class="fa-solid fa-box-archive"></i>
        <h3>当前聊天还没有人物档案库</h3>
        <p>在顶部选择已有档案库并绑定，或新建一套。未绑定期间不会分析、写入或注入人物资料。</p>
        <button type="button" class="ccm-primary" data-action="create-library">
          <i class="fa-solid fa-plus"></i> 新建档案库</button>
      </div>`;
      return;
    }
    const renderer = {
      profiles: renderProfiles,
      analysis: renderAnalysis,
      milestones: renderMilestones,
      relations: renderRelations,
      recall: renderRecall,
      settings: renderSettings,
    }[state.activeTab];
    renderer?.();
  }

  function analysisResultHtml(job) {
    const result = job?.result;
    if (!result) return "";
    const updates = (result.profile_updates ?? []).filter((item) => item.decision === "update");
    const milestones = updates.flatMap((item) => item.milestone_candidates ?? []);
    const relations = (result.relation_changes ?? []).filter((item) =>
      item.decision === "create" || item.decision === "update");
    return `
      <section class="ccm-analysis-result">
        <header>
          <div><span>ANALYSIS PREVIEW</span><h3>人物更新预览</h3></div>
          <div class="ccm-analysis-counts">
            <b>${updates.length}<small>画像</small></b>
            <b>${milestones.length}<small>成长</small></b>
            <b>${relations.length}<small>关系</small></b>
          </div>
        </header>
        ${(result.character_audit ?? []).length ? `<div class="ccm-audit-strip">
          ${(result.character_audit ?? []).map((item) =>
            `<span class="${escapeHtml(item.decision)}">${escapeHtml(item.character)} · ${escapeHtml(item.decision)}</span>`,
          ).join("")}
        </div>` : ""}
        ${updates.map((item) => `<article class="ccm-analysis-card">
          <div><span>人物画像</span><h4>${escapeHtml(item.character)}</h4></div>
          <p>${escapeHtml(item.proposed_profile?.current_profile?.current_stage || item.reason)}</p>
          ${item.proposed_profile?.growth_synopsis
            ? `<blockquote>${escapeHtml(item.proposed_profile.growth_synopsis)}</blockquote>` : ""}
          ${(item.milestone_candidates ?? []).map((milestone) =>
            `<div class="ccm-analysis-sub"><b>${escapeHtml(milestone.title)}</b>
              <span>${escapeHtml(milestone.time)} · ${escapeHtml(milestone.location)}</span>
              <p>${escapeHtml(milestone.narrative)}</p></div>`,
          ).join("")}
        </article>`).join("")}
        ${relations.map((item) => `<article class="ccm-analysis-card relation">
          <div><span>关系变化</span><h4>${escapeHtml(item.from)} → ${escapeHtml(item.to)}</h4></div>
          <p><b>${escapeHtml(item.primary_type)}</b> · ${escapeHtml(item.attitude || item.reason)}</p>
        </article>`).join("")}
        ${(result.warnings ?? []).length ? `<div class="ccm-analysis-warning">
          <b>模型提醒</b>${result.warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
        </div>` : ""}
        ${job.cleanedContext ? `<details class="ccm-clean-preview"><summary>查看实际送给模型的清洗后正文</summary>
          <pre>${escapeHtml(job.cleanedContext)}</pre></details>` : ""}
        <footer>
          <button data-action="discard-analysis">暂不采用</button>
          <button data-action="accept-analysis" class="ccm-primary">
            <i class="fa-solid fa-check"></i> 采纳这次更新
          </button>
        </footer>
      </section>`;
  }

  function renderAnalysis() {
    const snapshot = deps.getChatSnapshot();
    const progress = state.workspace?.progress;
    const processed = Number(progress?.processedThrough ?? -1);
    const suggestedStart = processed >= snapshot.latestFloor
      ? Math.max(0, snapshot.latestFloor - 9)
      : processed + 1;
    if (state.analysisRangeChatKey !== snapshot.chatKey) {
      state.analysisRangeChatKey = snapshot.chatKey;
      state.analysisRangeStart = String(suggestedStart);
      state.analysisRangeEnd = String(snapshot.latestFloor);
    }
    const current = state.analysisConfig ?? {};
    const running = state.analysisJob?.status === "running";
    const batches = state.workspace?.batches ?? [];
    view.innerHTML = `
      <div class="ccm-section-heading">
        <div><span>CHARACTER ANALYSIS</span><h2>人物更新</h2>
          <p>按楼层分析人物画像、成长与关系。事件总结仍交给 Anima。</p></div>
      </div>
      <div class="ccm-analysis-progress">
        <div><span>当前聊天</span><b>${escapeHtml(snapshot.chatTitle)}</b></div>
        <div><span>最新楼层</span><b>${snapshot.latestFloor}</b></div>
        <div><span>已处理至</span><b>${processed}</b></div>
        <div><span>已采纳批次</span><b>${Number(progress?.sequence ?? 0)}</b></div>
      </div>
      <div id="ccm-analysis-notice" class="ccm-analysis-notice ${state.analysisNotice?.type || ""}"
        role="status" aria-live="polite" ${state.analysisNotice ? "" : "hidden"}>
        ${escapeHtml(state.analysisNotice?.message || "")}
      </div>
      <section class="ccm-analysis-panel">
        <header><div><span>AUTOMATION</span><h3>自动人物更新</h3></div>
          <label class="ccm-switch"><input id="ccm-analysis-auto" type="checkbox"
            ${cfg().analysisAutoEnabled ? "checked" : ""}><span></span></label>
        </header>
        <p>打开后，每累计 N 层完整对话会自动分析并采纳。现在默认关闭，等你确认质量后再开。</p>
        <div class="ccm-analysis-controls">
          <label>触发间隔（楼）<input id="ccm-analysis-interval" type="number" min="2" max="100"
            value="${Number(cfg().analysisInterval ?? 10)}"></label>
          <button type="button" data-action="save-analysis-settings" class="ccm-primary">
            <i class="fa-solid fa-floppy-disk"></i> 保存自动设置
          </button>
        </div>
      </section>
      <section class="ccm-analysis-panel">
        <header><div><span>MANUAL RUN</span><h3>手动分析楼层</h3></div></header>
        <div class="ccm-range-controls">
          <label>起始楼层<input id="ccm-analysis-start" type="number" min="0"
            max="${Math.max(0, snapshot.latestFloor)}" value="${escapeHtml(state.analysisRangeStart)}"></label>
          <label>终点楼层<input id="ccm-analysis-end" type="number" min="0"
            max="${Math.max(0, snapshot.latestFloor)}" value="${escapeHtml(state.analysisRangeEnd)}"></label>
          <button type="button" data-action="preview-range"><i class="fa-solid fa-eye"></i> 预览范围</button>
          <button type="button" data-action="run-analysis" class="ccm-primary" ${running ? "disabled" : ""}>
            <i class="fa-solid ${running ? "fa-circle-notch fa-spin" : "fa-play"}"></i>
            ${running ? "模型正在分析…" : "执行人物分析"}
          </button>
        </div>
        ${running ? `<div class="ccm-job-running"><b>任务已交给服务器后台处理</b>
          <span>网页会每两秒取一次结果，不会再因 Cloudflare 等待过久而报 524。</span></div>` : ""}
        ${state.analysisPreview ? analysisResultHtml(state.analysisPreview) : ""}
      </section>
      <section class="ccm-analysis-panel">
        <header><div><span>MODEL & PROMPT</span><h3>分析模型与提示词</h3></div></header>
        <div class="ccm-model-grid">
          <label>接口类型<select id="ccm-analysis-provider">
            <option value="openai" ${current.provider !== "gemini" ? "selected" : ""}>OpenAI 兼容（DeepSeek / GLM）</option>
            <option value="gemini" ${current.provider === "gemini" ? "selected" : ""}>Gemini 官方</option>
          </select></label>
          <label>API 基础地址<input id="ccm-analysis-base-url" value="${escapeHtml(current.baseUrl || "")}"
            placeholder="https://api.deepseek.com/v1"></label>
          <label>模型名称<input id="ccm-analysis-model" value="${escapeHtml(current.model || "")}"
            placeholder="输入供应商给出的模型名"></label>
          <label>API Key<input id="ccm-analysis-key" type="password" value=""
            placeholder="${current.hasApiKey ? "已保存；留空则不修改" : "尚未保存"}"></label>
          <label>思考模式<select id="ccm-analysis-thinking">
            ${[["fast", "快速"], ["balanced", "平衡"], ["deep", "深度"]].map(([value, label]) =>
              `<option value="${value}" ${current.thinkingMode === value ? "selected" : ""}>${label}</option>`,
            ).join("")}
          </select></label>
          <label>最长等待（分钟）<input id="ccm-analysis-timeout" type="number" min="1" max="15"
            value="${Math.round(Number(current.timeoutMs ?? 600000) / 60000)}"></label>
        </div>
        <label class="ccm-prompt-field">人物连续性分析提示词
          <textarea id="ccm-analysis-prompt">${escapeHtml(current.prompt || "")}</textarea>
        </label>
        <p class="ccm-clean-note"><i class="fa-solid fa-filter"></i>
          内部清洗已固定启用：开场白和用户消息保留原文；角色回复自动提取 &lt;content&gt;，
          剥离 thinking / analysis、HTML、CSS、注释和状态栏标记。这里不执行来源不明的自定义正则。</p>
        <div class="ccm-settings-actions">
          <button type="button" data-action="save-analysis-config" class="ccm-primary">
            <i class="fa-solid fa-floppy-disk"></i> 保存模型与提示词
          </button>
          <button type="button" data-action="export-analysis-prompt"><i class="fa-solid fa-file-export"></i> 导出提示词</button>
        </div>
      </section>
      <section class="ccm-analysis-panel">
        <header><div><span>UPDATE HISTORY</span><h3>已采纳的人物更新</h3></div></header>
        ${batches.length ? `<div class="ccm-batch-list">${batches.map((batch) => `
          <article class="${batch.status === "reverted" ? "reverted" : ""}">
            <div><b>${escapeHtml(batch.range || "未知范围")} 楼</b>
              <span>${escapeHtml(batch.mode === "auto" ? "自动" : "手动")} · ${escapeHtml(batch.acceptedAt || "")}</span></div>
            <span>${(batch.result?.profile_updates ?? []).filter((item) => item.decision === "update").length} 画像 ·
              ${(batch.result?.relation_changes ?? []).filter((item) => ["create", "update"].includes(item.decision)).length} 关系</span>
            ${batch.status === "committed" ? `<button data-action="revert-analysis-batch"
              data-batch-id="${escapeHtml(batch.batchId)}">撤回</button>` : `<em>已撤回</em>`}
          </article>`).join("")}</div>` : `<p class="ccm-muted">当前聊天还没有采纳过人物更新。</p>`}
      </section>`;
  }

  function renderProfiles() {
    const profiles = Object.entries(state.workspace?.profiles ?? {});
    view.innerHTML = `
      <div class="ccm-section-heading">
        <div><span>CHARACTER FILES</span><h2>人物档案</h2><p>画像描述人物此刻是谁；人工保存后会覆盖模型版本，直到你选择交还模型。</p></div>
      </div>
      ${profiles.length ? `<div class="ccm-profile-grid">${profiles.map(([key, profile]) => `
        <article class="ccm-profile-card">
          <header>
            <div class="ccm-avatar">${escapeHtml(initials(profile.character))}</div>
            <div><span>PROFILE · V${Number(profile.version ?? 0)}</span><h3>${escapeHtml(profile.character)}</h3></div>
            <button class="ccm-card-edit" data-action="edit-profile" data-key="${escapeHtml(key)}">
              <i class="fa-solid fa-pen"></i> 编辑
            </button>
          </header>
          <dl>
            <div><dt>性格</dt><dd>${escapeHtml(profile.current_profile?.personality || "尚未建立")}</dd></div>
            <div><dt>行动方式</dt><dd>${escapeHtml(profile.current_profile?.behavior_pattern || "尚未建立")}</dd></div>
            <div><dt>核心需求</dt><dd>${escapeHtml(profile.current_profile?.core_need || "尚未建立")}</dd></div>
            <div><dt>当前阶段</dt><dd>${escapeHtml(profile.current_profile?.current_stage || "尚未建立")}</dd></div>
          </dl>
          <section><b>成长历史</b><p>${escapeHtml(profile.growth_synopsis || "尚未建立")}</p></section>
          <footer>${escapeHtml(profile.last_source || "来源未注明")}</footer>
        </article>`).join("")}</div>`
      : `<div class="ccm-empty"><i class="fa-solid fa-address-card"></i><h3>还没有人物画像</h3>
          <p>先从人物实验室导入状态，或等待后续自动更新写入。</p></div>`}`;
  }

  function renderMilestones() {
    const milestones = state.workspace?.milestones ?? [];
    view.innerHTML = `
      <div class="ccm-section-heading">
        <div><span>GROWTH HISTORY</span><h2>成长历史</h2><p>一条条保留人物改变的触发、选择、代价与尚未消失的旧模式。</p></div>
      </div>
      ${milestones.length ? `<div class="ccm-timeline">${milestones.map((item) => `
        <article>
          <div class="ccm-timeline-dot"></div>
          <header><b>${escapeHtml(item.character)}</b><span>${escapeHtml(item.time || "时间未注明")} · ${escapeHtml(item.location || "地点未注明")}</span></header>
          <h3>${escapeHtml(item.title || "未命名成长节点")}</h3>
          <p>${escapeHtml(item.narrative || "")}</p>
          ${item.change_trace ? `<blockquote>${escapeHtml(item.change_trace)}</blockquote>` : ""}
          <footer>${escapeHtml(item.stage || "emerging")} · ${escapeHtml(item.dimension || "other")}</footer>
        </article>`).join("")}</div>`
      : `<div class="ccm-empty"><i class="fa-solid fa-route"></i><h3>还没有成长里程碑</h3>
          <p>人物发生真正改变并采用分析结果后，会出现在这里。</p></div>`}`;
  }

  function graphData() {
    const profiles = Object.values(state.workspace?.profiles ?? {});
    const allEdges = Object.values(state.workspace?.relations ?? {}).filter((edge) => edge.active !== false);
    const allNames = [...new Set([
      ...profiles.map((profile) => profile.character),
      ...allEdges.flatMap((edge) => [edge.from, edge.to]),
    ])].sort((a, b) => a.localeCompare(b));
    const visibleNames = state.focus
      ? allNames.filter((name) => name === state.focus || allEdges.some((edge) =>
        (edge.from === state.focus && edge.to === name) ||
        (edge.to === state.focus && edge.from === name),
      ))
      : allNames;
    const visibleSet = new Set(visibleNames);
    const edges = allEdges.filter((edge) => visibleSet.has(edge.from) && visibleSet.has(edge.to));
    const positions = defaultPositions(visibleNames, edges);
    visibleNames.forEach((name) => {
      const saved = state.positions[profileKey(state.workspace?.binding?.libraryId, name)];
      if (saved) positions[name] = saved;
    });
    return { profiles, allNames, visibleNames, edges, positions };
  }

  function renderRelations() {
    const { profiles, allNames, visibleNames, edges, positions } = graphData();
    const profileByName = new Map(profiles.map((profile) => [profile.character, profile]));
    const viewWidth = GRAPH_WIDTH / state.zoom;
    const viewHeight = GRAPH_HEIGHT / state.zoom;
    const viewX = (GRAPH_WIDTH - viewWidth) / 2;
    const viewY = (GRAPH_HEIGHT - viewHeight) / 2;
    const edgeSvg = edges.map((edge, index) => {
      const reverse = edges.some((other) => other.from === edge.to && other.to === edge.from);
      const curve = curveForEdge(edge, positions, reverse);
      if (!curve) return "";
      return `<g class="ccm-graph-edge" data-relation-index="${index}">
        <path class="ccm-edge-hit" d="${curve.path}"></path>
        <path class="ccm-edge-line" d="${curve.path}" marker-end="url(#ccm-arrow)"></path>
        <text x="${curve.label.x}" y="${curve.label.y}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(edge.primary_type)}</text>
      </g>`;
    }).join("");
    const nodeSvg = visibleNames.map((name) => {
      const position = positions[name];
      const stage = profileByName.get(name)?.current_profile?.current_stage ?? "";
      return `<g class="ccm-graph-node" data-name="${escapeHtml(name)}" transform="translate(${position.x} ${position.y})">
        <circle r="38"></circle>
        <text class="ccm-node-initial" text-anchor="middle" dominant-baseline="central">${escapeHtml(initials(name))}</text>
        <text class="ccm-node-name" y="60" text-anchor="middle">${escapeHtml(name)}</text>
        ${stage ? `<text class="ccm-node-stage" y="80" text-anchor="middle">${escapeHtml(stage.slice(0, 14))}</text>` : ""}
      </g>`;
    }).join("");
    view.innerHTML = `
      <div class="ccm-section-heading relation">
        <div><span>RELATIONSHIP GRAPH</span><h2>人物关系图谱</h2><p>箭头有方向；双向关系会分成两条曲线。点击人物改画像，点击连线改关系。</p></div>
        <button class="ccm-primary" data-action="add-relation"><i class="fa-solid fa-plus"></i> 添加关系</button>
      </div>
      <div class="ccm-graph-toolbar">
        <label>人物范围<select id="ccm-graph-focus">
          <option value="">全部人物</option>
          ${allNames.map((name) => `<option value="${escapeHtml(name)}" ${state.focus === name ? "selected" : ""}>${escapeHtml(name)}与相邻关系</option>`).join("")}
        </select></label>
        <div>
          <button data-action="zoom-in" title="放大">＋</button>
          <button data-action="zoom-out" title="缩小">－</button>
          <button data-action="reset-graph">重置布局</button>
        </div>
      </div>
      ${allNames.length ? `<div class="ccm-graph-scroll">
        <svg id="ccm-relationship-graph" viewBox="${viewX} ${viewY} ${viewWidth} ${viewHeight}" aria-label="人物关系图">
          <defs><marker id="ccm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z"></path>
          </marker></defs>
          <g>${edgeSvg}</g><g>${nodeSvg}</g>
        </svg></div>
        <div class="ccm-graph-hint"><span>拖动人物整理位置</span><span>点击人物编辑画像</span><span>点击箭头编辑关系</span></div>`
      : `<div class="ccm-empty"><i class="fa-solid fa-diagram-project"></i><h3>还没有人物或关系</h3>
          <p>添加第一条关系后，关系图会在这里出现。</p></div>`}`;
    bindGraphEvents(edges, positions);
  }

  function bindGraphEvents(edges, positions) {
    const svg = document.querySelector("#ccm-relationship-graph");
    if (!svg) return;
    svg.querySelectorAll(".ccm-graph-edge").forEach((element) => {
      element.addEventListener("click", () => openRelationEditor(edges[Number(element.dataset.relationIndex)]));
    });
    svg.querySelectorAll(".ccm-graph-node").forEach((element) => {
      let drag = null;
      const pointFromEvent = (event) => {
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const matrix = svg.getScreenCTM()?.inverse();
        return matrix ? point.matrixTransform(matrix) : null;
      };
      element.addEventListener("pointerdown", (event) => {
        const point = pointFromEvent(event);
        if (!point) return;
        element.setPointerCapture(event.pointerId);
        drag = { startX: point.x, startY: point.y, moved: false, position: positions[element.dataset.name] };
      });
      element.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const point = pointFromEvent(event);
        if (!point) return;
        drag.moved ||= Math.hypot(point.x - drag.startX, point.y - drag.startY) > 5;
        drag.position = {
          x: Math.max(55, Math.min(GRAPH_WIDTH - 55, point.x)),
          y: Math.max(55, Math.min(GRAPH_HEIGHT - 70, point.y)),
        };
        element.setAttribute("transform", `translate(${drag.position.x} ${drag.position.y})`);
      });
      element.addEventListener("pointerup", async (event) => {
        if (!drag) return;
        element.releasePointerCapture(event.pointerId);
        const finished = drag;
        drag = null;
        if (!finished.moved) {
          openProfileEditorByName(element.dataset.name);
          return;
        }
        const libraryId = state.workspace?.binding?.libraryId;
        const key = profileKey(libraryId, element.dataset.name);
        state.positions[key] = finished.position;
        try {
          await deps.callBackend("/graph/position", {
            libraryId,
            character: element.dataset.name,
            ...finished.position,
          });
        } catch (error) {
          deps.notify("warning", `位置暂未保存：${error.message}`);
        }
        renderRelations();
      });
    });
  }

  function renderRecall() {
    const result = state.recall;
    view.innerHTML = `
      <div class="ccm-section-heading relation">
        <div><span>RECALL INSPECTOR</span><h2>召回预览</h2><p>用当前聊天最近消息模拟一次召回，只预览，不发送给模型。</p></div>
        <button class="ccm-primary" data-action="run-recall"><i class="fa-solid fa-play"></i> 运行预览</button>
      </div>
      ${result ? `<div class="ccm-recall-stats">
        <div><strong>${result.stats.profileCount}</strong><span>画像</span></div>
        <div><strong>${result.stats.milestoneCount}</strong><span>成长</span></div>
        <div><strong>${result.stats.relationCount}</strong><span>关系</span></div>
        <div><strong>${result.stats.characterCount}</strong><span>字符</span></div>
      </div>
      <div class="ccm-recall-detected"><b>识别人物</b><span>${escapeHtml(result.detectedCharacters.join("、") || "本轮没有识别到人物")}</span></div>
      <pre class="ccm-injection-preview">${escapeHtml(result.injection || "本轮没有可注入的人物资料。")}</pre>`
      : `<div class="ccm-empty"><i class="fa-solid fa-wand-magic-sparkles"></i><h3>还没有召回记录</h3>
          <p>点击“运行预览”，查看下一轮会注入哪些人物资料。</p></div>`}`;
  }

  function renderSettings() {
    const current = cfg();
    view.innerHTML = `
      <div class="ccm-section-heading">
        <div><span>SETTINGS & BACKUP</span><h2>设置与备份</h2><p>控制自动注入范围；这里不管理 Anima 的事件记忆。</p></div>
      </div>
      <div class="ccm-settings-card">
        <label class="ccm-switch-row"><div><b>生成前自动召回</b><span>根据最近消息识别人物并注入相关资料</span></div>
          <input id="ccm-ws-enabled" type="checkbox" ${current.enabled ? "checked" : ""}></label>
        <div class="ccm-settings-grid">
          <label>读取最近消息数<input id="ccm-ws-recent" type="number" min="1" max="30" value="${Number(current.recentMessages)}"></label>
          <label>最大注入字符<input id="ccm-ws-chars" type="number" min="500" max="20000" value="${Number(current.maxChars)}"></label>
          <label>画像上限<input id="ccm-ws-profiles" type="number" min="1" max="8" value="${Number(current.profileLimit)}"></label>
          <label>成长上限<input id="ccm-ws-milestones" type="number" min="0" max="20" value="${Number(current.milestoneLimit)}"></label>
          <label>关系上限<input id="ccm-ws-relations" type="number" min="0" max="24" value="${Number(current.relationLimit)}"></label>
        </div>
        <div class="ccm-settings-actions">
          <button data-action="save-settings" class="ccm-primary"><i class="fa-solid fa-floppy-disk"></i> 保存设置</button>
          <button data-action="health"><i class="fa-solid fa-stethoscope"></i> 检查后端</button>
          <button data-action="import"><i class="fa-solid fa-file-import"></i> 导入状态</button>
          <button data-action="export"><i class="fa-solid fa-box-archive"></i> 导出备份</button>
        </div>
      </div>`;
  }

  function libraryModal(mode = "create") {
    const current = state.workspace?.binding?.library ?? null;
    if ((mode === "clone" || mode === "edit") && !current) {
      deps.notify("warning", "请先绑定一个档案库。");
      return;
    }
    const title = mode === "clone" ? "克隆档案库" : mode === "edit" ? "编辑档案库" : "新建档案库";
    const defaultName = mode === "clone"
      ? `${current.name}（新世界线）`
      : mode === "edit"
        ? current.name
        : `${state.workspace?.context?.cardName || "角色"}人物档案`;
    const defaultDescription = mode === "edit" || mode === "clone" ? current.description || "" : "";
    modalRoot.innerHTML = `<dialog id="ccm-library-dialog" class="ccm-native-dialog">
      <form id="ccm-library-form" class="ccm-modal ccm-library-modal">
        <header><div><span>MEMORY LIBRARY</span><h3>${title}</h3></div>
          <button type="button" data-modal-close>×</button></header>
        <p class="ccm-modal-note">${mode === "clone"
          ? "会复制现有画像、成长历史和关系。复制后两套资料各自更新，适合平行世界或不同剧情线。"
          : "档案库独立保存人物连续性，可同时绑定多个聊天。解绑聊天不会删除档案库。"}</p>
        <div class="ccm-modal-grid">
          <label class="wide">档案库名称<input name="name" maxlength="200"
            value="${escapeHtml(defaultName)}" required></label>
          <label class="wide">说明（可选）<textarea name="description"
            placeholder="例如：恶役主线、现代 AU、二周目">${escapeHtml(defaultDescription)}</textarea></label>
        </div>
        <p id="ccm-library-error" class="ccm-form-error"></p>
        <footer>
          <button type="button" data-modal-close>取消</button>
          <button type="submit" class="ccm-primary">${mode === "clone" ? "克隆并绑定" : "保存"}</button>
        </footer>
      </form></dialog>`;
    const dialog = modalRoot.querySelector("#ccm-library-dialog");
    const closeLibraryModal = () => {
      if (dialog.open) dialog.close();
      modalRoot.innerHTML = "";
    };
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", closeLibraryModal));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeLibraryModal();
    });
    modalRoot.querySelector("#ccm-library-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") || "").trim();
      const description = String(form.get("description") || "").trim();
      if (!name) {
        modalRoot.querySelector("#ccm-library-error").textContent = "请给档案库起一个名字。";
        return;
      }
      try {
        if (mode === "edit") {
          await deps.callBackend("/library/update", {
            libraryId: current.id,
            name,
            description,
          });
        } else {
          const response = await deps.callBackend(
            mode === "clone" ? "/library/clone" : "/library/create",
            mode === "clone"
              ? { sourceLibraryId: current.id, name, description }
              : { name, description },
          );
          await deps.callBackend("/binding/chat/set", {
            ...currentContextPayload(),
            libraryId: response.library.id,
          });
        }
        deps.notify("success", mode === "clone"
          ? "档案库已克隆并绑定到当前聊天。"
          : mode === "edit" ? "档案库资料已保存。" : "档案库已创建并绑定到当前聊天。");
        closeLibraryModal();
        await loadWorkspace();
      } catch (error) {
        modalRoot.querySelector("#ccm-library-error").textContent = error.message;
      }
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function profileModal(profile, isManual) {
    const residualText = (profile.residual_patterns ?? []).map((item) =>
      [item.trigger, item.likely_response, item.counterweight].join("｜"),
    ).join("\n");
    modalRoot.innerHTML = `<dialog id="ccm-profile-dialog" class="ccm-native-dialog">
      <form id="ccm-profile-form" class="ccm-modal">
        <header><div><span>PROFILE EDITOR</span><h3>${escapeHtml(profile.character)}</h3></div>
          <button type="button" data-modal-close aria-label="关闭">×</button></header>
        <p class="ccm-modal-note">人工保存后，这份画像会成为当前版本；可随时“交还模型”恢复自动生成版本。</p>
        <div class="ccm-modal-grid">
          <label>性格<textarea name="personality">${escapeHtml(profile.current_profile?.personality)}</textarea></label>
          <label>行动方式<textarea name="behavior_pattern">${escapeHtml(profile.current_profile?.behavior_pattern)}</textarea></label>
          <label>核心需求<textarea name="core_need">${escapeHtml(profile.current_profile?.core_need)}</textarea></label>
          <label>当前阶段<textarea name="current_stage">${escapeHtml(profile.current_profile?.current_stage)}</textarea></label>
          <label class="wide">成长历史<textarea class="tall" name="growth_synopsis">${escapeHtml(profile.growth_synopsis)}</textarea></label>
          <label class="wide">旧模式残留<small>每行：触发｜可能反应｜制衡因素</small>
            <textarea class="tall" name="residual_patterns">${escapeHtml(residualText)}</textarea></label>
        </div>
        <footer>
          ${isManual ? `<button type="button" class="ccm-danger-text" data-action="release-profile">交还模型更新</button>` : ""}
          <button type="button" data-modal-close>取消</button>
          <button type="submit" class="ccm-primary">保存画像</button>
        </footer>
      </form></dialog>`;
    const dialog = modalRoot.querySelector("#ccm-profile-dialog");
    const closeProfileModal = () => {
      if (dialog.open) dialog.close();
      modalRoot.innerHTML = "";
    };
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", closeProfileModal));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeProfileModal();
    });
    modalRoot.querySelector("#ccm-profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const residuals = String(form.get("residual_patterns") ?? "").split(/\r?\n/)
        .map((line) => line.trim()).filter(Boolean).map((line) => {
          const [trigger = "", likely_response = "", counterweight = ""] =
            line.split(/[|｜]/).map((item) => item.trim());
          return { trigger, likely_response, counterweight, evidence: [] };
        });
      try {
        await deps.callBackend("/profile/save", { profile: {
          ...profile,
          current_profile: {
            personality: form.get("personality"),
            behavior_pattern: form.get("behavior_pattern"),
            core_need: form.get("core_need"),
            current_stage: form.get("current_stage"),
          },
          growth_synopsis: form.get("growth_synopsis"),
          residual_patterns: residuals,
        } });
        deps.notify("success", `${profile.character}的画像已保存。`);
        closeProfileModal();
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    modalRoot.querySelector("[data-action='release-profile']")?.addEventListener("click", async () => {
      try {
        await deps.callBackend("/profile/release", {
          libraryId: profile.library_id,
          character: profile.character,
        });
        deps.notify("success", "已恢复模型生成版本。");
        closeProfileModal();
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function openProfileEditorByName(name) {
    const entry = Object.entries(state.workspace?.profiles ?? {})
      .find(([, profile]) => profile.character === name);
    const profile = entry?.[1] ?? {
      library_id: state.workspace?.binding?.libraryId,
      character: name,
      current_profile: { personality: "", behavior_pattern: "", core_need: "", current_stage: "" },
      growth_synopsis: "",
      residual_patterns: [],
      active_milestone_ids: [],
      version: 0,
    };
    profileModal(profile, profile.last_batch_id === "manual");
  }

  function relationModal(edge = null) {
    const names = graphData().allNames;
    const draft = edge ?? {
      library_id: state.workspace?.binding?.libraryId,
      from: names[0] ?? "",
      to: names[1] ?? "",
      primary_type: "",
      tags: [],
      attitude: "",
      interaction_pattern: "",
      visibility: "private",
      strength: 0.5,
      active: true,
      version: 0,
    };
    modalRoot.innerHTML = `<dialog id="ccm-relation-dialog" class="ccm-native-dialog">
      <form id="ccm-relation-form" class="ccm-modal ccm-relation-modal">
        <header><div><span>RELATION EDITOR</span><h3>${edge ? "编辑关系" : "新增关系"}</h3></div>
          <button type="button" data-modal-close>×</button></header>
        <p class="ccm-modal-note">关系有方向。“A 对 B”与“B 对 A”是两条不同的边。</p>
        <div class="ccm-modal-grid">
          <label>从谁出发<input name="from" list="ccm-character-names" value="${escapeHtml(draft.from)}"></label>
          <label>指向谁<input name="to" list="ccm-character-names" value="${escapeHtml(draft.to)}"></label>
          <datalist id="ccm-character-names">${names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("")}</datalist>
          <label>关系类型<input name="primary_type" value="${escapeHtml(draft.primary_type)}" placeholder="例如：未婚夫、忠诚同伴"></label>
          <label>可见范围<select name="visibility">
            ${[["public", "公开"], ["known_to_from", "仅发起者明确知道"], ["private", "私密"], ["author_only", "仅作者可见"]]
              .map(([value, label]) => `<option value="${value}" ${draft.visibility === value ? "selected" : ""}>${label}</option>`).join("")}
          </select></label>
          <label class="wide">当前态度<textarea name="attitude">${escapeHtml(draft.attitude)}</textarea></label>
          <label class="wide">互动模式<textarea name="interaction_pattern">${escapeHtml(draft.interaction_pattern)}</textarea></label>
          <label>标签<input name="tags" value="${escapeHtml((draft.tags ?? []).join("，"))}"></label>
          <label>关系强度 <output id="ccm-strength-output">${Math.round((draft.strength ?? 0.5) * 100)}%</output>
            <input id="ccm-strength" name="strength" type="range" min="0" max="1" step="0.05" value="${Number(draft.strength ?? 0.5)}"></label>
        </div>
        <p id="ccm-relation-error" class="ccm-form-error"></p>
        <footer>
          ${edge ? `<button type="button" class="ccm-danger-text" data-action="deactivate-relation">停用关系</button>` : ""}
          <button type="button" data-modal-close>取消</button>
          <button type="submit" class="ccm-primary">保存关系</button>
        </footer>
      </form></dialog>`;
    const dialog = modalRoot.querySelector("#ccm-relation-dialog");
    const closeRelationModal = () => {
      if (dialog.open) dialog.close();
      modalRoot.innerHTML = "";
    };
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", closeRelationModal));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeRelationModal();
    });
    const strength = modalRoot.querySelector("#ccm-strength");
    strength.addEventListener("input", () => {
      modalRoot.querySelector("#ccm-strength-output").textContent = `${Math.round(Number(strength.value) * 100)}%`;
    });
    modalRoot.querySelector("#ccm-relation-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const from = String(form.get("from") ?? "").trim();
      const to = String(form.get("to") ?? "").trim();
      if (!from || !to || from === to) {
        modalRoot.querySelector("#ccm-relation-error").textContent =
          from === to ? "同一个人不能与自己建立这条关系。" : "关系两端都要填写人物姓名。";
        return;
      }
      const relation = {
        ...draft,
        library_id: state.workspace?.binding?.libraryId,
        from,
        to,
        primary_type: form.get("primary_type"),
        visibility: form.get("visibility"),
        attitude: form.get("attitude"),
        interaction_pattern: form.get("interaction_pattern"),
        tags: String(form.get("tags") ?? "").split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        strength: Number(form.get("strength")),
      };
      try {
        await deps.callBackend("/relation/save", { relation, previous: edge });
        deps.notify("success", "人物关系已保存。");
        closeRelationModal();
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    modalRoot.querySelector("[data-action='deactivate-relation']")?.addEventListener("click", async () => {
      try {
        await deps.callBackend("/relation/deactivate", { relation: edge });
        deps.notify("success", "人物关系已停用。");
        closeRelationModal();
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function openRelationEditor(edge) {
    relationModal(edge);
  }

  function rangeValues() {
    const snapshot = deps.getChatSnapshot();
    if (snapshot.latestFloor < 0 || !snapshot.messages.length) {
      throw new Error("当前没有可分析的聊天楼层，请先打开一份聊天记录。");
    }
    const startInput = document.querySelector("#ccm-analysis-start");
    const endInput = document.querySelector("#ccm-analysis-end");
    const startRaw = String(startInput?.value ?? state.analysisRangeStart).trim();
    const endRaw = String(endInput?.value ?? state.analysisRangeEnd).trim();
    if (!startRaw || !endRaw) throw new Error("请填写起始楼层和终点楼层。");
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error("楼层必须填写整数。");
    }
    if (start < 0 || end > snapshot.latestFloor) {
      throw new Error(`楼层范围必须在 0-${snapshot.latestFloor} 之间。`);
    }
    if (end < start) throw new Error("终点楼层不能小于起始楼层。");
    const selected = snapshot.messages.filter((message) =>
      message.floor >= start && message.floor <= end);
    if (!selected.length) {
      const floors = snapshot.messages.map((message) => message.floor);
      throw new Error(
        `选择的 ${start}-${end} 楼没有聊天内容；当前消息分布在 ${Math.min(...floors)}-${Math.max(...floors)} 楼。`,
      );
    }
    state.analysisRangeStart = String(start);
    state.analysisRangeEnd = String(end);
    return { snapshot, start, end };
  }

  function showAnalysisNotice(type, message) {
    state.analysisNotice = { type, message: String(message || "") };
    const notice = view.querySelector("#ccm-analysis-notice");
    if (!notice) return;
    notice.className = `ccm-analysis-notice ${type}`;
    notice.textContent = state.analysisNotice.message;
    notice.hidden = false;
    notice.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function previewRange() {
    const { snapshot, start, end } = rangeValues();
    const selected = snapshot.messages.filter((message) =>
      message.floor >= start && message.floor <= end);
    modalRoot.innerHTML = `<dialog id="ccm-range-dialog" class="ccm-native-dialog">
      <div class="ccm-modal ccm-range-modal">
        <header><div><span>RANGE PREVIEW</span><h3>${start}-${end} 楼 · ${selected.length} 条消息</h3></div>
          <button type="button" data-modal-close>×</button></header>
        <p class="ccm-modal-note">这是选中的原始楼层。真正发送前，角色回复还会经过固定清洗。</p>
        <div class="ccm-range-list">${selected.map((message) => `
          <article><b>#${message.floor} · ${escapeHtml(message.is_user ? "用户" : message.name || "角色")}</b>
            <p>${escapeHtml(String(message.mes).slice(0, 500))}</p></article>`).join("")}</div>
        <footer><button type="button" data-modal-close>关闭</button></footer>
      </div></dialog>`;
    const dialog = modalRoot.querySelector("#ccm-range-dialog");
    const closeRangePreview = () => {
      if (dialog.open) dialog.close();
      modalRoot.innerHTML = "";
    };
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", closeRangePreview));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeRangePreview();
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  async function pollAnalysisJob(jobId) {
    for (let count = 0; count < 480; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await deps.callBackend("/analysis/status", { jobId });
      state.analysisJob = response.job;
      if (response.job.status !== "running") return response.job;
      if (state.activeTab === "analysis" && !overlay.classList.contains("ccm-hidden")) renderAnalysis();
    }
    throw new Error("前端等待超过 16 分钟；后台任务可能仍在运行，请稍后刷新查看。");
  }

  async function runAnalysisRange({ start, end, mode = "manual", autoAccept = false }) {
    if (state.analysisBusy) return null;
    state.analysisBusy = true;
    const snapshot = deps.getChatSnapshot();
    try {
      const response = await deps.callBackend("/analysis/start", {
        cardKey: snapshot.cardKey,
        chatKey: snapshot.chatKey,
        chatTitle: snapshot.chatTitle,
        startFloor: start,
        endFloor: end,
        mode,
        priorityCharacters: snapshot.priorityCharacters,
        messages: snapshot.messages,
      });
      state.analysisJob = response.job;
      if (state.activeTab === "analysis" && !overlay.classList.contains("ccm-hidden")) renderAnalysis();
      const job = await pollAnalysisJob(response.job.id);
      if (job.status === "failed") throw new Error(job.error || "人物分析失败。");
      state.analysisPreview = job;
      if (autoAccept) {
        await deps.callBackend("/analysis/accept", { jobId: job.id });
        state.analysisPreview = null;
        state.autoRetryAfter = 0;
        deps.notify("success", `自动人物更新已完成：${start}-${end} 楼。`);
        if (!overlay.classList.contains("ccm-hidden")) await loadWorkspace();
      } else {
        deps.notify("success", `人物分析完成：${start}-${end} 楼，请先预览再采纳。`);
        if (state.activeTab === "analysis" && !overlay.classList.contains("ccm-hidden")) renderAnalysis();
      }
      return job;
    } finally {
      state.analysisBusy = false;
      if (state.activeTab === "analysis" && !overlay.classList.contains("ccm-hidden")) renderAnalysis();
    }
  }

  async function autoCheck() {
    if (!cfg().analysisAutoEnabled || state.analysisBusy || Date.now() < state.autoRetryAfter) return;
    const snapshot = deps.getChatSnapshot();
    if (snapshot.latestFloor < 0 || snapshot.messages.at(-1)?.is_user) return;
    try {
      const response = await deps.callBackend("/workspace", {
        cardKey: snapshot.cardKey,
        cardName: snapshot.cardName,
        chatKey: snapshot.chatKey,
        chatTitle: snapshot.chatTitle,
      });
      if (!response.workspace?.binding?.libraryId) return;
      const processed = Number(response.workspace?.progress?.processedThrough ?? -1);
      const interval = Math.max(2, Math.min(100, Number(cfg().analysisInterval ?? 10)));
      const start = processed + 1;
      let end = start + interval - 1;
      if (end > snapshot.latestFloor) return;
      const endMessage = snapshot.messages.find((message) => message.floor === end);
      const followingMessage = snapshot.messages.find((message) => message.floor === end + 1);
      if (endMessage?.is_user) {
        if (!followingMessage || followingMessage.is_user) return;
        end += 1;
      }
      await runAnalysisRange({ start, end, mode: "auto", autoAccept: true });
    } catch (error) {
      state.autoRetryAfter = Date.now() + 5 * 60 * 1000;
      deps.notify("warning", `自动人物更新暂未完成：${error.message}（5 分钟后再试，不会跳过楼层）`);
    }
  }

  async function handleAction(action, button) {
    if (action === "reload") return loadWorkspace();
    if (action === "create-library") return libraryModal("create");
    if (action === "clone-library") return libraryModal("clone");
    if (action === "edit-library") return libraryModal("edit");
    if (action === "bind-chat") {
      const libraryId = selectedLibraryId();
      if (!libraryId) return deps.notify("warning", "请先从列表中选择一个档案库。");
      try {
        await deps.callBackend("/binding/chat/set", {
          ...currentContextPayload(),
          libraryId,
        });
        deps.notify("success", "当前聊天已单独绑定到所选档案库。");
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "unbind-chat") {
      try {
        const response = await deps.callBackend("/binding/chat/unset", currentContextPayload());
        deps.notify("success", response.message);
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "set-card-default") {
      const libraryId = selectedLibraryId();
      if (!libraryId) return deps.notify("warning", "请先从列表中选择一个档案库。");
      try {
        await deps.callBackend("/binding/card/set", {
          ...currentContextPayload(),
          libraryId,
        });
        deps.notify("success", "之后这张角色卡的新聊天会默认使用所选档案库。");
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "unset-card-default") {
      try {
        await deps.callBackend("/binding/card/unset", currentContextPayload());
        deps.notify("success", "已取消这张角色卡的默认档案库。");
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "add-relation") return relationModal();
    if (action === "edit-profile") {
      const profile = state.workspace?.profiles?.[button.dataset.key];
      if (profile) profileModal(profile, profile.last_batch_id === "manual");
      return;
    }
    if (action === "zoom-in") {
      state.zoom = Math.min(1.65, state.zoom + 0.15);
      return renderRelations();
    }
    if (action === "zoom-out") {
      state.zoom = Math.max(0.75, state.zoom - 0.15);
      return renderRelations();
    }
    if (action === "reset-graph") {
      try {
        await deps.callBackend("/graph/reset", { libraryId: state.workspace?.binding?.libraryId });
        state.positions = {};
        state.zoom = 1;
        renderRelations();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "run-recall") {
      try {
        state.recall = await deps.runRecall();
        renderRecall();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "preview-range") {
      try {
        previewRange();
      } catch (error) {
        showAnalysisNotice("error", `无法预览：${error.message}`);
      }
      return;
    }
    if (action === "run-analysis") {
      try {
        const { start, end } = rangeValues();
        await runAnalysisRange({ start, end });
      } catch (error) {
        showAnalysisNotice("error", `人物分析失败：${error.message}`);
      }
      return;
    }
    if (action === "accept-analysis") {
      try {
        await deps.callBackend("/analysis/accept", { jobId: state.analysisPreview?.id });
        deps.notify("success", "人物画像、成长与关系更新已采纳。");
        state.analysisPreview = null;
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "discard-analysis") {
      state.analysisPreview = null;
      renderAnalysis();
      return;
    }
    if (action === "save-analysis-settings") {
      cfg().analysisAutoEnabled = document.querySelector("#ccm-analysis-auto").checked;
      cfg().analysisInterval = Math.max(
        2,
        Math.min(100, Number(document.querySelector("#ccm-analysis-interval").value || 10)),
      );
      deps.saveSettings();
      const message = cfg().analysisAutoEnabled
          ? `自动人物更新已开启：每 ${cfg().analysisInterval} 楼执行一次。`
          : "自动人物更新保持关闭；手动分析仍可使用。";
      state.analysisNotice = { type: "success", message };
      renderAnalysis();
      deps.notify("success", message);
      return;
    }
    if (action === "save-analysis-config") {
      if (button.dataset.busy === "true") return;
      const originalHtml = button.innerHTML;
      button.dataset.busy = "true";
      button.disabled = true;
      button.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> 正在保存…`;
      try {
        const response = await deps.callBackend("/analysis/config/save", { config: {
          provider: document.querySelector("#ccm-analysis-provider").value,
          baseUrl: document.querySelector("#ccm-analysis-base-url").value.trim(),
          model: document.querySelector("#ccm-analysis-model").value.trim(),
          apiKey: document.querySelector("#ccm-analysis-key").value.trim(),
          thinkingMode: document.querySelector("#ccm-analysis-thinking").value,
          timeoutMs: Number(document.querySelector("#ccm-analysis-timeout").value || 10) * 60_000,
          prompt: document.querySelector("#ccm-analysis-prompt").value,
        } });
        state.analysisConfig = response.config;
        state.analysisNotice = { type: "success", message: "模型、API 配置和人物分析提示词已保存。" };
        renderAnalysis();
        deps.notify("success", state.analysisNotice.message);
      } catch (error) {
        showAnalysisNotice("error", `保存失败：${error.message}`);
      } finally {
        if (button.isConnected) {
          button.dataset.busy = "false";
          button.disabled = false;
          button.innerHTML = originalHtml;
        }
      }
      return;
    }
    if (action === "export-analysis-prompt") {
      downloadText("character-continuity-prompt.txt", document.querySelector("#ccm-analysis-prompt").value);
      return;
    }
    if (action === "revert-analysis-batch") {
      if (!window.confirm("撤回这批人物更新？插件会保留操作前备份。")) return;
      try {
        await deps.callBackend("/analysis/batch/revert", { batchId: button.dataset.batchId });
        deps.notify("success", "这批人物更新已撤回。");
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "save-settings") {
      const values = {
        enabled: document.querySelector("#ccm-ws-enabled").checked,
        recentMessages: Number(document.querySelector("#ccm-ws-recent").value),
        maxChars: Number(document.querySelector("#ccm-ws-chars").value),
        profileLimit: Number(document.querySelector("#ccm-ws-profiles").value),
        milestoneLimit: Number(document.querySelector("#ccm-ws-milestones").value),
        relationLimit: Number(document.querySelector("#ccm-ws-relations").value),
      };
      Object.assign(cfg(), values);
      deps.saveSettings();
      deps.notify("success", "人物连续性设置已保存。");
      await loadWorkspace();
      return;
    }
    if (action === "health") {
      try {
        const response = await deps.callBackend("/health");
        deps.notify("success", `后端正常 · v${response.version} · ${response.batches} 个批次`);
      } catch (error) {
        deps.notify("error", error.message);
      }
      return;
    }
    if (action === "import") {
      document.querySelector("#ccm-import-file").click();
      return;
    }
    if (action === "export") {
      try {
        const response = await deps.callBackend("/state/get");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadJson(`character-continuity-${stamp}.json`, response.state);
      } catch (error) {
        deps.notify("error", `导出失败：${error.message}`);
      }
    }
  }

  let lastTouchAction = { button: null, at: 0 };

  function actionButtonFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.find((node) =>
      node instanceof HTMLElement && node.dataset?.action)
      ?? (event.target instanceof Element
        ? event.target.closest("[data-action]")
        : event.target?.parentElement?.closest?.("[data-action]"));
  }

  function dispatchWorkspaceAction(event) {
    if (event.type === "pointerup" && event.pointerType === "mouse") return;
    const button = actionButtonFromEvent(event);
    if (!button || button.disabled || modalRoot.contains(button)) return;
    const now = Date.now();
    if (lastTouchAction.button === button && now - lastTouchAction.at < 800) return;
    if (event.type === "pointerup") {
      lastTouchAction = { button, at: now };
      event.preventDefault();
    }
    Promise.resolve(handleAction(button.dataset.action, button)).catch((error) => {
      deps.notify("error", `操作没有完成：${error.message}`);
    });
  }

  overlay.addEventListener("pointerup", dispatchWorkspaceAction, { capture: true });
  overlay.addEventListener("click", dispatchWorkspaceAction, { capture: true });
  view.addEventListener("change", (event) => {
    if (event.target.id === "ccm-graph-focus") {
      state.focus = event.target.value;
      renderRelations();
    }
  });
  view.addEventListener("input", (event) => {
    if (event.target.id === "ccm-analysis-start") {
      state.analysisRangeStart = event.target.value;
    }
    if (event.target.id === "ccm-analysis-end") {
      state.analysisRangeEnd = event.target.value;
    }
  });

  document.querySelectorAll(".ccm-nav").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".ccm-nav").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.activeTab = button.dataset.tab;
      render();
      if (window.innerWidth <= 760) sidebar.classList.add("collapsed");
    });
  });
  document.querySelector("#ccm-close").addEventListener("click", () => {
    close();
  });
  document.querySelector("#ccm-refresh").addEventListener("click", loadWorkspace);
  document.querySelector("#ccm-sidebar-toggle").addEventListener("click", () =>
    sidebar.classList.toggle("collapsed"));
  document.querySelector("#ccm-import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      await deps.callBackend("/state/replace", { state: imported, reason: `import-${file.name}` });
      deps.notify("success", "状态已导入，并自动保留旧版本备份。");
      await loadWorkspace();
    } catch (error) {
      deps.notify("error", `导入失败：${error.message}`);
    } finally {
      event.target.value = "";
    }
  });

  if (window.innerWidth <= 760) sidebar.classList.add("collapsed");

  return {
    open,
    close,
    refresh: loadWorkspace,
    setRecall(result) {
      state.recall = result;
      if (state.activeTab === "recall" && !overlay.classList.contains("ccm-hidden")) renderRecall();
    },
    syncSettings() {
      if (state.activeTab === "settings" && !overlay.classList.contains("ccm-hidden")) renderSettings();
    },
    autoCheck,
  };
}
