const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 660;

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

function profileKey(storyId, timelineId, character) {
  return `${normalizeId(storyId)}::${normalizeId(timelineId)}::${normalizeId(character)}`;
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
          <div><b>Character Continuity</b><span>人物连续性记忆</span></div>
        </div>
        <div class="ccm-header-actions">
          <span id="ccm-connection-pill" class="ccm-pill">未连接</span>
          <button id="ccm-refresh" class="ccm-icon-button" title="刷新"><i class="fa-solid fa-rotate"></i></button>
          <button id="ccm-close" class="ccm-icon-button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </header>
      <div class="ccm-layout">
        <nav id="ccm-sidebar" class="ccm-sidebar">
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
  };

  function cfg() {
    return deps.settings();
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
      const response = await deps.callBackend("/workspace", {
        storyId: cfg().storyId,
        timelineId: cfg().timelineId,
      });
      state.workspace = response.workspace;
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
    target.innerHTML = `
      <div><span>当前故事</span><b>${escapeHtml(cfg().storyId)}</b></div>
      <div><span>时间线</span><b>${escapeHtml(cfg().timelineId)}</b></div>
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
    const renderer = {
      profiles: renderProfiles,
      milestones: renderMilestones,
      relations: renderRelations,
      recall: renderRecall,
      settings: renderSettings,
    }[state.activeTab];
    renderer?.();
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
      const saved = state.positions[profileKey(cfg().storyId, cfg().timelineId, name)];
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
        const key = profileKey(cfg().storyId, cfg().timelineId, element.dataset.name);
        state.positions[key] = finished.position;
        try {
          await deps.callBackend("/graph/position", {
            storyId: cfg().storyId,
            timelineId: cfg().timelineId,
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
          <label>故事<input id="ccm-ws-story" type="text" value="${escapeHtml(current.storyId)}"></label>
          <label>时间线<input id="ccm-ws-timeline" type="text" value="${escapeHtml(current.timelineId)}"></label>
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

  function profileModal(profile, isManual) {
    const residualText = (profile.residual_patterns ?? []).map((item) =>
      [item.trigger, item.likely_response, item.counterweight].join("｜"),
    ).join("\n");
    modalRoot.innerHTML = `<div class="ccm-modal-backdrop">
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
      </form></div>`;
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", () => { modalRoot.innerHTML = ""; }));
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
        modalRoot.innerHTML = "";
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    modalRoot.querySelector("[data-action='release-profile']")?.addEventListener("click", async () => {
      try {
        await deps.callBackend("/profile/release", {
          storyId: profile.story_id,
          timelineId: profile.timeline_id,
          character: profile.character,
        });
        deps.notify("success", "已恢复模型生成版本。");
        modalRoot.innerHTML = "";
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
  }

  function openProfileEditorByName(name) {
    const entry = Object.entries(state.workspace?.profiles ?? {})
      .find(([, profile]) => profile.character === name);
    const profile = entry?.[1] ?? {
      story_id: cfg().storyId,
      timeline_id: cfg().timelineId,
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
      story_id: cfg().storyId,
      timeline_id: cfg().timelineId,
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
    modalRoot.innerHTML = `<div class="ccm-modal-backdrop">
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
      </form></div>`;
    modalRoot.querySelectorAll("[data-modal-close]").forEach((button) =>
      button.addEventListener("click", () => { modalRoot.innerHTML = ""; }));
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
        story_id: cfg().storyId,
        timeline_id: cfg().timelineId,
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
        modalRoot.innerHTML = "";
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
    modalRoot.querySelector("[data-action='deactivate-relation']")?.addEventListener("click", async () => {
      try {
        await deps.callBackend("/relation/deactivate", { relation: edge });
        deps.notify("success", "人物关系已停用。");
        modalRoot.innerHTML = "";
        await loadWorkspace();
      } catch (error) {
        deps.notify("error", error.message);
      }
    });
  }

  function openRelationEditor(edge) {
    relationModal(edge);
  }

  async function handleAction(action, button) {
    if (action === "reload") return loadWorkspace();
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
        await deps.callBackend("/graph/reset", { storyId: cfg().storyId, timelineId: cfg().timelineId });
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
    if (action === "save-settings") {
      const values = {
        enabled: document.querySelector("#ccm-ws-enabled").checked,
        storyId: document.querySelector("#ccm-ws-story").value.trim() || "默认故事",
        timelineId: document.querySelector("#ccm-ws-timeline").value.trim() || "主线",
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

  view.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button) handleAction(button.dataset.action, button);
  });
  view.addEventListener("change", (event) => {
    if (event.target.id === "ccm-graph-focus") {
      state.focus = event.target.value;
      renderRelations();
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
  };
}
