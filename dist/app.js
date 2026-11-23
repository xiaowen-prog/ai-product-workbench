/* AI 产品工厂 — production frontend. Same-origin API; server-authoritative workflow. */
const state = {
  projects: [],
  current: null,
  model: null,
  modelUnavailable: false,
  creating: false,
  helpOpen: false,
  inflightChats: new Set()
};
const CLIENT_STORAGE = "ai-workbench-client-drafts-v3";
const TAB_ID = (() => {
  try {
    const key = "ai-workbench-tab-id-v1";
    let value = window.sessionStorage.getItem(key);
    if (!value) {
      value = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      window.sessionStorage.setItem(key, value);
    }
    return value;
  } catch (_) {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
const TAB_PENDING_STORAGE = `${CLIENT_STORAGE}:pending:${TAB_ID}`;
const safety = {
  ...readClientState(),
  serverIds: new Set(),
  authoritativeProjects: new Map(),
  busy: new Set(),
  selection: 0,
  writeEpoch: 0,
  development: {},
  workshopErrors: {},
  previews: {},
  playgrounds: {},
  stageChoices: {},
  planRevisionPreview: {},
  trialFeedbackOpen: {},
  lastError: "",
  renderScheduled: false
};
const online = false;
const $ = selector => document.querySelector(selector);
const modePill = document.querySelector(".mode-pill");
if (modePill)
  modePill.innerHTML = `<span class="status-dot"></span>${ "本地 API \xB7 JSON 可恢复" }`;
const footerMode = document.querySelector("footer span");
if (footerMode)
  footerMode.textContent = "AI 产品工厂 \xB7 本地 API";
function escapeHtml(value) {
  return presentCopy(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  }[char]));
}
function presentCopy(value) {
  return String(value ?? "")
    .replace(/老师\s*Agent\s*工坊/g, "内容说明")
    .replace(/阶段\s*Agent/g, "我的代码")
    .replace(/老师工具包/g, "阶段工具包")
    .replace(/老师/g, "系统");
}
function showError(message) {
  safety.lastError = message;
  const panel = $("#errorPanel");
  panel.textContent = message;
  panel.classList.remove("hidden");
  renderRecovery();
}
function clearError() {
  safety.lastError = "";
  $("#errorPanel").classList.add("hidden");
}
function statusOf(project) {
  return project?.status || "";
}
const KNOWN_STATUSES = [
  "idea",
  "needs_discovery",
  "needs_intent_confirmation",
  "needs_plan_confirmation",
  "backend_building",
  "backend_verified",
  "preview_ready",
  "trial"
];
function isKnownStatus(status) {
  return KNOWN_STATUSES.includes(status);
}
function isUnknownProject(project) {
  return Boolean(project) && !isKnownStatus(statusOf(project));
}
function isPreviewVerified(project) {
  return project?.preview?.status === "verified";
}
function hasTrialFeedback(project) {
  return Array.isArray(project?.trial?.feedback) && project.trial.feedback.some(item => String(item || "").trim());
}
function isPlanRevising(project) {
  return project?.plan_revision?.status === "needs_input";
}
function pickModelStatus(payload) {
  return {
    configured: payload?.configured === true,
    required: payload?.required !== false,
    teacher_workflow: payload?.teacher_workflow === true,
    can_build: payload?.can_build === true
  };
}
function canStartTrial(project) {
  if (!project || statusOf(project) !== "preview_ready")
    return false;
  return isPreviewVerified(project);
}
function stageGate(project) {
  const backend = projectBackend(project);
  const development = safety.development[project.id] || {};
  const options = list(backend.next_stage_options).length ? list(backend.next_stage_options) : list(development.next_stage_options);
  const fixed = backend.next_stage_fixed || development.next_stage_fixed || null;
  const labels = Object.assign({}, development.next_stage_labels || {}, backend.next_stage_labels || {});
  return {
    kind: options.length ? "choice" : fixed ? "fixed" : "unknown",
    fixed,
    options,
    labels
  };
}
function selectedNextStage(project) {
  const gate = stageGate(project);
  if (gate.kind === "fixed") return gate.fixed;
  return safety.stageChoices[project.id] || "";
}
function canSubmitTrialFeedback(project) {
  return Boolean(project) && statusOf(project) === "trial";
}
function canCreateNextVersion(project) {
  return canSubmitTrialFeedback(project) && hasTrialFeedback(project);
}
function previewStageView(project) {
  const previewReady = statusOf(project) === "preview_ready";
  const runtimeReady = isPreviewVerified(project);
  ;
  return {
    mode: "api",
    previewReady,
    runtimeReady,
    exampleViewed: false,
    canTrial: canStartTrial(project),
    title: !previewReady ? "" : runtimeReady ? "编码产物已验证" : "先验证编码产物",
    chip: runtimeReady ? "产物已验证" : "产物未验证",
    chipKind: runtimeReady ? "preview-verified" : "preview-pending",
    openLabel: runtimeReady ? "打开编码产物" : "验证编码产物",
    startEnabled: canStartTrial(project),
    startDisabledReason: "先验证编码产物的页面、健康检查和核心动作",
    previewLabel: runtimeReady ? "编码产物预览" : "编码产物未验证",
    previewState: runtimeReady ? "本机探测通过" : "尚未探测到可运行产物",
    copy: "方案试玩只是按已确认方案模拟，不能代替编码产物验证，也不会让试用入口变为已通过。只有本机产品的页面、健康检查和核心动作都实际探测通过，才能开始试用。当前主流程不包含反向源码差距检查，阶段工具包里的反向/审计对照尚未接到这条产品链。"
  };
}
function statusLabel(status, project) {
  if (!isKnownStatus(status))
    return "无法识别";
  if (status === "preview_ready") {
    ;
    return isPreviewVerified(project) ? "产物已验证" : "产物未验证";
  }
  if (status === "trial") {
    if (!hasTrialFeedback(project))
      return "试用与反馈";
    const outcome = project?.trial?.outcome;
    if (outcome === "needs_change" || outcome === "blocked")
      return "需要修改";
    return "试用反馈已记录";
  }
  if (status === "needs_plan_confirmation" && isPlanRevising(project))
    return "需要修改";
  return {
    idea: "想法",
    needs_discovery: "需求发现",
    needs_intent_confirmation: "需求确认",
    needs_plan_confirmation: "方案确认",
    backend_building: "后端开发中",
    backend_verified: "等你验收"
  }[status] || "无法识别";
}
function sourceLabel(project) { return state.model?.required === false ? "后端 mock 方案" : "后端返回的方案"; }

function phaseForStatus(status, project) {
  if (status === "idea")
    return 0;
  if (!isKnownStatus(status))
    return -1;
  if (status === "needs_discovery")
    return 1;
  if (status === "needs_intent_confirmation")
    return 2;
  if (status === "needs_plan_confirmation")
    return 3;
  if (status === "backend_building")
    return 4;
  if (status === "backend_verified")
    return 5;
  if (status === "preview_ready")
    return 6;
  if (status === "trial")
    return 7;
  return -1;
}
function resultKind(status, project) {
  if (!project)
    return "progress";
  if (!isKnownStatus(status))
    return "unknown";
  if (status === "needs_plan_confirmation" && isPlanRevising(project))
    return "revise";
  if (status === "idea" || status === "needs_discovery" || status === "backend_building")
    return "progress";
  if (status === "needs_intent_confirmation" || status === "needs_plan_confirmation" || status === "backend_verified")
    return "confirm";
  if (status === "preview_ready") {
    ;
    return isPreviewVerified(project) ? "preview-verified" : "preview-pending";
  }
  if (status === "trial") {
    const outcome = project?.trial?.outcome;
    if (hasTrialFeedback(project) && (outcome === "needs_change" || outcome === "blocked"))
      return "revise";
    if (hasTrialFeedback(project))
      return "done";
    return "confirm";
  }
  return "progress";
}
function applyChipClass(el, kind) {
  if (!el)
    return;
  el.className = "status-chip";
  const map = {
    progress: "is-progress",
    confirm: "is-confirm",
    done: "is-done",
    revise: "is-revise",
    "preview-pending": "is-preview-pending",
    "preview-verified": "is-preview-verified",
    "example-pending": "is-progress",
    "example-viewed": "is-confirm",
    unknown: "is-unknown"
  };
  el.classList.add(map[kind] || "is-progress");
}
function chipText(status, project) {
  if (!project)
    return "想法";
  const version = versionLabel(project);
  if (!isKnownStatus(status))
    return `无法识别${ version }`;
  if (status === "preview_ready")
    return `${ statusLabel(status, project) }${ version }`;
  if (status === "trial") {
    if (!hasTrialFeedback(project))
      return `试用与反馈${ version }`;
    if (resultKind(status, project) === "revise")
      return `需要修改${ version }`;
    return `试用反馈已记录${ version }`;
  }
  if (status === "needs_plan_confirmation" && isPlanRevising(project))
    return `需要修改${ version }`;
  if (status === "backend_building")
    return `后端开发中${ version }`;
  if (status === "backend_verified")
    return `等你验收${ version }`;
  if (status === "needs_plan_confirmation" && project?.plan && !planReviewPassed(project.plan))
    return `待重新审稿${ version }`;
  if (status === "needs_plan_confirmation" && project?.plan) {
    const blockers = planBlockers(project);
    if (blockers.some(item => /方案问题|待确认项|审稿缺口/.test(item)))
      return `待补齐方案问题${ version }`;
  }
  if (status === "needs_intent_confirmation" || status === "needs_plan_confirmation")
    return `等你确认${ version }`;
  const labels = [
    "想法",
    "需求发现",
    "需求确认",
    "方案确认",
    "后端开发",
    "后端验收",
    "产品预览",
    "试用与反馈"
  ];
  return `${ labels[phaseForStatus(status, project)] || statusLabel(status, project) }${ version }`;
}
function taskCopy(project, creating) {
  if (creating) {
    return {
      kicker: "新建项目",
      title: "再写一个新想法",
      decision: "用一句话写下要做的产品\u3002当前任务还在\uFF0C可以随时返回\u3002",
      next: "返回后继续当前任务\uFF0C或开始一个新项目"
    };
  }
  if (!project) {
    return {
      kicker: "新的可能\uFF0C从这里开始",
      title: "把一个想法\uFF0C\n做成第一版\u3002",
      decision: "从你想解决的一个小问题开始\u3002",
      next: "完成后进入\uFF1A需求发现"
    };
  }
  const status = statusOf(project);
  const title = project.idea || "未命名项目";
  const kicker = project.version > 1 ? `当前任务 · V${ project.version }` : "当前任务";
  if (isUnknownProject(project))
    return {
      kicker,
      title,
      decision: "当前状态无法识别\uFF0C请重新加载或返回列表",
      next: "不会进入后端验收或试用"
    };
  if (status === "needs_discovery")
    return {
      kicker,
      title,
      decision: "回答会改变方向的问题",
      next: "完成后进入\uFF1A系统判断是否还需追问\uFF0C或进入需求确认"
    };
  if (status === "needs_intent_confirmation")
    return {
      kicker,
      title,
      decision: "确认用户\u3001问题和范围是否准确",
      next: "完成后进入\uFF1A方案确认"
    };
  if (status === "needs_plan_confirmation" && isPlanRevising(project))
    return {
      kicker,
      title,
      decision: "说明方案要改哪一处",
      next: "完成后进入\uFF1A仍在方案确认"
    };
  if (status === "needs_plan_confirmation")
    return {
      kicker,
      title,
      decision: "确认这份方案能否作为开发输入",
      next: "完成后进入\uFF1A后端开发"
    };
  if (status === "backend_building")
    return {
      kicker,
      title,
      decision: "等待或刷新开发状态",
      next: "完成后进入\uFF1A后端验收"
    };
  if (status === "backend_verified")
    return {
      kicker,
      title,
      decision: "验收这次后端交付",
      next: "完成后进入\uFF1A产品预览\uFF08待验证\uFF09"
    };
  if (status === "preview_ready" && online) {
    if (!isMockExampleViewed(project))
      return {
        kicker,
        title,
        decision: "查看这份产品示例\u3002这不是真实运行时验证\u3002",
        next: "查看示例后可以开始试用"
      };
    return {
      kicker,
      title,
      decision: "开始试用并准备记录结果",
      next: "完成后进入\uFF1A试用与反馈"
    };
  }
  if (status === "preview_ready" && !isPreviewVerified(project))
    return {
      kicker,
      title,
      decision: "先完成页面\u3001健康检查和核心动作验证",
      next: "完成后进入\uFF1A预览已验证后可开始试用"
    };
  if (status === "preview_ready")
    return {
      kicker,
      title,
      decision: "开始试用并准备记录结果",
      next: "完成后进入\uFF1A试用与反馈"
    };
  if (status === "trial" && !hasTrialFeedback(project))
    return {
      kicker,
      title,
      decision: "记录一次试用结果和文字反馈",
      next: "完成后进入\uFF1A反馈写入后才能加新需求"
    };
  if (status === "trial")
    return {
      kicker,
      title,
      decision: "决定是否开启下一版",
      next: "完成后进入：新版本的需求发现（新项目和新开发目录，不继承上一版代码）"
    };
  return {
    kicker,
    title,
    decision: "继续当前任务",
    next: ""
  };
}
function setFlow(step, project) {
  const status = project ? statusOf(project) : "idea";
  const kind = resultKind(status, project);
  [...document.querySelectorAll(".flow-item")].forEach((item, index) => {
    item.classList.toggle("active", index === step);
    item.classList.toggle("done", index < step);
    item.classList.remove("revise", "preview-pending", "preview-verified", "is-confirm");
    const stateEl = item.querySelector(".flow-state");
    if (!stateEl)
      return;
    if (step < 0) {
      stateEl.textContent = "无法识别";
      item.classList.remove("active", "done");
      return;
    }
    if (index < step) {
      stateEl.textContent = "已完成";
      return;
    }
    if (index > step) {
      stateEl.textContent = "未开始";
      return;
    }
    if (step === 6 && project) {
      ;
      const verified = isPreviewVerified(project);
      stateEl.textContent = verified ? "预览已验证" : "预览待验证";
      item.classList.add(verified ? "preview-verified" : "preview-pending");
      return;
    }
    if (step === 7 && project) {
      if (!hasTrialFeedback(project)) {
        stateEl.textContent = "等你确认";
        item.classList.add("is-confirm");
      } else if (kind === "revise") {
        stateEl.textContent = "需要修改";
        item.classList.add("revise");
      } else {
        stateEl.textContent = "已完成";
      }
      return;
    }
    if (kind === "revise") {
      stateEl.textContent = "需要修改";
      item.classList.add("revise");
    } else if (kind === "confirm") {
      stateEl.textContent = "等你确认";
      item.classList.add("is-confirm");
    } else
      stateEl.textContent = "进行中";
  });
}
function syncEntry(project, creating = false) {
  const shell = $("#workbenchShell");
  shell?.classList.toggle("is-entry", !project || creating);
  const form = $("#ideaForm");
  const bar = $("#newProjectBar");
  const intro = $("#introBlock");
  const cancel = $("#cancelNewProjectButton");
  const copy = taskCopy(project, creating);
  if (!form || !bar)
    return;
  form.classList.toggle("hidden", Boolean(project) && !creating);
  bar.classList.add("hidden");
  if (intro)
    intro.classList.toggle("hidden", Boolean(state.current));
  if (cancel)
    cancel.classList.toggle("hidden", !(creating && state.current));
  const kicker = $("#entryKicker");
  const title = $("#entryTitle");
  if (kicker)
    kicker.textContent = project && !creating ? `当前项目 · V${project.version || 1}` : copy.kicker;
  if (title) {
    title.textContent = project && !creating ? project.idea || "未命名项目" : copy.title;
    if (project?.idea && !creating)
      title.title = project.idea;
    else
      title.removeAttribute("title");
  }
  const decision = $("#taskDecision");
  const next = $("#taskNext");
  if (decision)
    decision.textContent = copy.decision;
  if (next)
    next.textContent = copy.next;
  const status = project && !creating ? statusOf(project) : "idea";
  const kind = creating ? "progress" : resultKind(status, project);
  applyChipClass($("#phaseLabel"), kind);
  if ($("#phaseLabel"))
    $("#phaseLabel").textContent = creating ? "新建项目" : chipText(status, project);
  const summary = bar.querySelector(".current-project-summary");
  if (summary && state.current) {
    const idea = summary.querySelector("strong");
    const meta = summary.querySelector("small");
    if (idea)
      idea.textContent = state.current.idea || "未命名项目";
    if (meta)
      meta.textContent = `${ statusLabel(statusOf(state.current), state.current) }${ versionLabel(state.current) }`;
  }
}
function canStartBuild() {
  return modelGate().allowed;
}
function setStartButton(start, {disabled, loading, label}) {
  if (!start)
    return;
  const span = start.querySelector("span");
  start.disabled = Boolean(disabled);
  start.classList.toggle("is-loading", Boolean(loading));
  if (span)
    span.textContent = label;
}
function setActionBusy(button, label) {
  if (!button)
    return;
  const textNode = button.querySelector("span:not(.button-arrow)") || button;
  button.dataset.originalLabel = textNode.textContent;
  button.disabled = true;
  button.classList.add("is-loading");
  textNode.textContent = label;
}
function restoreAction(button) {
  if (!button)
    return;
  const textNode = button.querySelector("span:not(.button-arrow)") || button;
  if (button.dataset.originalLabel)
    textNode.textContent = button.dataset.originalLabel;
  button.disabled = false;
  button.classList.remove("is-loading");
}
function renderStartGate() {
  const gate = $("#setupGate"), start = $("#startBuildButton");
  if (!gate || !start)
    return;
  const info = modelGate();
  gate.classList.toggle("hidden", info.allowed && state.model?.required !== false);
  gate.innerHTML = `<strong>${ escapeHtml(info.label) }</strong><span>${ escapeHtml(info.reason) }</span><button type="button" id="refreshModelButton" class="text-button">重新检查连接</button>`;
  $("#refreshModelButton")?.addEventListener("click", loadModelStatus);
  setStartButton(start, {
    disabled: !info.allowed || safety.busy.size > 0 || Boolean(safety.pending.create),
    loading: !state.model,
    label: "开始需求澄清"
  });
}
function renderWelcomeGuide() {
  const guide = $("#welcomeGuide");
  if (!guide)
    return;
  const seen = storageGet("ai-workbench-onboarding-seen-v1") === "1";
  const helpOpen = state.helpOpen === true;
  if (!helpOpen && (state.creating || state.current || seen)) {
    guide.classList.add("hidden");
    return;
  }
  const intro = helpOpen ? "这里把内容说明与开发工具包串成同一条流程。当前流程会按六个需求维度追问，通常要走完这些轮次才会出需求稿；下一版会新建项目和开发目录，不自动继承上一版代码；主流程不包含反向源码差距检查。模型由本地后端调用，每个确认点都由你决定。" : "这里把内容说明与开发工具包串成同一条流程。模型由本地后端调用，每个确认点都由你决定。";
  const firstStep = modelGate().allowed ? "说出想法，完成自然语言澄清" : modelGate().reason;
  const secondStep = "核对需求稿、补齐方案问题，等待独立审稿通过";
  const thirdStep = "分阶段交给外部编码，完成自检与明确验收，再验证预览、试用反馈";
  guide.classList.remove("hidden");
  guide.innerHTML = `<div class="welcome-head"><span class="section-kicker">${ helpOpen ? "使用说明" : "第一次使用" }</span><button id="dismissWelcomeGuide" class="guide-dismiss" type="button">${ helpOpen ? "关闭说明" : "知道了" }</button></div><h3>${ helpOpen ? "这套工作台怎么用\uFF1F" : "第一次使用\uFF0C先看这 3 步" }</h3><p>${ intro }</p><ol class="welcome-steps"><li>${ escapeHtml(firstStep) }</li><li>${ escapeHtml(secondStep) }</li><li>${ escapeHtml(thirdStep) }</li></ol>`;
  $("#dismissWelcomeGuide")?.addEventListener("click", () => {
    if (helpOpen)
      state.helpOpen = false;
    else
      storageSet("ai-workbench-onboarding-seen-v1", "1");
    renderWelcomeGuide();
  });
}
function showOnly(...ids) {
  [
    "#questionPanel",
    "#planPanel",
    "#previewPanel"
  ].forEach(id => $(id).classList.toggle("hidden", !ids.includes(id)));
}
function projectDiscovery(project) {
  return project?.discovery || project?.evidence || {};
}
function projectIntent(project) {
  return project?.intent || projectDiscovery(project).intent || {};
}
function projectBackend(project) {
  return project?.backend || project?.engineering || {};
}
function list(value, fallback = []) {
  return Array.isArray(value) && value.length ? value : fallback;
}
function displayItem(item) {
  return item && typeof item === "object" ? item.text || item.message || item.kind || JSON.stringify(item) : item;
}
function listHtml(value, fallback = ["待补充"]) {
  return list(value, fallback).map(item => `<li>${ escapeHtml(displayItem(item)) }</li>`).join("");
}
function now() {
  return new Date().toISOString();
}
function replaceProject(project, select = false) {
  if (!project?.id || typeof project.status !== "string")
    return;
  state.projects = [
    project,
    ...state.projects.filter(item => item.id !== project.id)
  ];
  safety.serverIds.add(project.id);
  safety.authoritativeProjects.set(project.id, structuredClone(project));
  if (select || state.current?.id === project.id)
    state.current = project;
  persist();
}
function transition(project, nextStatus, meta = {}) {
  const from = statusOf(project);
  project.events = Array.isArray(project.events) ? project.events : [];
  project.events.push({
    id: `evt_${ Date.now() }_${ project.events.length }`,
    from,
    to: nextStatus,
    actor: meta.actor || "user",
    input_version: project.version || 1,
    output_version: project.version || 1,
    evidence: meta.evidence || [],
    pending: meta.pending || [],
    at: now()
  });
  project.status = nextStatus;
  project.updated_at = now();
}
function versionLabel(project) {
  return project?.version && project.version > 1 ? ` · V${ project.version }` : "";
}
function renderProjects() {
  const listEl = $("#projectList");
  const confirmed = state.projects.filter(p => safety.serverIds.has(p.id));
  const cached = state.projects.filter(p => !safety.serverIds.has(p.id));
  const row = (project, local = false) => `<button class="project-item ${state.current?.id === project.id ? "selected" : ""}" data-project-id="${escapeHtml(project.id)}" type="button"><strong>${escapeHtml(project.idea)}${escapeHtml(versionLabel(project))}</strong><small>${local ? "仅本地缓存 · 未由服务器确认" : statusLabel(statusOf(project), project)}${!local && isHistorical(project) ? " · 历史版本" : ""}</small></button>`;
  listEl.innerHTML = (confirmed.map(p=>row(p)).join("") || '<div class="empty-projects">暂无服务器项目</div>') + (cached.length ? `<details class="cached-projects"><summary>本地保留记录 · ${cached.length}</summary><p>不会据此判断服务器阶段或历史版本。</p>${cached.map(p=>row(p,true)).join("")}</details>` : "");
  listEl.querySelectorAll("[data-project-id]").forEach(button => button.addEventListener("click", () => { setNavigationOpen(false); loadProject(button.dataset.projectId); }));
}
function renderBase() {
  renderWelcomeGuide();
  const project = state.current;
  if (state.creating) {
    syncEntry(project, true);
    renderStartGate();
    showOnly();
    setFlow(0, project);
    renderProjects();
    return;
  }
  syncEntry(project, false);
  if (!project) {
    renderStartGate();
    showOnly();
    setFlow(0, null);
    renderProjects();
    return;
  }
  if (isUnknownProject(project)) {
    setFlow(-1, project);
    renderUnknownStatus(project);
    renderProjects();
    return;
  }
  const status = statusOf(project);
  setFlow(phaseForStatus(status, project), project);
  if (status === "needs_discovery" && !project.workshop)
    renderWorkshopResume(project);
  else if (status === "needs_discovery")
    renderDiscovery(project);
  else if (shouldShowPlanProgress(project))
    renderPlanProgress(project, state.planProgress?.progress || {});
  else if (status === "needs_intent_confirmation")
    renderRequirements(project);
  else if (status === "needs_plan_confirmation")
    renderPlanConfirmation(project);
  else if (status === "backend_building")
    renderBackend(project, false);
  else if (status === "backend_verified" || status === "preview_ready")
    renderBackend(project, true);
  else if (status === "trial")
    renderTrial(project);
  else
    renderUnknownStatus(project);
  renderProjects();
}
function renderWorkshopResume(project) {
  // Reading saved history never requires a POST, even if a stale selected snapshot lacks workshop.
  const canonical = safety.authoritativeProjects.get(project.id);
  if (canonical?.workshop?.transcript?.length) {
    project.workshop = structuredClone(canonical.workshop);
    if (project.status === "needs_discovery") { renderDiscovery(project); return; }
  }
  showOnly("#questionPanel");
  const panel = $("#questionPanel"), confirmed = safety.serverIds.has(project.id);
  const operation = safety.pending[project.id];
  const resuming = safety.busy.has(project.id) && operation?.path.endsWith("/workshop-resume");
  const uncertain = operation && !safety.busy.has(project.id);
  const failed = safety.workshopErrors[project.id];
  const hasPriorEvidence = Object.keys(project.answers || {}).length > 0 || Number(project.discovery_round || 0) > 0;
  panel.dataset.taskLayout = "compact";
  let heading = !confirmed ? "先读取已保存的对话" : hasPriorEvidence ? "继续已有项目的需求澄清" : "开始需求澄清";
  let copy = !confirmed ? "尚未从服务器确认对话记录。请先重新读取；已有历史会直接显示，不会重新开始。" : hasPriorEvidence ? "服务器还没有返回需求对话记录。开始后会带上已保存的需求信息，不会替你确认需求或推进开发。" : "项目已创建，需求对话尚未开始。点击开始后，系统会根据你的想法提出第一个问题。";
  if (resuming) { heading = "系统正在准备回复"; copy = "这次请求只发送一次。后端正在处理，尚未返回系统回复；不会显示虚构问题。"; }
  else if (uncertain) { heading = "先确认上一次开始请求的结果"; copy = "连接中断不代表请求未执行。请用上方恢复提示重新查询，未经你确认不会重发。"; }
  else if (failed) { heading = "需求对话暂未开始"; copy = "后端返回了失败结果，没有生成系统消息。可以重新查询；确认需要再次调用时，再点击开始。"; }
  const label = resuming ? "正在等待系统回复" : uncertain ? "等待查询结果" : hasPriorEvidence ? "继续需求澄清" : "开始需求澄清";
  panel.innerHTML = `<section class="workshop-entry" aria-label="需求对话入口"><h3>${escapeHtml(heading)}</h3><p class="panel-copy">${escapeHtml(copy)}</p><p class="workshop-entry-status" role="status">${resuming ? "请求已发送 · 等待后端" : uncertain ? "执行结果待确认 · 不会自动重试" : failed ? "上次请求失败 · 尚无新增消息" : "不会自动调用模型，由你点击开始"}</p><div class="panel-actions">${confirmed ? `<button class="primary-button" id="resumeWorkshopButton" type="button" ${resuming || uncertain ? "disabled" : ""}>${escapeHtml(label)}</button>` : ""}<button id="refreshWorkshopButton" class="secondary-button" type="button">重新读取已有对话</button></div></section>`;
  panel.querySelector("#resumeWorkshopButton")?.addEventListener("click", event => workshopAction(project,"workshop-resume",event.currentTarget,"正在等待系统回复"));
  panel.querySelector("#refreshWorkshopButton").onclick = () => loadProject(project.id);
}
function renderWorkshopTranscript(project, extra = "") {
  const messages = list(project.workshop?.transcript).filter(message => String(message?.text || "").trim());
  const transcript = messages.map(message => `<div class="teacher-chat-message is-${ message.role === "user" ? "user" : "assistant" }"><span class="teacher-chat-role">${ message.role === "user" ? "你" : "我的代码" }</span><p>${ escapeHtml(message.role === "user" ? message.text : presentCopy(message.text)) }</p></div>`).join("");
  return `<div class="teacher-chat-thread">${ transcript }${ extra }</div>`;
}
function workshopQuestionProgress(project) {
  const total = Object.keys(project.workshop?.originals || {}).length;
  const pending = list(project.workshop?.pending);
  if (!total)
    return "";
  return `第 ${ Math.min(total, total - pending.length + 1) } / ${ total } 题`;
}
async function workshopAction(project, action, button, busy, body = undefined) {
  if (action === "workshop-resume") delete safety.workshopErrors[project.id];
  setActionBusy(button, busy);
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/${ action }`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined
    });
    replaceProject(payload.project);
    if (action === "workshop-resume") delete safety.workshopErrors[project.id];
    render();
  } catch (error) {
    if (action === "workshop-resume") safety.workshopErrors[project.id] = true;
    restoreAction(button);
    showError(error.message);
    render();
  }
}
function bindWorkshopQuestion(project, panel, question) {
  panel.querySelectorAll("[data-question-option], [data-question-recommend]").forEach(button => {
    button.addEventListener("click", () => selectQuestionOption(button.closest("[data-question-card]"), button.dataset.optionValue || button.dataset.recommendValue));
  });
  panel.querySelector("#answerButton")?.addEventListener("click", submitAnswers);
  panel.querySelector("#workshopOptionsButton")?.addEventListener("click", event => {
    workshopAction(project, `questions/${ encodeURIComponent(question.id) }/options`, event.currentTarget, "正在准备选项");
  });
  panel.querySelectorAll("[data-workshop-save]").forEach(button => {
    button.addEventListener("click", event => workshopAction(project, "replan", event.currentTarget, "正在保存并重新推导"));
  });
  panel.querySelectorAll("[data-workshop-reply]").forEach(button => {
    button.addEventListener("click", () => workshopAction(project, "answers", button, "正在整理回答", { answers: { [question.id]: button.dataset.workshopReply } }));
  });
}
function renderUnknownStatus(project) {
  showOnly("#previewPanel");
  const raw = statusOf(project) || "空";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">项目状态</span><h3>无法识别当前项目状态</h3></div><span class="status-chip is-unknown">无法识别</span></div><p class="panel-copy">当前状态「${ escapeHtml(raw) }」不在已知流程里，所以没有给出后端验收或试用操作，避免误入下一步。你可以重新加载项目，或返回项目列表。</p><div class="panel-actions"><button class="primary-button" id="reloadUnknownProjectButton" type="button">重新加载项目</button><button class="secondary-button" id="returnFromUnknownButton" type="button">返回项目列表</button></div>`;
  $("#reloadUnknownProjectButton").addEventListener("click", () => loadProject(project.id));
  $("#returnFromUnknownButton").addEventListener("click", () => {
    state.current = null;
    ;
    render();
  });
}
const QUESTION_OPTION_CATALOG = {
  target_user: [
    {
      id: "A",
      label: "个人创作者",
      description: "独立工作者\u3001自由职业者或个人用户",
      recommended: true
    },
    {
      id: "B",
      label: "小团队或工作室",
      description: "需要协作完成同一项工作的几个人"
    },
    {
      id: "C",
      label: "企业或组织",
      description: "有部门\u3001权限或流程要求的团队"
    }
  ],
  problem: [
    {
      id: "A",
      label: "整理和沟通成本高",
      description: "信息分散\uFF0C需要反复整理\u3001确认或转述",
      recommended: true
    },
    {
      id: "B",
      label: "协作和流程容易断",
      description: "多人或多工具之间难以持续推进"
    },
    {
      id: "C",
      label: "结果不稳定或难验收",
      description: "同样的任务每次结果差异很大"
    }
  ],
  desired_outcome: [
    {
      id: "A",
      label: "一份可以直接使用的结果",
      description: "例如报价单\u3001方案或整理后的文档",
      recommended: true
    },
    {
      id: "B",
      label: "清楚的下一步行动",
      description: "知道接下来该做什么\u3001由谁来做"
    },
    {
      id: "C",
      label: "自动完成一段重复工作",
      description: "减少复制\u3001整理或反复检查"
    }
  ],
  current_workaround: [
    {
      id: "A",
      label: "手工处理或使用表格",
      description: "靠复制\u3001整理和人工检查完成",
      recommended: true
    },
    {
      id: "B",
      label: "多个工具拼接使用",
      description: "在聊天\u3001文档\u3001表格之间来回切换"
    },
    {
      id: "C",
      label: "目前没有固定办法",
      description: "遇到一次解决一次\uFF0C没有稳定流程"
    }
  ],
  constraints: [
    {
      id: "A",
      label: "先做本地单用户",
      description: "不接入外部账号\uFF0C不自动发布",
      recommended: true
    },
    {
      id: "B",
      label: "需要多人在线协作",
      description: "首版就要支持共享或权限"
    },
    {
      id: "C",
      label: "需要接入已有系统",
      description: "要连接企业内部数据或已有工具"
    }
  ],
  affected_area: [
    {
      id: "A",
      label: "需求和流程",
      description: "改变用户目标\u3001步骤或判断方式",
      recommended: true
    },
    {
      id: "B",
      label: "方案和后端",
      description: "改变功能\u3001接口或数据结构"
    },
    {
      id: "C",
      label: "预览和体验",
      description: "主要改变界面\u3001展示或试用方式"
    }
  ]
};
function questionOptions(question) {
  return Array.isArray(question.options) && question.options.length ? question.options : QUESTION_OPTION_CATALOG[question.id] || [];
}
function optionMatchesAnswer(option, value) {
  const answer = String(value || "").trim();
  return answer === option.label || answer.startsWith(`${ option.label }；`);
}
function renderQuestionCard(question, answer) {
  const options = questionOptions(question);
  if (!options.length) {
    return `<div class="question-card"><label for="answer-${ escapeHtml(question.id) }">${ escapeHtml(question.text) }</label><input id="answer-${ escapeHtml(question.id) }" data-question-id="${ escapeHtml(question.id) }" value="${ escapeHtml(answer) }" placeholder="${ escapeHtml(question.hint || "用自己的话回答即可") }" autocomplete="off" /><small>${ escapeHtml(question.reason || "这会影响需求\u3001范围或验收") }</small></div>`;
  }
  const recommended = options.find(option => option.recommended) || options[0];
  return `<div class="question-card" data-question-card="${ escapeHtml(question.id) }"><div class="question-label">${ escapeHtml(question.text) }</div><div class="question-options" role="group" aria-label="${ escapeHtml(question.text) }">${ options.map(option => `<button class="question-option${ optionMatchesAnswer(option, answer) ? " is-selected" : "" }" data-question-option="${ escapeHtml(question.id) }" data-option-value="${ escapeHtml(option.label) }" type="button" aria-pressed="${ optionMatchesAnswer(option, answer) }"><span class="question-option-key">${ escapeHtml(option.id) }</span><span class="question-option-copy"><strong>${ escapeHtml(option.label) }</strong><small>${ escapeHtml(option.description || "") }</small></span>${ option.recommended ? "<span class=\"question-option-badge\">推荐</span>" : "" }</button>`).join("") }</div><input class="question-answer-value" type="hidden" data-question-id="${ escapeHtml(question.id) }" value="${ escapeHtml(answer) }" /><button class="question-recommend" data-question-recommend="${ escapeHtml(question.id) }" data-recommend-value="${ escapeHtml(recommended.label) }" type="button">按推荐选择：${ escapeHtml(recommended.label) } ↗</button><input class="question-option-custom" data-question-custom="${ escapeHtml(question.id) }" placeholder="也可以补充具体情况（可选）" value="" autocomplete="off" /><small>${ escapeHtml(question.reason || "这会影响需求\u3001范围或验收") }</small></div>`;
}
function selectQuestionOption(card, value) {
  const input = card.querySelector("[data-question-id]");
  if (input)
    input.value = value;
  card.querySelectorAll("[data-question-option]").forEach(button => {
    const selected = button.dataset.optionValue === value;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function teacherChatMessages(project, stage) {
  if (stage === "development")
    return list(project.backend?.stage_transcript);
  return stage === "answers" ? list(project.workshop?.answer_transcript) : list(project.workshop?.transcript);
}
function renderTeacherChat(project, stage, extra = "") {
  const messages = teacherChatMessages(project, stage).filter(message => String(message?.text || "").trim());
  const latestAssistant = [...messages].reverse().find(message => message.role === "assistant");
  const stripChoiceLines = value => String(value || "").split("\n").filter(line => !/^\s*[A-CＡ-Ｃ][.．、:：)]\s+/.test(line) && !/你可以直接回复|直接回复.*字母/.test(line)).join("\n").trim();
  const choiceItems = teacherOptionItems(project, stage);
  const latestIndex = latestAssistant ? messages.lastIndexOf(latestAssistant) : -1;
  const latestChoiceText = latestAssistant && choiceItems.length ? stripChoiceLines(latestAssistant.text) : "";
  const detachedPrompt = choiceItems.length && !latestChoiceText && latestIndex > 0
    ? [...messages.slice(0, latestIndex)].reverse().find(item => item.role === "assistant")
    : null;
  const renderMessages = messageList => messageList.map((message, index) => {
    const isChoiceMessage = message === latestAssistant && choiceItems.length > 0;
    if (message === detachedPrompt)
      return "";
    const rawText = String(message.text || "");
    let text = isChoiceMessage ? stripChoiceLines(rawText) : rawText;
    // 系统有时把题干和选项拆成两条 assistant 消息。若当前消息只剩 A/B/C，
    // 回看上一条 assistant 题干；没有题干时由 renderWorkshopAnswers 补当前题卡。
    if (!text)
      return "";
    const currentClass = message === latestAssistant ? " is-current" : "";
    return `<div class="teacher-chat-message is-${ message.role === "user" ? "user" : "assistant" }${ currentClass }"><span class="teacher-chat-role">${ message.role === "user" ? "你" : "我的代码" }</span><p>${ escapeHtml(message.role === "user" ? text : presentCopy(text)) }</p></div>`;
  }).filter(Boolean).join("");
  const collapseHistory = stage === "answers" && messages.length > 3 && latestIndex > 0;
  const transcript = collapseHistory
    ? `<details class="teacher-history"><summary>已完成对话<span>${latestIndex} 条消息</span></summary><div class="teacher-history-body">${renderMessages(messages.slice(0, latestIndex))}</div></details>${renderMessages(messages.slice(latestIndex))}`
    : renderMessages(messages);
  return `<div class="teacher-chat-thread">${ transcript }${ extra }</div>`;
}
function cleanTeacherOptionText(value) {
  return String(value || "").replace(/^[「“"'‘]+|[」”"'’]+$/g, "").replace(/\s+/g, " ").trim();
}
function looksLikeTeacherChoice(value) {
  const text = String(value || "").trim();
  if (text.length < 2 || text.length > 40)
    return false;
  if (/^(如果|要是|万一|因为|所以|但是|不过|建议|请先|可以先)/.test(text))
    return false;
  if (/[。；;]/.test(text) || /还是/.test(text))
    return false;
  return true;
}
function teacherBinaryOptionItems(text) {
  const questions = String(text || "").split(/(?<=[？?])/).map(item => item.trim()).filter(Boolean);
  // 一次 assistant 回复可能带着上一条说明和下一条追问；选项必须从
  // 含“还是”的那条题干提取，不能只看最后一句导致当前题没有选项。
  const question = [...questions].reverse().find(item => /[？?]\s*$/.test(item) && (item.match(/还是/g) || []).length === 1) || "";
  if (!question)
    return [];
  const tail = question.replace(/^[^：:]*[：:]/, "").replace(/[？?]\s*$/, "").trim();
  const splitChoices = value => String(value || "").split(/\s*(?:、|，|,|或者|或)\s*/).map(cleanTeacherOptionText).filter(item => looksLikeTeacherChoice(item));
  // 系统常用“下次打开补给你、直接丢掉，还是发到微信短信上？”这一类自然语言列举。
  // 把列举项和“还是”后的最后一项都转成真正的按钮。
  if (tail && /还是/.test(tail)) {
    const parts = tail.split(/\s*还是\s*/);
    if (parts.length === 2) {
      const choices = [...splitChoices(parts[0]), ...splitChoices(parts[1])].filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 3);
      if (choices.length >= 2)
        return choices.map((item, index) => ({ label: String.fromCharCode(65 + index), text: item, recommended: index === 0 }));
    }
  }
  if (tail && /(?:或者|或)/.test(tail)) {
    const choices = splitChoices(tail).filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 3);
    if (choices.length >= 2)
      return choices.map((item, index) => ({ label: String.fromCharCode(65 + index), text: item, recommended: index === 0 }));
  }
  if ((question.match(/还是/g) || []).length !== 1)
    return [];
  const patterns = [
    /是\s*([^，,。；;\n]{2,40}?)\s*[，,]\s*还是\s*([^，,。；;\n？?]{2,40}?)\s*[呢啊呀]?[？?]\s*$/,
    /是\s*([^，,。；;\n]{2,40}?)\s*还是\s*([^，,。；;\s？?]{2,40}?)\s*[呢啊呀]?[？?]\s*$/,
    /(?:^|[。；\n]|[：:])\s*([^。；\n？?]{2,40}?)\s*还是\s*([^。；\n？?]{2,40}?)\s*[呢啊呀]?[？?]\s*$/
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match)
      continue;
    const first = cleanTeacherOptionText(match[1]);
    const second = cleanTeacherOptionText(match[2]);
    if (!looksLikeTeacherChoice(first) || !looksLikeTeacherChoice(second) || first === second)
      continue;
    return [
      { label: "A", text: first, recommended: false },
      { label: "B", text: second, recommended: false }
    ];
  }
  return [];
}
function teacherOptionItems(project, stage) {
  const messages = teacherChatMessages(project, stage);
  const assistant = [...messages].reverse().find(message => message.role === "assistant");
  if (!assistant)
    return [];
  const listed = String(assistant.text || "").split("\n").map(line => line.match(/^\s*[A-CＡ-Ｃ][.．、:：)]\s*(.+)$/)).filter(Boolean).map((match, index) => ({
    label: String(match[0].trim().match(/[A-CＡ-Ｃ]/)?.[0] || "A").replace("Ａ", "A").replace("Ｂ", "B").replace("Ｃ", "C").toUpperCase(),
    text: match[1].trim(),
    recommended: index === 0
  })).filter(item => item.text).slice(0, 3);
  if (listed.length)
    return listed;
  const source = stage === "answers" ? list(project.workshop?.answer_suggestions) : stage === "development" ? list(project.backend?.stage_suggestions) : [];
  const sourceChoices = source.map(cleanTeacherOptionText).filter(item => looksLikeTeacherChoice(item)).filter((item, index, all) => item && all.indexOf(item) === index).slice(0, 3);
  if (sourceChoices.length >= 2)
    return sourceChoices.map((item, index) => ({ label: String.fromCharCode(65 + index), text: item, recommended: index === 0 }));
  return teacherBinaryOptionItems(assistant.text);
}
function reviewQuestionText(value) {
  return String(value || "").replace(/^审稿追问[（(][^）)]+[）)]：?\s*/u, "").trim();
}
function renderPlanStageProgress(project) {
  const known = [
    ["extract", "需求拆解", "把想法拆成目标、用户和核心闭环"],
    ["select", "组件选型", "按项目规则确定需要的组件"],
    ["design", "领域建模与架构设计", "整理五要素、工具清单和系统设计"],
    ["review", "独立审稿", "检查方案矛盾、风险和高严重度问题"],
    ["questions", "整理待确认问题", "把审稿缺口改成可回答的问题"],
    ["documents", "整理 PRD 与交接文档", "写回需求文档、方案和开发交接包"]
  ];
  const snapshot = state.planProgress?.projectId === project?.id ? state.planProgress.progress : null;
  const source = Array.isArray(snapshot?.stages) && snapshot.stages.length ? snapshot.stages : null;
  const plan = project?.plan || {};
  const questions = list(project?.workshop?.answer_questions).filter(item => !questionHasReusableDecision(project?.workshop, item));
  const derived = known.map(([id, label, description]) => {
    if (id === "extract") return { id, label, description, status: plan.teacher_plan?.facts ? "done" : "todo" };
    if (id === "select") return { id, label, description, status: list(plan.teacher_plan?.components || plan.components).length ? "done" : "todo" };
    if (id === "design") return { id, label, description, status: plan.teacher_plan?.design || plan.teacher_plan?.elements ? "done" : "todo" };
    if (id === "review") return { id, label, description, status: plan.review_score != null && Number(plan.review_score) > 0 ? "done" : "todo" };
    if (id === "questions") return { id, label, description, status: questions.length ? "active" : "done" };
    return { id, label, description, status: plan.teacher_workspace_path ? "done" : "todo" };
  });
  const stages = source || derived;
  const active = stages.find(item => item.status === "active") || stages.find(item => item.status === "todo");
  const rows = stages.map((item, index) => {
    const status = item.status || "todo";
    const marker = status === "done" ? "✓" : status === "failed" ? "×" : status === "active" ? "…" : String(index + 1).padStart(2, "0");
    return `<li class="plan-stage-progress-row is-${escapeHtml(status)}"><span class="plan-stage-progress-marker">${marker}</span><div><strong>${escapeHtml(item.label || known[index]?.[1] || "方案阶段")}</strong><small>${escapeHtml(status === "active" && item.description ? item.description : item.description || known[index]?.[2] || "")}</small></div></li>`;
  }).join("");
  return `<div class="plan-stage-progress"><div class="plan-stage-progress-head"><strong>方案流程进度</strong><span>${escapeHtml(active ? `当前：${active.label || "方案阶段"}` : "已完成")}</span></div><ol>${rows}</ol></div>`;
}
function teacherOptionSuggestions(project, stage) {
  return teacherOptionItems(project, stage).map(item => item.text);
}
function renderTeacherChoiceCards(project, stage) {
  return teacherOptionItems(project, stage).map(item => `<button class="question-option teacher-choice-card${ item.recommended ? " is-recommended" : "" }" data-teacher-choice="${ escapeHtml(item.text) }" type="button"><span class="question-option-key teacher-choice-key">${ escapeHtml(item.label) }</span><span class="question-option-copy teacher-choice-copy"><strong>${ escapeHtml(item.text) }</strong></span>${ item.recommended ? "<span class=\"question-option-badge teacher-choice-badge\">推荐</span>" : "" }</button>`).join("");
}
function renderTeacherSuggestions(project, stage) {
  const source = stage === "development" ? list(project.backend?.stage_suggestions) : stage === "answers" ? list(project.workshop?.answer_suggestions) : list(project.workshop?.intake_suggestions);
  const defaults = stage === "development" ? [] : stage === "answers" ? [
    "帮我想想",
    "跳过这题",
    "先保存已回答的"
  ] : [
    "不确定\uFF0C先跳过",
    "信息够了\uFF0C帮我整理"
  ];
  const optionButtons = renderTeacherChoiceCards(project, stage);
  const optionTexts = new Set(teacherOptionItems(project, stage).map(item => item.text));
  const utilityItems = [...new Set([
      ...source,
      ...defaults
    ].map(item => String(item || "").trim()).filter(item => item && !optionTexts.has(item)))];
  const utilityButtons = utilityItems.map(item => `<button class="teacher-suggestion" data-teacher-suggestion="${ escapeHtml(item) }" type="button">${ escapeHtml(item) }</button>`).join("");
  return `${ optionButtons ? `<div class="teacher-choice-grid" role="group" aria-label="可选回答">${ optionButtons }</div>` : "" }${ utilityButtons ? `<div class="teacher-suggestions teacher-utility-actions">${ utilityButtons }</div>` : "" }`;
}
function renderDevelopmentSuggestions(project) {
  return renderTeacherSuggestions(project, "development");
}
function teacherChatDock(project, stage) {
  const messages = teacherChatMessages(project, stage).filter(message => String(message?.text || "").trim());
  const latestAssistant = [...messages].reverse().find(message => message.role === "assistant");
  const options = teacherOptionItems(project, stage);
  const stripChoiceLines = value => String(value || "").split("\n").filter(line => !/^\s*[A-CＡ-Ｃ][.．、:：)]\s+/.test(line) && !/你可以直接回复|直接回复.*字母/.test(line)).join("\n").trim();
  const prompt = latestAssistant && options.length && !stripChoiceLines(latestAssistant.text) && messages.length > 1
    ? [...messages.slice(0, messages.lastIndexOf(latestAssistant))].reverse().find(item => item.role === "assistant")?.text || ""
    : "";
  const context = prompt ? `<div class="teacher-choice-context"><span>当前问题</span><p>${ escapeHtml(prompt) }</p></div>` : "";
  return `<div class="teacher-chat-dock">${ context }${ renderTeacherSuggestions(project, stage) }${ teacherChatComposer(stage) }</div>`;
}
function bindTeacherChat(project, stage) {
  const panel = stage === "development" ? $("#previewPanel") : $("#questionPanel");
  panel.querySelectorAll("[data-teacher-suggestion]").forEach(button => button.addEventListener("click", () => sendTeacherChat(project, stage, button.dataset.teacherSuggestion, button)));
  panel.querySelectorAll("[data-teacher-choice]").forEach(button => button.addEventListener("click", () => sendTeacherChat(project, stage, button.dataset.teacherChoice, button)));
  const send = () => {
    const input = panel.querySelector("#teacherChatInput");
    const value = input?.value.trim();
    if (value)
      sendTeacherChat(project, stage, value, panel.querySelector("#teacherChatSend"));
  };
  panel.querySelector("#teacherChatSend")?.addEventListener("click", send);
  panel.querySelector("#teacherChatInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  });
}
function chatSource(project, stage) {
  const canonical = safety.authoritativeProjects.get(project.id);
  if (!canonical)
    return project;
  if (stage === "development") {
    if (!list(project.backend?.stage_transcript).length && list(canonical.backend?.stage_transcript).length)
      return Object.assign({}, project, { backend: structuredClone(canonical.backend) });
    return project;
  }
  const key = stage === "answers" ? "answer_transcript" : "transcript";
  if (!list(project.workshop?.[key]).length && list(canonical.workshop?.[key]).length)
    return Object.assign({}, project, { workshop: structuredClone(canonical.workshop) });
  return project;
}
async function sendTeacherChat(project, stage, text, button) {
  const value = String(text || "").trim();
  if (!value)
    return;
  const requestKey = `${ project.id }:${ stage }`;
  if (state.inflightChats.has(requestKey))
    return;
  state.inflightChats.add(requestKey);
  let responseRendered = false;
  setActionBusy(button, "正在回复");
  clearError();
  const messages = [
    ...teacherChatMessages(chatSource(project, stage), stage),
    {
      role: "user",
      text: value
    }
  ];
  safety.unsent[requestKey] = messages;
  saveSafety();
  try {
    const path = `/api/v1/projects/${ encodeURIComponent(project.id) }/${ stage === "development" ? "development-chat" : "workshop-chat" }`;
    const body = stage === "development" ? { messages } : {
      stage,
      messages
    };
    const payload = await api(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    replaceProject(payload.project);
    delete safety.unsent[requestKey];

    saveSafety();
    state.scrollConversationToEnd = true;
    render();
    responseRendered = true;
  } catch (error) {
    showError(error.message);
  } finally {
    state.inflightChats.delete(requestKey);
    restoreAction(button);
    if (!responseRendered)
      render();
  }
}
function teacherChatComposer(stage) {
  return `<div class="teacher-chat-composer"><textarea id="teacherChatInput" rows="4" placeholder="直接说你的回答，也可以点上方的选项或建议"></textarea><button class="primary-button" id="teacherChatSend" type="button">发送回答 <span class="button-arrow">↗</span></button></div>`;
}
function isPlanDerivationPath(path) {
  return /\/(confirm-intent|workshop-chat\/save|real-plan)$/.test(path || "");
}
function planDerivationPending(project) {
  const pending = project && safety.pending[project.id];
  return pending && isPlanDerivationPath(pending.path) ? pending : null;
}
function hasDerivedPlanEvidence(project) {
  const plan = project?.plan;
  if (!plan || typeof plan !== "object")
    return false;
  return plan.review_ok === true || plan.review_ok === false || plan.review_score != null || Boolean(plan.title || plan.summary || plan.review_summary);
}
function planDerivationComplete(project) {
  if (!project || project.status !== "needs_plan_confirmation")
    return false;
  const snapshot = state.planProgress?.projectId === project.id ? state.planProgress : null;
  if (snapshot?.progress?.status === "done")
    return true;
  return hasDerivedPlanEvidence(project);
}
function reviewGateLabel(review) {
  if (review == null || review.score == null)
    return "独立审稿尚未开始";
  const score = Number(review.score);
  if (review.ok === true && score >= 80)
    return `独立审稿 ${ score } 分 · 通过`;
  return `独立审稿 ${ score } 分 · 未达 80 分，需补齐缺口`;
}
function bumpBusyToken(key) {
  safety.busyTokens = safety.busyTokens || {};
  safety.busyTokens[key] = (safety.busyTokens[key] || 0) + 1;
  return safety.busyTokens[key];
}
function planDerivationAlreadySaved(pending, project) {
  if (!pending || !project)
    return false;
  if (/\/confirm-intent$/.test(pending.path))
    return project.status === "needs_plan_confirmation" || project.confirmations?.intent === true && hasDerivedPlanEvidence(project);
  if (/\/workshop-chat\/save$/.test(pending.path))
    return workshopSaveCompleted(pending, project);
  if (/\/real-plan$/.test(pending.path))
    return outcomeSaved(pending, project);
  return false;
}
function settleSavedPlanDerivation(project) {
  if (!project)
    return false;
  const key = project.id;
  const pending = safety.pending[key];
  if (!pending || !isPlanDerivationPath(pending.path))
    return false;
  if (!planDerivationAlreadySaved(pending, project))
    return false;
  const body = JSON.parse(pending.options?.body || "{}");
  delete safety.pending[key];
  stopPendingResultWatch(key);
  try {
    clearSubmittedFields(pending.path, body, key);
  } catch (_) {
  }
  bumpBusyToken(key);
  safety.busy.delete(key);
  if (state.planProgress?.projectId === key)
    state.planProgress.active = false;
  saveSafety();
  return true;
}
function isLeftoverSettledConfirmIntent(project) {
  const pending = project && safety.pending[project.id];
  if (!pending || !/\/confirm-intent$/.test(pending.path))
    return false;
  return planDerivationAlreadySaved(pending, project) || planDerivationComplete(project);
}
function isLongMutation(path) {
  return /\/(?:workshop-resume|workshop-chat(?:\/save)?|development-chat|confirm-intent)$/.test(path || "");
}
function pendingPathOf(pending) {
  return String(pending?.path || "");
}
function hasInFlightLongMutation() {
  const pendingMap = safety.pending || {};
  if ([...safety.busy].some(key => isLongMutation(pendingPathOf(pendingMap[key]))))
    return true;
  return Object.values(pendingMap).some(item => isLongMutation(pendingPathOf(item)) && (item?.watching || item?.aborted));
}
function settleUnresolvedPending(key, { silent = true } = {}) {
  const pending = safety.pending[key];
  if (!pending)
    return false;
  delete safety.pending[key];
  stopPendingResultWatch(key);
  bumpBusyToken(key);
  safety.busy.delete(key);
  if (!silent)
    safety.lastError = "";
  saveSafety();
  return true;
}
function isStalePendingForCurrentStage(project, pending) {
  if (!project || !pending || safety.busy.has(project.id))
    return false;
  const path = pendingPathOf(pending);
  if (isLongMutation(path) && !canRetryUnresolvedMutation(pending))
    return false;
  if (project.status === "needs_plan_confirmation")
    return !/\/(workshop-chat(?:\/save)?|confirm-plan)$/.test(path);
  return false;
}
function requestTimeoutMs(path, method) {
  const verb = (method || "GET").toUpperCase();
  if (verb !== "POST")
    return 20000;
  if (isLongMutation(path))
    return 600000;
  return 180000;
}
function isAbortError(error) {
  return Boolean(error && (error.aborted || error.name === "AbortError" || /aborted|abort/i.test(String(error.message || ""))));
}
function workshopSaveCompleted(pending, project) {
  if (!pending || !project)
    return false;
  const before = pending.before || {};
  const beforeDecisions = Object.keys(before.workshop?.decisions || {}).length;
  const afterDecisions = Object.keys(project.workshop?.decisions || {}).length;
  if (afterDecisions > beforeDecisions)
    return true;
  const beforeDraft = list(before.workshop?.answer_draft);
  const afterDraft = list(project.workshop?.answer_draft);
  if (beforeDraft.length && !afterDraft.length)
    return true;
  const beforePlan = before.plan || {};
  const afterPlan = project.plan || {};
  if (afterPlan.review_score !== beforePlan.review_score || afterPlan.review_ok !== beforePlan.review_ok || String(afterPlan.review_summary || "") !== String(beforePlan.review_summary || ""))
    return true;
  if (JSON.stringify(list(before.workshop?.answer_questions)) !== JSON.stringify(list(project.workshop?.answer_questions)))
    return true;
  if (list(project.workshop?.answer_transcript).length > list(before.workshop?.answer_transcript).length)
    return true;
  return false;
}
function isWorkshopSavePending(project) {
  const pending = project && safety.pending[project.id];
  return Boolean(pending && /\/workshop-chat\/save$/.test(pending.path));
}
function isWorkshopSaveInFlight(project) {
  return isWorkshopSavePending(project);
}
function isWorkshopSaveBusy(project) {
  return isWorkshopSavePending(project) && safety.busy.has(project.id);
}
function isWorkshopSaveWatching(project) {
  return isWorkshopSavePending(project) && !safety.busy.has(project.id);
}
function stopPendingResultWatch(key) {
  const timer = state.resultWatchers?.[key];
  if (timer)
    window.clearTimeout(timer);
  if (state.resultWatchers)
    delete state.resultWatchers[key];
}
function startPendingResultWatch(key) {
  const pending = safety.pending[key];
  if (!pending || !isLongMutation(pending.path))
    return;
  state.resultWatchers = state.resultWatchers || {};
  if (state.resultWatchers[key])
    return;
  const tick = async () => {
    const current = safety.pending[key];
    if (!current || current !== pending) {
      stopPendingResultWatch(key);
      return;
    }
    if (safety.busy.has(key)) {
      state.resultWatchers[key] = window.setTimeout(tick, 4000);
      return;
    }
    current.watching = true;
    current.aborted = current.aborted || true;
    try {
      await reconcile(key);
    } catch (_) {
      current.watchError = true;
    }
    if (!safety.pending[key]) {
      stopPendingResultWatch(key);
      if (safety.lastError && /连接中断或响应不完整|请查看上方恢复提示/.test(safety.lastError))
        safety.lastError = "";
      render();
      return;
    }
    safety.pending[key].unchangedChecks = Number(safety.pending[key].unchangedChecks || 0) + 1;
    safety.pending[key].lastChecked = Date.now();
    saveSafety();
    render();
    const waited = Date.now() - Number(safety.pending[key].started || Date.now());
    const delay = safety.pending[key].unchangedChecks > 5 || waited > 60000 ? 8000 : 4000;
    if (safety.pending[key])
      state.resultWatchers[key] = window.setTimeout(tick, delay);
  };
  state.resultWatchers[key] = window.setTimeout(tick, 400);
}
function ensurePendingResultWatch(project) {
  const key = project?.id;
  const pending = key && safety.pending[key];
  if (!pending || !isLongMutation(pending.path) || safety.busy.has(key))
    return;
  pending.watching = true;
  startPendingResultWatch(key);
}
function canRetryUnresolvedMutation(pending) {
  if (!pending || !isLongMutation(pending.path))
    return pending?.checked === true;
  const waited = Date.now() - Number(pending.started || 0);
  return Number(pending.unchangedChecks || 0) >= 12 && waited >= 300000;
}
function shouldShowPlanProgress(project) {
  if (!project || !["needs_intent_confirmation", "needs_plan_confirmation"].includes(project.status))
    return false;
  if (planDerivationComplete(project))
    return false;
  if (isWorkshopSaveInFlight(project) && project.status === "needs_plan_confirmation")
    return false;
  const snapshot = state.planProgress?.projectId === project.id ? state.planProgress : null;
  const pending = planDerivationPending(project);
  if (pending)
    return true;
  if (snapshot && (snapshot.active || snapshot.error || snapshot.progress?.status === "failed"))
    return true;
  return false;
}
function rememberPlanProgress(project, progress, extra = {}) {
  if (!project)
    return;
  const previous = state.planProgress?.projectId === project.id ? state.planProgress : null;
  state.planProgress = {
    projectId: project.id,
    progress: progress || previous?.progress || {},
    error: extra.error ?? "",
    active: extra.active ?? previous?.active ?? false
  };
}
function bindPlanProgressActions(project) {
  $("#queryPlanProgressButton")?.addEventListener("click", () => queryPlanProgress(project));
  $("#openPlanResultButton")?.addEventListener("click", () => queryPlanProgress(project));
  $("#retryPlanDerivationButton")?.addEventListener("click", () => retryPlanDerivation(project));
}
function renderPlanProgress(project, progress = {}) {
  showOnly("#planPanel");
  const snapshot = state.planProgress?.projectId === project.id ? state.planProgress : null;
  const currentProgress = progress && Object.keys(progress).length ? progress : snapshot?.progress || {};
  const queryError = snapshot?.error || "";
  const stages = list(currentProgress.stages);
  const stageRows = stages.length ? stages.map((stage, index) => {
    const status = stage.status || "todo";
    const marker = status === "done" ? "\u2713" : status === "active" ? "\u2026" : status === "failed" ? "\xD7" : String(index + 1).padStart(2, "0");
    return `<li class="plan-progress-row is-${ escapeHtml(status) }"><span class="plan-progress-marker">${ marker }</span><div><strong>${ escapeHtml(stage.label || "方案阶段") }</strong><small>${ escapeHtml(stage.description || "") }</small></div></li>`;
  }).join("") : "<li class=\"plan-progress-empty\">正在创建方案工作区和阶段记录</li>";
  const activeStage = stages.find(stage => stage.status === "active");
  const activeNote = activeStage ? `<div class="plan-progress-active"><strong>当前正在处理：${escapeHtml(activeStage.label || "方案阶段")}</strong><span>${escapeHtml(activeStage.description || "系统正在写入这一阶段的结果")}</span></div>` : "";
  const review = currentProgress.review || {};
  const reviewText = reviewGateLabel(review);
  const statusText = queryError ? "方案推导进度待查询" : currentProgress.status === "failed" ? "方案推导中断" : currentProgress.status === "done" ? "方案推导完成" : "正在推导方案";
  const done = currentProgress.status === "done" && !queryError;
  const failed = currentProgress.status === "failed" && !queryError;
  const reviewPassed = review.ok === true && Number(review.score || 0) >= 80;
  const answerDraftPending = list(project.workshop?.answer_draft).length > 0;
  const reviewFollowUpPending = list(project.workshop?.answer_questions).some(item => String(item || "").startsWith("审稿追问"));
  const inFlight = Boolean(planDerivationPending(project) && safety.busy.has(project.id));
  const canRetry = Boolean(planDerivationPending(project) && !safety.busy.has(project.id) && (failed || project.status === "needs_intent_confirmation"));
  let nextCopy;
  if (queryError)
    nextCopy = "进度查询失败，请重新查询。这次不会重新发送确认请求。";
  else if (done && project.status !== "needs_plan_confirmation")
    nextCopy = "进度显示方案已推导完成，但项目还没有进入方案确认。请重新查询项目详情；在确认进入方案页之前，不会把未完成的方案当成已经完成。";
  else if (done)
    nextCopy = reviewPassed ? "独立审稿已通过。请打开方案，确认后才能交接进入后端开发。" : answerDraftPending ? reviewFollowUpPending ? "这些是独立审稿指出的定向缺口。请先写回回答并重新审稿，不会回到上一批方案问题。" : "这批方案问题已经回答完，先把回答写回 PRD 并重新审阅；只有复审仍未通过，才会生成定向追问。" : "独立审稿未达到 80 分，不能确认方案。请打开审稿指出的具体缺口，重新回答后整理 PRD。";
  else if (failed)
    nextCopy = "方案推导没有完成。可以重新查询当前进度；若项目仍在需求确认，确认后才能重试原来的确认请求，不会自动重发。";
  else
    nextCopy = "正在根据已确认的需求推导方案，完成后会进入方案确认；可以离开此页，未提交输入会保留。";
  const queryButton = `<button class="secondary-button" id="queryPlanProgressButton" type="button">查看是否已完成 / 重新查询进度</button>`;
  const retryButton = canRetry ? `<button class="text-button" id="retryPlanDerivationButton" type="button">确认重试原来的确认请求</button>` : "";
  const nextAction = done && project.status === "needs_plan_confirmation" ? `<div class="plan-progress-next"><strong>${ reviewPassed ? "下一步：确认方案" : answerDraftPending ? reviewFollowUpPending ? "下一步：重新审稿" : "下一步：写回这批回答" : "下一步：回答审稿缺口" }</strong><p>${ reviewPassed ? "查看完整方案并点击确认，进入后端开发准备。" : answerDraftPending ? reviewFollowUpPending ? "点击“重新审稿”，写回这些定向回答并重新评分。" : "先点击“重新整理 PRD”，系统才会重新审稿并决定是否需要定向追问。" : "查看审稿指出的缺口，回答后重新整理 PRD。" }</p><button class="primary-button" id="openPlanResultButton" type="button">${ reviewPassed ? "查看方案并确认" : answerDraftPending ? reviewFollowUpPending ? "继续重新审稿" : "继续整理这批回答" : "查看定向追问" }<span class="button-arrow">↗</span></button></div>` : `<div class="plan-progress-next"><strong>${ failed ? "方案推导需要处理" : inFlight ? "推导仍在进行" : "查看当前进度" }</strong><p>${ failed ? "先重新查询，确认服务器上的真实阶段；只有你明确确认后，才会重试原来的请求。" : "查询只会读取方案进度和项目详情，不会重新发送确认请求。" }</p>${ queryError ? '<p class="plan-progress-error">进度查询失败，请重新查询</p>' : '' }<div class="panel-actions">${ queryButton }${ retryButton }</div></div>`;
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案推导</span><h3>${ escapeHtml(statusText) }</h3></div><span class="status-chip ${ failed ? "is-revise" : done ? reviewPassed ? "is-done" : "is-revise" : "is-progress" }">${ escapeHtml(reviewText) }</span></div><p class="panel-copy">${ escapeHtml(nextCopy) }</p>${ activeNote }<ol class="plan-progress-list">${ stageRows }</ol>${ nextAction }${ failed ? `<div class="supplement-box"><strong>方案推导需要重试</strong><p>当前阶段已经保留在本地工作区。重新查询不会自动重发请求；确认重试时会优先复用已完成的阶段。</p></div>` : "" }`;
  bindPlanProgressActions(project);
}
async function queryPlanProgress(project) {
  if (!project)
    return;
  const id = project.id;
  const button = $("#queryPlanProgressButton") || $("#openPlanResultButton");
  if (button)
    setActionBusy(button, "正在查询进度");
  try {
    let progress = state.planProgress?.projectId === id ? state.planProgress.progress : {};
    let error = "";
    try {
      progress = await api(`/api/v1/projects/${ encodeURIComponent(id) }/plan-progress`);
    } catch (_) {
      if (!hasInFlightLongMutation())
        error = "进度查询失败，请重新查询";
    }
    let detail = null;
    try {
      detail = await api(`/api/v1/projects/${ encodeURIComponent(id) }`);
    } catch (_) {
      if (!hasInFlightLongMutation())
        error = error || "进度查询失败，请重新查询";
    }
    if (state.current?.id !== id)
      return;
    if (detail?.project)
      replaceProject(detail.project);
    const latest = state.projects.find(item => item.id === id) || state.current;
    settleSavedPlanDerivation(latest);
    const finished = !error && planDerivationComplete(latest);
    rememberPlanProgress(latest || project, progress, {
      error,
      active: Boolean(state.planProgress?.projectId === id && state.planProgress.active && !finished)
    });
    render();
  } finally {
    restoreAction(button);
  }
}
async function retryPlanDerivation(project) {
  const pending = planDerivationPending(project);
  if (!project || !pending || safety.busy.has(project.id))
    return;
  if (planDerivationAlreadySaved(pending, project) || planDerivationComplete(project)) {
    settleSavedPlanDerivation(project);
    render();
    return;
  }
  if (!window.confirm("服务器可能已经执行此操作。你已检查最新进度，仍确认重试原来的确认请求吗？不会自动重发。"))
    return;
  const key = project.id;
  const operation = safety.pending[key];
  delete safety.pending[key];
  saveSafety();
  try {
    const token = safety.selection;
    const payload = await api(operation.path, operation.options);
    if (payload.project)
      replaceProject(payload.project, token === safety.selection);
    safety.lastError = "重试已返回，请核对服务器最新状态。";
  } catch (error) {
    safety.lastError = error.message;
  }
  render();
}
function startPlanProgress(project) {
  let stopped = false;
  let timer = null;
  const token = state.planProgressToken = Number(state.planProgressToken || 0) + 1;
  rememberPlanProgress(project, state.planProgress?.projectId === project.id ? state.planProgress.progress : {}, {
    error: "",
    active: true
  });
  const poll = async () => {
    if (stopped)
      return;
    try {
      const progress = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/plan-progress`);
      if (stopped || state.planProgressToken !== token || state.current?.id !== project.id)
        return;
      rememberPlanProgress(state.current, progress, { error: "", active: true });
      if (progress?.status === "done" || progress?.review) {
        try {
          const detail = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }`);
          if (!stopped && state.planProgressToken === token && detail?.project && state.current?.id === project.id)
            replaceProject(detail.project);
        } catch (_) {
        }
      }
      if (stopped || state.planProgressToken !== token || state.current?.id !== project.id)
        return;
      const latest = state.current;
      settleSavedPlanDerivation(latest);
      if (planDerivationComplete(latest)) {
        if (state.planProgress?.projectId === project.id)
          state.planProgress.active = false;
        render();
      } else if (shouldShowPlanProgress(latest))
        renderPlanProgress(latest, progress);
    } catch (_) {
      if (!stopped && state.planProgressToken === token && state.current?.id === project.id) {
        const pollError = hasInFlightLongMutation() ? "" : "进度查询失败，请重新查询";
        rememberPlanProgress(state.current, state.planProgress?.progress || {}, { error: pollError, active: true });
        renderPlanProgress(state.current, state.planProgress.progress || {});
      }
    }
    if (!stopped)
      timer = window.setTimeout(poll, 1200);
  };
  poll();
  return () => {
    stopped = true;
    if (timer)
      window.clearTimeout(timer);
    if (state.planProgressToken === token && state.current?.id === project.id) {
      state.planProgressToken += 1;
      if (state.planProgress?.projectId === project.id)
        state.planProgress.active = false;
    }
  };
}
function teacherIntakeRound(project) {
  const rounds = list(project.workshop?.transcript).filter(message => message.role === "assistant").length;
  return rounds ? `第 ${ rounds } 轮` : "准备第 1 轮";
}
function renderDiscovery(project) {
  showOnly("#questionPanel");
  if (project.workshop) {
    const panel = $("#questionPanel");
    const readOnly = project.status !== "needs_discovery";
    panel.dataset.taskLayout = teacherChatMessages(project,"intake").length ? "conversation" : "compact";
    panel.innerHTML = `<div class="panel-heading"><div><span class="section-kicker">需求澄清 · 系统 · ${ teacherIntakeRound(project) }</span><h3>${ readOnly ? "回看需求澄清对话" : "把想法聊清楚" }</h3></div><span class="status-chip ${ readOnly ? "is-confirm" : "is-progress" }">${ readOnly ? "只读回看" : "动态追问" }</span></div><p class="panel-copy">${ readOnly ? "需求稿已经生成。这里保留原始对话供回看，返回需求确认后可以继续修改需求稿。" : "当前问题会根据六个需求维度的覆盖情况继续变化。拿不准可以点推荐方向或直接说不知道。" }</p>${ readOnly ? "" : '<p class="workflow-scope">当前流程会按六个需求维度追问，通常要走完这些轮次才会整理需求稿。点「信息够了」或类似建议不会提前结束；这是流程规则，前端不会假装已经完成。</p>' }${teacherChatMessages(project,"intake").length ? renderTeacherChat(project,"intake") : '<p class="workshop-entry-status" role="status">后端尚未保存对话。</p>'}${ readOnly ? '<div class="panel-actions"><button class="primary-button" id="backToIntentButton" type="button">返回需求确认</button></div>' : teacherChatDock(project, "intake") }`;
    if (readOnly)
      panel.querySelector("#backToIntentButton")?.addEventListener("click", () => renderRequirements(project));
    else
      bindTeacherChat(project, "intake");
    return;
  }
  renderWorkshopResume(project);
}
function renderRequirements(project) {
  showOnly("#questionPanel");
  const intent = projectIntent(project);
  const discovery = projectDiscovery(project);
  if (project.workshop) {
    $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · 需求确认</span><h3>${ escapeHtml(project.workshop.name || "确认需求草稿") }</h3></div><span class="status-chip is-confirm">等你确认</span></div><div class="question-card"><label for="workshopDraft">核对需求草稿，有需要可以直接修改</label><textarea id="workshopDraft" class="workshop-draft" rows="14" maxlength="26000">${ escapeHtml(project.workshop.draft) }</textarea></div><div class="panel-actions"><button class="secondary-button" id="backToDiscoveryButton" type="button">返回需求澄清</button><button class="primary-button" id="confirmIntentButton" type="button">确认需求，推导方案并审稿</button></div>`;
    $("#backToDiscoveryButton").addEventListener("click", () => renderDiscovery(project));
    $("#confirmIntentButton").addEventListener("click", () => confirmIntent(project));
    return;
  }
  const supplement = project.requirement_supplement?.status === "needs_input";
  const supplementBox = supplement ? `<div class="supplement-box"><div class="section-kicker">补充信息</div><h4>补充一条会改变判断的信息</h4><p>可以补充事实、约束或必须纳入的用户场景；提交后仍停留在需求确认。</p><textarea id="supplementInput" aria-label="补充需求信息" placeholder="例如：已有 5 次访谈都提到需要导入原始记录"></textarea><div class="panel-actions"><button class="secondary-button" id="skipSupplementButton" type="button">无需补充</button><button class="primary-button" id="submitSupplementButton" type="button"><span>提交补充</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 需求确认</span><h3>确认需求判断，生成 PRD</h3></div><span class="status-chip is-confirm">等你确认</span></div><p class="panel-copy">这一步会把用户、问题、证据、目标和风险整理成 PRD 的需求判断。确认后继续补齐方案，完成后交给模块二进行后端开发。</p><div class="plan-grid"><div class="plan-block"><h4>用户与目标</h4><p>${ escapeHtml(intent.target_user || discovery.target_user || "待确认") }<br />${ escapeHtml(intent.goal || discovery.problem || "待确认") }</p></div><div class="plan-block"><h4>证据与假设</h4><ul>${ listHtml(discovery.evidence || discovery.facts, ["当前暂无外部证据\uFF0C先按假设记录"]) }</ul></div><div class="plan-block"><h4>核心结果</h4><p>${ escapeHtml(intent.core_loop || discovery.desired_outcome || "待确认") }</p></div><div class="plan-block"><h4>红灯与待验证</h4><ul>${ listHtml(discovery.red_flags || discovery.open_questions, ["暂无红灯\uFF1B真实用户验证仍待完成"]) }</ul></div></div>${ supplementBox }<div class="panel-actions"><button class="secondary-button" id="continueDiscoveryButton" type="button">我还要补充</button><button class="primary-button" id="confirmIntentButton" type="button"><span>确认需求，继续整理 PRD</span><span class="button-arrow">↗</span></button></div>`;
  $("#continueDiscoveryButton").addEventListener("click", () => {
    project.requirement_supplement = {
      status: "needs_input",
      prompt: "补充一条会改变判断的信息"
    };
    persist();
    render();
  });
  if (supplement) {
    $("#skipSupplementButton").addEventListener("click", () => {
      project.requirement_supplement = {
        status: "skipped",
        at: now()
      };
      persist();
      render();
    });
    $("#submitSupplementButton").addEventListener("click", () => submitSupplement(project));
  }
  $("#confirmIntentButton").addEventListener("click", () => confirmIntent(project));
}
function renderPlanConfirmation(project) {
  showOnly("#planPanel");
  const intent = projectIntent(project);
  const plan = project.plan || {};
  const correction = project.plan_revision?.status === "needs_input" ? project.plan_revision : null;
  if (correction) {
    const previewing = safety.planRevisionPreview?.[project.id] === true;
    if (previewing) {
      $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">原方案回看</span><h3>${ escapeHtml(plan.title || project.idea) }</h3></div><span class="status-chip is-revise">仍在方案确认</span></div><p class="panel-copy">这里保留原方案内容供对照。返回修改后提交说明，系统才会重新审稿。</p><div class="plan-block"><h4>方案摘要</h4><p>${ escapeHtml(plan.summary || "暂无方案摘要") }</p></div><div class="plan-block"><h4>核心闭环</h4><p>${ escapeHtml(projectIntent(project).core_loop || "暂无核心闭环") }</p></div><div class="panel-actions"><button class="primary-button" id="resumePlanRevisionButton" type="button">返回修改方案</button></div>`;
      $("#resumePlanRevisionButton").addEventListener("click", () => {
        safety.planRevisionPreview[project.id] = false;
        render();
      });
      return;
    }
    $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">修改方案</span><h3>告诉我方案哪里要改</h3></div><span class="status-chip is-revise">仍在方案确认</span></div><p class="panel-copy">这里只修改方案，不会把你拉回需求发现，也不会重新回答旧问题。</p><div class="plan-revision-context"><strong>当前方案</strong><p>${ escapeHtml(plan.summary || "暂无方案摘要") }</p><button class="text-button" id="previewPlanRevisionButton" type="button">先查看原方案</button></div><div class="question-list"><div class="question-card"><label for="answer-plan-correction">${ escapeHtml(correction.prompt || "方案需要调整哪一处\uFF1F") }</label><textarea id="answer-plan-correction" rows="5" placeholder="用自己的话描述修改" autocomplete="off"></textarea></div></div><div class="panel-actions"><button class="primary-button" id="planCorrectionButton" type="button"><span>更新方案</span><span class="button-arrow">↗</span></button></div>`;
    $("#previewPlanRevisionButton").addEventListener("click", () => {
      safety.planRevisionPreview[project.id] = true;
      render();
    });
    $("#planCorrectionButton").addEventListener("click", async () => {
      const value = $("#answer-plan-correction").value.trim();
      if (!value) {
        showError("先说清楚要改哪一处");
        return;
      }
      try {
        {
          const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/modify-plan`, {
            method: "POST",
            body: JSON.stringify({ note: value })
          });
          replaceProject(payload.project);
        }
        render();
      } catch (error) {
        showError(error.message);
      }
    });
    return;
  }
  if (project.workshop) {
    renderWorkshopPlan(project, plan);
    return;
  }
  const configured = state.model?.configured && state.model?.can_build;
  const modelHint = modelGate().reason;
  const modelButton = configured ? `<button class="secondary-button" id="realPlanButton" type="button" disabled title="请先开始方案问答">重新推导真实方案</button>` : `<button class="secondary-button" id="realPlanButton" type="button" disabled>真实模型当前不可用</button>`;
  const reviewScore = Number(plan.review_score ?? 0);
  const reviewPassed = plan.review_ok === true && reviewScore >= 80;
  const openQuestions = list(plan.open_questions);
  const reviewIssues = list(plan.review_issues);
  const reviewDetails = reviewIssues.length ? `<details class="review-issues-details"><summary>查看完整审稿意见<span>${reviewIssues.length} 条</span></summary><ul>${ reviewIssues.map(issue => `<li>${ escapeHtml(issue) }</li>`).join("") }</ul></details>` : "";
  const reviewPanel = `<div class="requirement-review ${ reviewPassed ? "is-passed" : "" }"><div class="review-summary"><strong>方案审稿 ${ reviewPassed ? "分数已达标" : "未通过" }</strong><span>${ reviewScore } 分</span></div><p>${ escapeHtml(plan.review_summary || "方案需要完成结构化审稿") }</p>${ reviewDetails }</div>`;
  const questionList = openQuestions.length ? `<div class="plan-block"><h4>待确认问题</h4><ul>${ openQuestions.map(item => `<li>${ escapeHtml(item) }</li>`).join("") }</ul></div>` : "";
  const startAnswers = `<button class="primary-button" id="resumePlanAnswersButton" type="button">开始方案问答</button>`;
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案</span><h3>${ escapeHtml(plan.title || project.idea) }</h3></div><span class="status-chip is-confirm">${ escapeHtml(sourceLabel(project)) }</span></div><p class="panel-copy">这份 PRD 已经包含产品定位、核心闭环、MVP 范围和验收标准。</p><p class="workflow-scope">服务器还没有这份方案的问答记录。请先开始方案问答，再确认或修改方案。开始后只会进入方案问答，不会重新做需求澄清，也不会清空已有方案。</p><div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${ escapeHtml(plan.summary || intent.goal || "待生成") }</p></div><div class="plan-block"><h4>核心闭环</h4><p>${ escapeHtml(intent.core_loop || "待补充") }</p></div><div class="plan-block"><h4>MVP 范围</h4><ul>${ listHtml(plan.mvp_features || plan.scope) }</ul></div><div class="plan-block"><h4>验收标准</h4><ul>${ listHtml(intent.acceptance) }</ul></div>${ questionList }</div>${ reviewPanel }<div class="panel-actions">${ startAnswers }${ modelButton }</div><div class="stage-note">${ modelHint }</div>`;
  $("#realPlanButton").addEventListener("click", generateRealPlan);
  $("#resumePlanAnswersButton")?.addEventListener("click", event => workshopAction(project, "workshop-resume", event.currentTarget, "正在准备方案问答"));
}

function planReviewPassed(plan) {
  return plan?.review_ok === true && Number(plan?.review_score || 0) >= 80;
}
function hasReusablePlanDecisions(project) {
  return Object.values(project?.workshop?.decisions || {}).some(value => String(value || "").trim());
}
function needsExistingDecisionRevision(project) {
  return project?.status === "needs_plan_confirmation" && Boolean(project?.plan) && !planReviewPassed(project.plan) && hasReusablePlanDecisions(project);
}
function reviewSectionName(question) {
  const match = String(question || "").trim().match(/^审稿追问[（(]([^）)]+)[）)]/);
  return match ? match[1].trim() : "";
}
function packedDecisionText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}
function reviewQuestionBody(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^审稿追问[（(][^）)]+[）)][：:](.*)$/);
  return (match ? match[1] : raw).trim();
}
const COMPONENT_DECISION_HINTS = [
  { id: "s01", tokens: ["s01", "agentloop", "agent loop"] },
  { id: "s02", tokens: ["s02", "工具系统"] },
  { id: "s03", tokens: ["s03", "权限系统", "破坏性操作防护", "破坏性操作"] },
  { id: "s04", tokens: ["s04", "钩子系统", "钩子框架", "通用钩子"] },
  { id: "s15", tokens: ["s15", "集成harness", "集成 harness"] }
];
const GENERIC_DECISION_TOKENS = new Set(["审稿", "追问", "方案", "是否", "选用", "问题", "答复", "还没有", "这项", "需要", "应该", "怎么", "如何", "以及", "或者", "用户", "已经", "执行", "相反", "明确", "说法", "一个", "这个", "那个", "可以", "进行", "还有", "通过", "未通过", "必选", "不选", "仍然", "仍选", "写成", "请先", "补充", "内容", "指出"]);
function componentHintsFrom(text) {
  const ids = new Set();
  const raw = String(text || "");
  for (const match of raw.matchAll(/(?:^|[^A-Za-z0-9])(s\d{2})(?![0-9])/gi))
    ids.add(match[1].toLowerCase());
  const packed = packedDecisionText(raw);
  for (const item of COMPONENT_DECISION_HINTS) {
    if (item.tokens.some(token => packed.includes(packedDecisionText(token))))
      ids.add(item.id);
  }
  return ids;
}
function distinctiveDecisionTokens(text) {
  const tokens = new Set(componentHintsFrom(text));
  const source = `${ reviewSectionName(text) } ${ reviewQuestionBody(text) } ${ text }`;
  for (const part of String(source).split(/[\s，。；、：:？?！!（）()「」“”"'‘’《》【】\[\]/|…—–-]+/)) {
    const token = part.trim();
    if (token.length < 2 || GENERIC_DECISION_TOKENS.has(token) || /^[0-9]+$/.test(token))
      continue;
    tokens.add(token.toLowerCase());
  }
  return tokens;
}
function longestCommonDecisionLength(left, right) {
  if (!left || !right)
    return 0;
  let best = 0;
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      let size = 0;
      while (i + size < left.length && j + size < right.length && left[i + size] === right[j + size])
        size++;
      if (size > best)
        best = size;
    }
  }
  return best;
}
function isNearReusableWording(question, reference) {
  const left = packedDecisionText(reviewQuestionBody(question) || question);
  const right = packedDecisionText(reference);
  if (!left || !right)
    return false;
  if (left.length >= 6 && right.includes(left))
    return true;
  if (right.length >= 6 && left.includes(right))
    return true;
  const common = longestCommonDecisionLength(left, right);
  if (common >= 6)
    return true;
  return left.length >= 16 && right.length >= 16 && common / Math.min(left.length, right.length) >= 0.5;
}
function questionHasReusableDecision(workshop, question) {
  const text = String(question || "").trim();
  if (!text || !workshop)
    return false;
  const decisions = workshop.decisions || {};
  const originals = workshop.originals || {};
  // 只按系统返回的原始问题身份复用答案。不能因为同属一个组件、
  // 包含相似词或属于同一审稿板块，就把新的定向缺口隐藏掉。
  const aliases = new Set([text, originals[text] || ""].filter(Boolean));
  for (const [key, value] of Object.entries(decisions)) {
    if (!String(value || "").trim())
      continue;
    const canonical = originals[key] || key;
    if (aliases.has(key) || aliases.has(canonical))
      return true;
  }
  return false;
}
function undecidedPlanQuestions(project) {
  const workshop = project?.workshop || {};
  const questions = list(workshop.answer_questions).length ? list(workshop.answer_questions) : list(project?.plan?.open_questions);
  return questions.filter(item => !questionHasReusableDecision(workshop, item));
}
function workshopSaveBusyLabel(project, { watching = false, draft = false, reviewFollowUp = false } = {}) {
  if (watching)
    return "正在查询写回结果";
  if (!draft || needsExistingDecisionRevision(project))
    return "正在按已有答复重新审稿";
  return reviewFollowUp ? "正在写回并重新审稿" : "正在写回并重新整理 PRD";
}
function workshopRevisionAction(project, { draft = false, saving = false, watching = false, reviewFollowUp = false } = {}) {
  const saveLabel = draft ? (reviewFollowUp ? "重新审稿" : "重新整理 PRD") : "按已有答复重新审稿";
  const busyLabel = workshopSaveBusyLabel(project, { watching, draft, reviewFollowUp });
  const revising = !draft || needsExistingDecisionRevision(project);
  const title = saving ? (revising ? "正在按已有答复修订方案并重新审稿，完成后会更新评分" : "正在写回并重新审稿，完成后会更新评分") : "现在还不能确认方案";
  const copy = saving ? (watching ? (revising ? "正在自动查询这次修订和重新评分是否已经完成，不会重发请求，也不需要把这些问题再答一遍。" : "正在自动查询这次写回是否已经完成，不会重发请求，也不需要来回修改这些问题。") : "请等待这次写回和重新评分完成，不要重复提交。") : revising ? "不需要把这些问题再答一遍。系统会按已有答复改方案并重新评分；达到 80 分且审稿通过后，才会出现确认方案。" : "先把已收齐的回答写回 PRD 并重新评分。分数达到 80 且审稿通过后，才会出现确认方案。";
  if (saving) {
    return `<div class="plan-next-step is-review-status" id="saveWorkshopAnswersStep" role="status" aria-live="polite" aria-busy="true"><span class="review-status-spinner" aria-hidden="true"></span><div><strong>正在重新审稿</strong><span class="review-status-copy">${watching ? "已有回答已保留，正在查询结果。请稍候。" : "已有回答已保留，请等待本次审稿完成。"}</span></div><button id="saveWorkshopAnswersButton" type="button" hidden disabled aria-hidden="true" tabindex="-1">正在重新审稿</button></div>`;
  }
  return `<div class="plan-next-step" id="saveWorkshopAnswersStep"><div><strong>${ title }</strong><span>${ copy }</span></div><button class="primary-button${ saving ? " is-loading" : "" }" id="saveWorkshopAnswersButton" type="button"${ saving ? " disabled" : ""}><span>${ saving ? busyLabel : saveLabel }</span><span class="button-arrow">↗</span></button></div>`;
}
function bindWorkshopSaveButton(project, answers, busyLabel) {
  document.querySelector("#saveWorkshopAnswersButton")?.addEventListener("click", async event => {
    if (isWorkshopSavePending(project))
      return;
    setActionBusy(event.currentTarget, busyLabel);
    try {
      const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/workshop-chat/save`, {
        method: "POST",
        body: JSON.stringify({ answers })
      });
      replaceProject(payload.project);
    } catch (error) {
      if (!error?.silent)
        showError(error.message);
      if (!isWorkshopSavePending(state.current?.id === project.id ? state.current : project))
        restoreAction(event.currentTarget);
    } finally {
      render();
    }
  });
}

function renderWorkshopPlan(project, plan) {
  const workshop = project.workshop || {};
  const questions = list(workshop.answer_questions).length ? list(workshop.answer_questions) : list(plan.open_questions);
  const newQuestions = questions.filter(item => !questionHasReusableDecision(workshop, item));
  const reviewFollowUpQuestions = newQuestions.some(item => String(item || "").startsWith("审稿追问"));
  const revisingFromDecisions = needsExistingDecisionRevision(project);
  const pendingDraft = list(workshop.answer_draft);
  if (!safety.planOverview?.[project.id] && pendingDraft.length) {
    renderWorkshopAnswers(project, plan);
    return;
  }
  if (!safety.planOverview?.[project.id] && newQuestions.length && (!revisingFromDecisions || reviewFollowUpQuestions)) {
    renderWorkshopAnswers(project, plan);
    return;
  }
  showOnly("#planPanel");
  const data = plan.teacher_plan || {};
  const facts = Object.entries(data.facts || {}).map(([key, fact]) => {
    const label = {
      goal: "目标",
      users: "用户",
      core_loop: "核心闭环",
      deliverable: "交付物",
      boundaries: "边界",
      constraints: "约束"
    }[key] || key;
    return `<li><strong>${ escapeHtml(label) }</strong> · ${ escapeHtml(fact.value || "待确认") } ${ fact.status === "待确认" ? "<small>待确认</small>" : "" }</li>`;
  }).join("");
  const pendingCount = questions.length;
  const reviewPassed = plan.review_ok === true && Number(plan.review_score || 0) >= 80;
  const ready = canConfirmPlan(project);
  const reviewIssues = list(plan.review_issues);
  const reviewDetails = reviewIssues.length ? `<details class="review-issues-details"><summary>查看完整审稿意见<span>${reviewIssues.length} 条</span></summary><ul>${ listHtml(reviewIssues) }</ul></details>` : "";
  const reviewBlock = `<div class="plan-block"><h4>独立审稿</h4><strong>${ reviewPassed ? "审稿通过" : "审稿未通过" } · ${ Number(plan.review_score || 0) } 分</strong><p>${ escapeHtml(plan.review_summary || "") }</p>${ reviewDetails }</div>`;
  const summary = `<div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${ escapeHtml(plan.summary || "") }</p></div><div class="plan-block"><h4>需求事实</h4><ul>${ facts || "<li>待生成</li>" }</ul></div><div class="plan-block"><h4>待确认问题</h4><p>${ pendingCount ? `还有 ${ pendingCount } 个待答问题` : "当前没有待确认问题" }</p></div>${ reviewBlock }</div>`;
  const design = data.design || {};
  const details = `<details class="delivery-details"><summary>完整方案<span>五要素、选型、架构与测试</span></summary><div class="plan-grid"><div class="plan-block"><h4>领域建模</h4><ul>${ Object.values(data.elements || {}).map(items => listHtml(items, [])).join("") }</ul></div><div class="plan-block"><h4>组件选型</h4><ul>${ listHtml(list(data.components).map(item => `${ item.name } · ${ item.decision } · ${ item.reason }`), []) }</ul></div><div class="plan-block"><h4>技术与部署</h4><p>${ escapeHtml(design.tech_stack_and_deployment || "") }</p><ul>${ listHtml(design.security_and_degradation, []) }</ul></div><div class="plan-block"><h4>测试设计</h4><ul>${ listHtml(design.testing, []) }</ul></div></div></details>`;
  const savePending = isWorkshopSavePending(project);
  const saveWatching = isWorkshopSaveWatching(project);
  const revising = needsExistingDecisionRevision(project);
  const confirm = ready ? "<button class=\"primary-button\" id=\"confirmPlanButton\" type=\"button\"><span>确认方案\uFF0C交接进入后端开发</span><span class=\"button-arrow\">\u2197</span></button>" : "<button class=\"secondary-button\" id=\"confirmPlanButton\" type=\"button\" disabled>先完成待确认项和 80 分审稿门禁</button>";
  const revisionAction = revising && !reviewFollowUpQuestions ? workshopRevisionAction(project, { draft: false, saving: savePending, watching: saveWatching }) : "";
  const nextStep = reviewFollowUpQuestions ? `<div class="plan-next-step"><div><strong>还有 ${newQuestions.length} 条审稿缺口</strong><span>只回答这次独立审稿指出的新问题，之前已经回答的内容不会重复出现。</span></div><button class="primary-button" id="continuePlanChat" type="button">回答审稿缺口</button></div>` : revisionAction || (newQuestions.length ? `<div class="plan-next-step"><div><strong>还有 ${newQuestions.length} 条待确认项</strong><span>继续需求对话，不需要填写固定问卷。</span></div><button class="primary-button" id="continuePlanChat" type="button">继续和需求对话</button></div>` : ready ? `<div class="plan-next-step"><div><strong>下一步</strong><span>方案已通过，可以进入后端开发准备。</span></div>${ confirm }</div>` : "");
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案</span><h3>${ escapeHtml(plan.title || project.idea) }</h3></div><span class="status-chip ${ ready ? "is-done" : "is-confirm" }">${ ready ? "等你确认" : "待复核" }</span></div><p class="panel-copy">方案会先经过系统的待确认问题和统一审稿，达到 80 分且后端审稿通过、待答项全部处理后，才能交接开发准备。</p>${ renderPlanStageProgress(project) }${ nextStep }${ summary }${ details }<div class="panel-actions"><button class="secondary-button" id="modifyPlanButton" type="button">方案需要修改</button>${ ready ? "" : confirm }</div>`;
  $("#confirmPlanButton")?.addEventListener("click", () => confirmPlan(project, true));
  $("#continuePlanChat")?.addEventListener("click", () => { safety.planOverview[project.id] = false; render(); });
  $("#modifyPlanButton")?.addEventListener("click", () => confirmPlan(project, false));
  if (revising)
    bindWorkshopSaveButton(project, list(workshop.answer_draft), workshopSaveBusyLabel(project, { watching: saveWatching, draft: false }));
}
function renderWorkshopAnswers(project, plan) {
  showOnly("#questionPanel");
  const workshop = project.workshop || {};
  const allQuestions = list(workshop.answer_questions).length ? list(workshop.answer_questions) : list(plan.open_questions);
  const questions = allQuestions.filter(item => !questionHasReusableDecision(workshop, item));
  const draft = list(workshop.answer_draft);
  const reviewFollowUp = questions.some(item => String(item || "").startsWith("审稿追问")) || allQuestions.some(item => String(item || "").startsWith("审稿追问"));
  const revising = needsExistingDecisionRevision(project);
  const introText = allQuestions.length === questions.length
    ? (workshop.answer_intro || `方案里有 ${ questions.length } 个还没想清楚的问题，我们一题一题过。想好的直接回答，拿不准可以点“帮我想想”。`)
    : `还有 ${ questions.length } 个没有现成答复的新问题。已经答过的审稿追问不用再答一遍。`;
  const intro = !list(workshop.answer_transcript).length && questions.length && !reviewFollowUp ? `<div class="teacher-chat-message is-assistant"><span class="teacher-chat-role">我的代码</span><p>${ escapeHtml(introText) }</p></div>` : "";
  const transcriptTexts = teacherChatMessages(project, "answers").filter(message => message?.role === "assistant").map(message => String(message.text || ""));
  const currentQuestion = questions[0] || "";
  const currentQuestionVisible = currentQuestion && transcriptTexts.some(text => text.includes(currentQuestion));
  // 复审会把 answer_questions 重置成新的审稿缺口；旧缓存或断线恢复时，
  // 可能只剩选项按钮而没有题干。始终补出当前待回答问题，避免用户只看到答案。
  const currentQuestionCard = currentQuestion && !reviewFollowUp && !currentQuestionVisible
    ? `<div class="teacher-current-question"><span class="teacher-chat-role">当前待回答问题</span><strong>${ escapeHtml(currentQuestion) }</strong><small>第 1 / ${ questions.length } 题 · 可以直接点击选项，也可以在下方自由回答</small></div>`
    : "";
  const savePending = isWorkshopSavePending(project);
  const saveBusy = isWorkshopSaveBusy(project);
  const saveWatching = isWorkshopSaveWatching(project);
  const saving = savePending;
  const saveBusyLabel = workshopSaveBusyLabel(project, { watching: saveWatching, draft: Boolean(draft.length), reviewFollowUp });
  const draftCard = draft.length ? `<div class="teacher-chat-draft"><strong>${ reviewFollowUp ? "审稿缺口回答已经收齐" : "这些回答已经收齐" }</strong>${ draft.map(item => `<p><b>${ escapeHtml(item.question || "") }</b><br />${ escapeHtml(item.answer || "") }</p>`).join("") }</div>` : "";
  const countLabel = questions.length ? `${ questions.length } 条` : revising ? "待修订" : "动态";
  const answerDock = draft.length || !questions.length ? "" : teacherChatDock(project, "answers");
  const panel = $("#questionPanel");
  const heading = draft.length ? (reviewFollowUp ? "审稿缺口回答已收齐" : "方案问题回答已收齐") : questions.length ? (reviewFollowUp ? "回答审稿指出的缺口" : "继续和需求对话") : "按已有答复修订方案";
  const chip = saveWatching ? "正在查询写回结果" : saveBusy ? (revising || reviewFollowUp ? "正在重新审稿" : "正在重新整理 PRD") : draft.length ? reviewFollowUp ? "等待重新审稿" : "等待重新整理 PRD" : revising ? "按已有答复修订" : reviewFollowUp ? "复审定向追问" : "统一评分前必须答完";
  const copy = draft.length && saving && !revising ? "正在写回并重新审稿，完成后会更新评分。现在还不能确认方案，不需要重新修改这些问题。" : draft.length && !revising ? reviewFollowUp ? "现在还不能确认方案。请先把已收齐的回答写回 PRD 并重新评分；分数达到 80 且审稿通过后，才会出现确认方案。" : "现在还不能确认方案。请先把已收齐的回答写回 PRD 并重新审阅；分数达到 80 且审稿通过后，才会出现确认方案。" : revising ? (saving ? "正在按已有答复修订方案并重新审稿，完成后会更新评分。现在还不能确认方案，不需要把这些问题再答一遍。" : "不需要把这些问题再答一遍。系统会按已有答复改方案并重新评分；达到 80 分且审稿通过后，才会出现确认方案。") : reviewFollowUp ? "这些问题来自独立审稿缺口，不会重新开启上一批方案问题。" : "系统会按原始方案问题逐题推进。回答、选项、帮我想想、跳过和先保存都在同一段聊天里完成。";
  const saveAction = draft.length || revising ? workshopRevisionAction(project, { draft: Boolean(draft.length), saving, watching: saveWatching, reviewFollowUp }) : "";
  const reviewGap = reviewFollowUp && questions.length ? `<div class="review-gap-card"><div class="section-kicker">当前审稿缺口 · 第 1 / ${questions.length} 题</div><p>${escapeHtml(reviewQuestionText(questions[0]))}</p><small>这是独立审稿指出的具体问题，只回答这一条即可继续；之前已经回答的内容不会重复。</small></div>` : "";
  panel.innerHTML = `<div class="panel-heading"><div><span class="section-kicker">${ reviewFollowUp ? "复审定向追问" : "方案待确认问题" } · ${ countLabel }</span><h3>${ heading }</h3></div><span class="status-chip is-confirm">${ chip }</span></div><p class="panel-copy">${ copy }</p>${ renderPlanStageProgress(project) }${ reviewGap }${ renderTeacherChat(project, "answers", intro) }${ currentQuestionCard }${ answerDock }${ draftCard }${ saveAction }<div class="panel-actions"><button class="secondary-button" id="backToPlanButton" type="button">返回方案概览</button></div>`;
  bindTeacherChat(project, "answers");
  panel.querySelector("#backToPlanButton")?.addEventListener("click", () => { safety.planOverview = safety.planOverview || {}; safety.planOverview[project.id] = true; render(); });
  if (saveAction)
    bindWorkshopSaveButton(project, draft, saveBusyLabel);
}

function renderBackend(project, verified) {
  showOnly("#previewPanel");
  const backend = projectBackend(project);
  const tasks = list(project.tasks);
  if (backend.status === "prd_health_check") {
    $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">开发交接</span><h3>等待后端准备阶段任务</h3></div></div><p class="panel-copy">服务器仍返回旧的 PRD 体检状态，尚未进入可对话的阶段任务。前端不会擅自改阶段或开始开发。请先重新查询；若持续停留，请核对后端交接状态。</p><div class="panel-actions"><button class="primary-button" id="refreshBuildButton" type="button">重新查询开发状态</button></div>`;
    $("#refreshBuildButton").onclick = () => loadProject(project.id); return;
  }
  if (backend.status === "stage_task_ready" || backend.status === "stage_advanced" || backend.status === "kit_self_check_failed" && !backend.stage_confirmed) {
    const id = encodeURIComponent(project.id);
    const stage = backend.kit_stage || "阶段0";
    const title = backend.status === "stage_advanced" ? `${ stage } 已准备` : backend.status === "stage_task_ready" ? `${ stage } 待确认` : backend.status === "kit_self_check_failed" ? `${ stage } 重新确认` : "PRD 体检";
    const copy = backend.status === "stage_advanced" ? `上一阶段已验收。请确认 ${ stage } 任务后再开始这一阶段的外部开发。` : backend.status === "stage_task_ready" ? `方案确认已完成。请先确认 ${ stage }，再把系统生成的本阶段任务交给外部编码工具。` : backend.status === "kit_self_check_failed" ? `上次阶段自检没有通过。先回到自然语言对话，补齐本阶段产品决定，再重新开始开发。` : "已交接这次确认的 PRD 和方案\u3002Idea to Launch 已建立阶段任务\u3002";
    const intro = !list(backend.stage_transcript).length ? `<div class="teacher-chat-message is-assistant"><span class="teacher-chat-role">我的代码</span><p>进入 ${ escapeHtml(stage) } 前，我会先用自然语言确认本阶段需要产品经理决定的事项。你可以直接回答，也可以按推荐方向选择。</p></div>` : "";
    const startLabel = backend.stage_confirmed ? `确认 ${ stage }，开始开发` : `完成对话后确认 ${ stage }`;
    const startButton = `<button class="primary-button" id="startBackendButton" type="button" ${ backend.stage_confirmed ? "" : "disabled title=\"请先完成阶段自然语言对话\"" }><span>${ startLabel }</span><span class="button-arrow">↗</span></button>`;
    $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块二 · ${ escapeHtml(stage) } · 自然语言确认</span><h3>${ escapeHtml(title) }</h3></div><span class="status-chip is-confirm">${ backend.stage_confirmed ? "确认完成" : "先回答问题" }</span></div><p class="panel-copy">${ copy }</p>${ renderTeacherChat(project, "development", intro) }${ teacherChatDock(project, "development") }<div class="plan-grid"><div class="plan-block"><h4>本阶段任务</h4><p class="stage-task-copy">${ escapeHtml(backend.kit_task || "阶段工具包已生成任务") }</p></div><div class="plan-block"><h4>后续阶段</h4><ul>${ listHtml(backend.acceptance) }</ul></div></div><div class="panel-actions"><a class="secondary-button" href="/api/v1/projects/${ id }/handoff">下载交接包</a>${ startButton }<button class="secondary-button" id="refreshBuildButton" type="button">刷新状态</button></div>`;
    bindTeacherChat(project, "development");
    $("#startBackendButton").addEventListener("click", () => startBackendBuild(project));
    $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
    return;
  }
  if (backend.status === "kit_self_check_passed" || backend.status === "kit_self_check_failed" && backend.stage_confirmed) {
    renderDevelopmentAcceptance(project);
    return;
  }
  const checks = backend.verification || backend.tests || backend.checks || [];
  const selfCheckFailed = backend.status === "kit_self_check_failed";
  const selfCheckOutput = String(backend.kit_last_output || "").trim();
  const stage = previewStageView(project);
  const previewReady = stage.previewReady;
  const previewLabel = stage.previewLabel;
  const previewState = stage.previewState;
  const preview = previewReady && project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${ escapeHtml(previewReady ? previewLabel : project.plan.preview_label || "产品示例") }</span><span>${ escapeHtml(previewReady ? previewState : verified ? "等你确认" : "后端开发中") }</span></div><div class="preview-body"><h4>${ escapeHtml(project.plan.title || project.idea) }</h4><p>${ escapeHtml(project.plan.summary || "方案正在生成") }</p><span class="preview-cta">${ escapeHtml(project.answers?.desired_outcome || project.answers?.core_action || "打开运行时预览") } ↗</span></div></div>` : "";
  const title = previewReady ? stage.title : verified ? "开发阶段已完成\uFF0C等你验收" : backend.status === "awaiting_external_coding" ? "等待外部编码工具完成" : selfCheckFailed ? `${ backend.kit_stage || "本阶段" } 自检未通过` : backend.status === "kit_self_check_passed" ? `${ backend.kit_stage || "本阶段" } 自检通过，等你确认` : "等待后端开发准备";
  const headingKicker = previewReady ? "模块二 \xB7 产品预览" : verified ? "模块二 \xB7 后端验收" : backend.status === "awaiting_external_coding" ? "模块二 \xB7 开发等待" : selfCheckFailed ? `模块二 · ${ backend.kit_stage || "本阶段" }自检` : backend.status === "kit_self_check_passed" ? `模块二 · ${ backend.kit_stage || "本阶段" }验收` : "模块二 \xB7 后端开发";
  const chipClass = {
    "preview-verified": "is-preview-verified",
    "preview-pending": "is-preview-pending",
    "example-viewed": "is-confirm",
    "example-pending": "is-progress"
  }[stage.chipKind] || "is-progress";
  const headingChip = previewReady ? `<span class="status-chip ${ chipClass }">${ escapeHtml(stage.chip) }</span>` : selfCheckFailed ? "<span class=\"status-chip is-revise\">需要处理</span>" : verified || backend.status === "kit_self_check_passed" ? "<span class=\"status-chip is-confirm\">等你确认</span>" : "<span class=\"status-chip is-progress\">进行中</span>";
  const startTrialButton = stage.startEnabled ? `<button class="primary-button" id="startTrialButton" type="button"><span>开始试用</span><span class="button-arrow">↗</span></button>` : `<button class="secondary-button" id="startTrialButton" type="button" disabled title="${ escapeHtml(stage.startDisabledReason) }">开始试用</button>`;
  const verifyOrOpenProduct = previewReady ? stage.startEnabled ? `<button class="secondary-button" id="openPreviewButton" type="button">打开编码产物</button>` : `<button class="primary-button" id="verifyProductButton" type="button"><span>验证编码产物</span><span class="button-arrow">↗</span></button>` : "";
  const playgroundButton = previewReady ? `<button class="secondary-button" id="openPlaygroundButton" type="button">打开方案试玩（模拟）</button>` : "";
  const openPreviewButton = verifyOrOpenProduct;
  const action = previewReady ? stage.startEnabled ? `${ openPreviewButton }${ playgroundButton }${ startTrialButton }` : `${ openPreviewButton }${ playgroundButton }${ startTrialButton }` : verified ? "<button class=\"primary-button\" id=\"acceptanceButton\" type=\"button\"><span>验收通过\uFF0C进入产品预览</span><span class=\"button-arrow\">\u2197</span></button>" : backend.status === "awaiting_external_coding" || selfCheckFailed ? `<button class="primary-button" id="verifyBackendButton" type="button"><span>编码完成，运行阶段自检</span><span class="button-arrow">↗</span></button><button class="secondary-button" id="refreshBuildButton" type="button">刷新外部开发状态</button>` : backend.status === "kit_self_check_passed" ? `<button class="primary-button" id="acceptStageButton" type="button"><span>确认 ${ escapeHtml(backend.kit_stage || "本阶段") }，进入下一阶段</span><span class="button-arrow">↗</span></button>` : `<button class="primary-button" id="refreshBuildButton" type="button"><span>刷新开发状态</span></button>`;
  const panelCopy = previewReady ? stage.copy : backend.status === "awaiting_external_coding" ? "阶段工具包已经生成当前阶段任务\u3002请由外部编码工具完成任务\uFF0C完成后点击\u201C编码完成\uFF0C运行阶段自检\u201D\u3002" : selfCheckFailed ? "本阶段自检没有通过\u3002先根据下方输出修复开发项目\uFF0C再重新运行阶段自检\u3002" : backend.status === "kit_self_check_passed" ? "本阶段自检已通过\u3002请确认阶段结果\uFF0C系统会调用原始 kit.sh 进入下一阶段并生成新的阶段任务\u3002" : "这里展示 API\u3001数据模型\u3001测试和运行时结果\u3002验收通过只代表进入产品预览\uFF0C不代表预览已经验证\u3002";
  const newRequirementForm = previewReady && project.new_requirement_draft ? `<div class="iteration-box"><div class="section-kicker">新版本 · V${ Number(project.version || 1) + 1 }</div><h4>这次想新增或改变什么？</h4><p>下一版会新建独立项目和开发目录，不会自动带上上一版已经写好的代码。上一版仍可只读查看，不会被覆盖。</p><textarea id="newRequirementInput" aria-label="下一版需求" placeholder="例如：新增一个让用户导入访谈记录的入口"></textarea><div class="panel-actions"><button class="primary-button" id="createVersionButton" type="button"><span>开启下一版需求发现</span><span class="button-arrow">↗</span></button></div></div>` : "";
  const outputBlock = selfCheckOutput ? `<details class="delivery-details"><summary>阶段自检原始输出</summary><pre class="self-check-output">${ escapeHtml(selfCheckOutput.slice(-4000)) }</pre></details>` : "";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">${ headingKicker }</span><h3>${ escapeHtml(title) }</h3></div>${ headingChip }</div><p class="panel-copy">${ escapeHtml(panelCopy) }</p>${ preview }<details class="delivery-details" ><summary>交付详情<span>接口、任务与检查</span></summary><div class="plan-grid"><div class="plan-block"><h4>API 与数据</h4><ul>${ listHtml(backend.api_contract || backend.api || [
    "项目状态接口",
    "需求与方案确认接口",
    "预览与验收接口"
  ]) }</ul></div><div class="plan-block"><h4>开发任务</h4><ul>${ tasks.length ? tasks.map(task => `<li>${ escapeHtml(task.message || task.kind) } · ${ escapeHtml(task.status || "进行中") }</li>`).join("") : listHtml(backend.tasks, ["后端任务已创建\uFF0C等待状态回写"]) }</ul></div><div class="plan-block"><h4>测试与恢复</h4><ul>${ listHtml(checks, [
    "尚未返回结构化 API 测试结果",
    "重启恢复待验证",
    "运行时预览待后端返回"
  ]) }</ul></div><div class="plan-block"><h4>完成条件</h4><ul>${ listHtml(backend.acceptance || projectIntent(project).acceptance, [
    "用户能打开示例",
    "测试结果可查看",
    "项目状态可恢复"
  ]) }</ul></div></div>${ outputBlock }</details>${ newRequirementForm }<div class="panel-actions">${ action }</div>`;
  if (previewReady) {
    $("#verifyProductButton")?.addEventListener("click", () => verifyCodedProduct(project));
    $("#openPreviewButton")?.addEventListener("click", () => openCodedProduct(project));
    $("#openPlaygroundButton")?.addEventListener("click", () => openPlayground(project));
    $("#startTrialButton").addEventListener("click", () => startTrial(project));
  } else if (verified)
    $("#acceptanceButton").addEventListener("click", () => acceptBuild(project));
  else if (backend.status === "awaiting_external_coding" || selfCheckFailed) {
    $("#verifyBackendButton").addEventListener("click", () => verifyBackendStage(project));
    $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
  } else if (backend.status === "kit_self_check_passed") {
    $("#acceptStageButton").addEventListener("click", () => acceptDevelopmentStage(project));
  } else
    $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
}
function renderTrial(project) {
  showOnly("#previewPanel");
  const trial = project.trial || {};
  const feedback = list(trial.feedback);
  const addingFeedback = Boolean(safety.trialFeedbackOpen?.[project.id]);
  const feedbackForm = `<div class="supplement-box trial-feedback-form"><div class="section-kicker">补充试用反馈</div><h4>记录新的真实结果</h4><p>可以补充新的观察或修正之前的判断，反馈会继续保留在当前版本。</p><select id="trialOutcome" aria-label="试用结果"><option value="works">可以继续使用</option><option value="needs_change">需要调整</option><option value="blocked">当前无法使用</option></select><textarea id="trialFeedbackInput" aria-label="试用反馈" placeholder="例如：核心闭环能走通，但导入入口还不够清楚"></textarea><div class="panel-actions"><button class="primary-button" id="submitTrialFeedbackButton" type="button"><span>记录试用反馈</span><span class="button-arrow">↗</span></button></div></div>`;
  const previewCtaLabel = isPreviewVerified(project) ? "打开编码产物 ↗" : "验证并打开编码产物 ↗";
  const preview = project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${ escapeHtml("本地可运行预览") }</span><span>试用中</span></div><div class="preview-body"><h4>${ escapeHtml(project.plan.title || project.idea) }</h4><p>${ escapeHtml(project.plan.summary || "方案正在生成") }</p><button class="preview-cta" id="trialPreviewCta" type="button">${previewCtaLabel}</button></div></div>` : "";
  const feedbackBox = feedback.length ? `<div class="supplement-box"><div class="section-kicker">试用反馈</div><h4>已记录试用反馈</h4><ul>${ feedback.map(item => `<li>${ escapeHtml(item) }</li>`).join("") }</ul><p>可以继续观察，也可以基于当前反馈开启下一版。</p>${ addingFeedback ? feedbackForm : `<div class="panel-actions"><button class="secondary-button" id="openTrialFeedbackButton" type="button">补充反馈</button></div>` }</div>` : feedbackForm;
  const iterationForm = feedback.length && project.new_requirement_draft ? `<div class="iteration-box"><div class="section-kicker">新版本 · V${ Number(project.version || 1) + 1 }</div><h4>这次想新增或改变什么？</h4><p>下一版会新建独立项目和开发目录，不会自动带上上一版已经写好的代码。上一版仍可只读查看，不会被覆盖。</p><textarea id="newRequirementInput" aria-label="下一版需求" placeholder="例如：新增一个让用户导入访谈记录的入口"></textarea><div class="panel-actions"><button class="primary-button" id="createVersionButton" type="button"><span>开启下一版需求发现</span><span class="button-arrow">↗</span></button></div></div>` : "";
  const actions = feedback.length && !project.new_requirement_draft ? `<button class="secondary-button" id="openTrialPreviewButton" type="button">打开编码产物</button><button class="primary-button" id="newRequirementButton" type="button">加新需求，开启下一版</button>` : `<button class="secondary-button" id="openTrialPreviewButton" type="button">打开编码产物</button>`;
  const trialChip = !feedback.length ? "<span class=\"status-chip is-confirm\">等你确认</span>" : trial.outcome === "needs_change" || trial.outcome === "blocked" ? "<span class=\"status-chip is-revise\">需要修改</span>" : "<span class=\"status-chip is-done\">试用反馈已记录</span>";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">试用与反馈 · V${ project.version || 1 }</span><h3>${ "记录产品试用结果" }</h3></div>${ trialChip }</div><p class="panel-copy">验收通过只说明交付检查完成；预览已验证只说明运行检查通过。这里记录一次实际使用结果，再决定要不要继续迭代。</p>${ preview }${ feedbackBox }${ iterationForm }<div class="panel-actions">${ actions }</div>`;
  if (!feedback.length || addingFeedback)
    $("#submitTrialFeedbackButton").addEventListener("click", () => submitTrialFeedback(project));
  $("#openTrialFeedbackButton")?.addEventListener("click", () => {
    safety.trialFeedbackOpen[project.id] = true;
    render();
  });
  $("#trialPreviewCta")?.addEventListener("click", () => openPreview(project));
  $("#openTrialPreviewButton").addEventListener("click", () => openPreview(project));
  if (feedback.length) {
    $("#newRequirementButton")?.addEventListener("click", () => {
      project.new_requirement_draft = true;
      persist();
      render();
    });
    if (project.new_requirement_draft)
      $("#createVersionButton").addEventListener("click", () => createNextVersion(project));
  }
}
window.__workbenchUi = {
  pickModelStatus,
  statusOf,
  statusLabel,
  phaseForStatus,
  resultKind,
  chipText,
  taskCopy,
  isPreviewVerified,
  previewStageView,
  hasTrialFeedback,
  isPlanRevising,
  isKnownStatus,
  isUnknownProject,
  canStartBuild,
  canStartTrial,
  canSubmitTrialFeedback,
  canCreateNextVersion,
  questionOptions,
  optionMatchesAnswer
};
async function api(path, options = {}) {
  return request(path, options);
}
async function loadModelStatus() {
  try {
    state.model = pickModelStatus(await api("/api/v1/model/status"));
    state.modelUnavailable = false;
  } catch (_) {
    state.model = {
      configured: false,
      required: true,
      can_build: false
    };
    state.modelUnavailable = true;
  }
  render();
}
function renderModelSettings() {
  const info = modelGate();
  let dialog = $("#settingsDialog");
  if (!dialog) {
    document.body.insertAdjacentHTML("beforeend", "<dialog id=\"settingsDialog\" class=\"connection-dialog\"></dialog>");
    dialog = $("#settingsDialog");
  }
  dialog.innerHTML = `<div class="settings-card-head"><h3>本地服务状态</h3><button class="icon-button" id="closeSettingsButton" aria-label="关闭">×</button></div><p><strong>${ escapeHtml(info.label) }</strong></p><p>${ escapeHtml(info.reason) }</p><p>模型由后端管理。本界面不读取、保存或展示密钥，也不会写入任何配置。</p><button id="recheckConnection" class="secondary-button">重新检查</button>`;
  dialog.showModal();
  $("#closeSettingsButton").onclick = () => dialog.close();
  $("#recheckConnection").onclick = async () => {
    await loadModelStatus();
    dialog.close();
    renderModelSettings();
  };
}
async function refreshServerState() {
  await loadModelStatus();
  await loadProjects();
}
function parseProjectList(payload) {
  if (Array.isArray(payload))
    return payload;
  if (Array.isArray(payload?.projects))
    return payload.projects;
  return [];
}
async function loadProjects() {
  const selection = safety.selection, epoch = safety.writeEpoch;
  try {
    const payload = await api("/api/v1/projects");
    if (epoch !== safety.writeEpoch) return;
    const projects = parseProjectList(payload);
    safety.serverIds = new Set(projects.map(p => p.id));
    safety.authoritativeProjects = new Map(projects.map(p => [p.id, structuredClone(p)]));
    const cached = state.projects.filter(p => !safety.serverIds.has(p.id));
    state.projects = [
      ...projects,
      ...cached
    ];
    const savedId = state.current?.id || storageGet("ai-workbench-project") || storageGet("ai-workbench-online-preview-current");
    if (selection === safety.selection) {
      const serverMatch = projects.find(p => p.id === savedId);
      const saved = state.projects.find(p => p.id === savedId) || state.current;
      const family = saved ? projects.filter(p => (p.root_id || p.id) === (saved.root_id || saved.id)) : [];
      const authoritativeFamily = family.sort((a,b) => Number(b.version || 1) - Number(a.version || 1))[0];
      if (serverMatch) {
        state.current = serverMatch;
        safety.serverRecoveryNotice = "";
      } else if (authoritativeFamily) {
        state.current = authoritativeFamily;
        safety.serverRecoveryNotice = saved && !safety.serverIds.has(saved.id)
          ? "刚才选中的是本地缓存快照，服务器上没有这个项目。已切换到同一产品在服务器上的版本。缓存仍保留在列表中，只读。"
          : "";
      } else if (saved && projects.length && !safety.serverIds.has(saved.id)) {
        state.current = null;
        safety.serverRecoveryNotice = "刚才选中的本地缓存快照不在服务器上。缓存已保留在左侧列表中（只读）。请打开服务器上的项目继续，或新建项目。";
      } else {
        state.current = saved || null;
        if (state.current && safety.serverIds.has(state.current.id))
          safety.serverRecoveryNotice = "";
      }
    }
    persist();
    if (state.current && safety.serverIds.has(state.current.id)) {
      await loadProject(state.current.id);
      return;
    }
    render();
  } catch (error) {
    showError("本地后端不可达\uFF0C已保留缓存与草稿\u3002缓存只读\uFF0C不会覆盖服务器阶段\u3002");
    render();
  }
}
async function loadProject(projectId) {
  const token = ++safety.selection, epoch = safety.writeEpoch;
  state.creating = false;
  const cached = state.projects.find(p => p.id === projectId);
  if (cached) {
    state.current = cached;
    render();
  }
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(projectId) }`);
    if (token !== safety.selection || epoch !== safety.writeEpoch)
      return;
    replaceProject(payload.project, true);
    safety.serverRecoveryNotice = "";
    storageSet("ai-workbench-project", projectId);
    if (payload.project?.status === "backend_building") {
      const development = await api(`/api/v1/projects/${ encodeURIComponent(projectId) }/development`);
      if (token !== safety.selection || epoch !== safety.writeEpoch)
        return;
      safety.development[projectId] = development.development || {};
      if (development.project)
        replaceProject(development.project, true);
    }
    if (["preview_ready", "trial"].includes(payload.project?.status)) {
      const metadata = await api(`/api/v1/projects/${encodeURIComponent(projectId)}/preview`);
      if (token !== safety.selection || epoch !== safety.writeEpoch) return;
      safety.previews[projectId] = metadata.preview || {}; if (metadata.playground) safety.playgrounds[projectId] = metadata.playground;
    }
    render();
  } catch (error) {
    if (token === safety.selection) {
      if (hasInFlightLongMutation())
        render();
      else {
        showError("读取服务器状态失败\u3002未使用缓存推进流程\uFF0C请重新查询\u3002");
        render();
      }
    }
  }
}
async function createProject(event) {
  event.preventDefault();
  const idea = $("#idea").value.trim();
  if (idea.length < 3)
    return showError("先用一句话说清楚想做什么\uFF0C至少 3 个字\u3002");
  if (!canStartBuild())
    return showError(modelGate().reason);
  const token = safety.selection;
  const button = $("#startBuildButton");
  setActionBusy(button, "正在创建");
  clearError();
  try {
    const payload = await api("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ idea })
    });
    if (token === safety.selection) {
      replaceProject(payload.project, true);
      state.creating = false;
    } else
      replaceProject(payload.project);
    storageSet("ai-workbench-project", payload.project.id);
    if ($("#idea").value.trim() === idea) { clearDraft("new", "idea"); $("#idea").value = ""; }
    render();
  } catch (error) {
    showError(error.message);
  } finally {
    restoreAction(button);
    render();
  }
}
function currentAnswers() {
  return state.current?.answers || {};
}
async function submitAnswers() {
  const answers = {};
  document.querySelectorAll("#questionPanel:not(.hidden) [data-question-id], #planPanel:not(.hidden) [data-question-id]").forEach(input => {
    const custom = input.closest("[data-question-card]")?.querySelector("[data-question-custom]")?.value.trim();
    const selected = input.value.trim();
    answers[input.dataset.questionId] = custom ? selected ? `${ selected }；补充：${ custom }` : custom : selected;
  });
  if (Object.values(answers).some(answer => !answer)) {
    showError("还有一个关键问题没有回答");
    return;
  }
  const button = $("#answerButton");
  setActionBusy(button, "正在判断需求");
  clearError();
  try {
    {
      const payload = await api(`/api/v1/projects/${ encodeURIComponent(state.current.id) }/answers`, {
        method: "POST",
        body: JSON.stringify({ answers })
      });
      replaceProject(payload.project);
    }
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
async function continueDiscovery(project) {
  const button = $("#continueDiscoveryButton");
  setActionBusy(button, "正在准备下一轮");
  ;
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/confirm-intent`, {
      method: "POST",
      body: JSON.stringify({
        confirmed: false,
        note: "需要补充或修正需求"
      })
    });
    replaceProject(payload.project);
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
function submitSupplement(project) {
  const value = $("#supplementInput")?.value.trim();
  if (!value) {
    showError("先写一条需要纳入判断的补充");
    return;
  }
  const button = $("#submitSupplementButton");
  setActionBusy(button, "正在保存补充");
  ;
  api(`/api/v1/projects/${ encodeURIComponent(project.id) }/supplement`, {
    method: "POST",
    body: JSON.stringify({ text: value })
  }).then(payload => {
    replaceProject(payload.project);
    render();
  }).catch(error => {
    restoreAction(button);
    showError(error.message);
  });
}
async function confirmIntent(project) {
  clearError();
  const button = $("#confirmIntentButton");
  setActionBusy(button, "正在整理 PRD");
  const stopProgress = startPlanProgress(project);
  try {
    const input = $("#workshopDraft");
    const body = input && project.workshop ? {
      confirmed: true,
      draft: input.value
    } : { confirmed: true };
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/confirm-intent`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (payload.project) {
      const current = state.projects.find(item => item.id === payload.project.id) || state.current;
      const newerAnswers = list(current?.workshop?.answer_transcript).length > list(payload.project.workshop?.answer_transcript).length || list(current?.workshop?.answer_draft).length > list(payload.project.workshop?.answer_draft).length;
      if (!newerAnswers)
        replaceProject(payload.project);
    }
  } catch (error) {
    restoreAction(button);
    const latest = state.current?.id === project.id ? state.current : project;
    if (!planDerivationComplete(latest))
      showError(error.message);
  } finally {
    stopProgress();
    settleSavedPlanDerivation(state.current?.id === project.id ? state.current : project);
    render();
  }
}
async function generateRealPlan() {
  const button = $("#realPlanButton");
  button.disabled = true;
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(state.current.id) }/real-plan`, {
      method: "POST",
      body: JSON.stringify({ answers: currentAnswers() })
    });
    if (payload)
      replaceProject(payload.project);
    render();
  } catch (error) {
    showError(`${ error.message }。真实模型失败不会覆盖当前方案。`);
    button.disabled = false;
  }
}
async function startBackendBuild(project) {
  const button = $("#startBackendButton");
  setActionBusy(button, "正在准备开发");
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/build`, {
      method: "POST",
      body: JSON.stringify({ execution_mode: "real" })
    });
    replaceProject(payload.project);
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
    render();
  }
}
async function verifyBackendStage(project) {
  const button = $("#verifyBackendButton");
  setActionBusy(button, "正在运行阶段自检");
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/development/verify`, { method: "POST" });
    replaceProject(payload.project);
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
    render();
  }
}
async function acceptDevelopmentStage(project) {
  const backend = projectBackend(project);
  const nextStage = selectedNextStage(project);
  const gate = stageGate(project);
  if (project.status !== "backend_building" || backend.status !== "kit_self_check_passed" || backend.stage_accepted !== true)
    return showError("先完成阶段自检和自然语言验收，再明确确认通过。");
  if (!nextStage && gate.kind === "choice")
    return showError(gate.kind === "choice" ? "这一阶段之后有分岔，请先选择下一阶段，再确认验收通过。" : "后端尚未返回阶段工具包的下一阶段，不能提交空的阶段选择。");
  if (!window.confirm(`你确认 ${ backend.kit_stage || "本阶段" } 验收通过，并进入 ${ nextStage } 吗？此操作会推进真实后端流程。`))
    return;
  const button = $("#acceptStageButton");
  setActionBusy(button, "正在提交明确验收");
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/development/accept`, {
      method: "POST",
      body: JSON.stringify({
        passed: true,
        next_stage: nextStage,
        note: "用户通过验收按钮明确确认本阶段验收通过"
      })
    });
    delete safety.stageChoices[project.id];
    replaceProject(payload.project);
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
    render();
  }
}
function renderDevelopmentAcceptance(project) {
  const backend = projectBackend(project);
  const passed = backend.status === "kit_self_check_passed";
  const stage = backend.kit_stage || "阶段0";
  const gate = stageGate(project);
  const selected = selectedNextStage(project);
  const intro = !list(backend.stage_transcript).length ? `<div class="teacher-chat-message is-assistant"><span class="teacher-chat-role">我的代码</span><p>${ passed ? "阶段自检已经通过。我会用自然语言说明验收结果，确认后才进入下一阶段。" : "阶段自检没有通过。我会说明缺口，你可以继续补充决定或让外部编码工具修复。" }</p></div>` : "";
  const output = String(backend.kit_last_output || "").trim();
  const choice = passed && gate.kind === "choice" ? `<div class="stage-choice" role="radiogroup" aria-label="选择下一阶段">${ gate.options.map(option => `<button type="button" class="stage-choice-option ${ selected === option ? "is-selected" : "" }" role="radio" aria-checked="${ selected === option }" data-next-stage="${ escapeHtml(option) }"><strong>${ escapeHtml(option) }</strong><small>${ escapeHtml(gate.labels[option] || option) }</small></button>`).join("") }</div>` : "";
  const acceptEnabled = backend.stage_accepted && (gate.kind === "fixed" ? Boolean(gate.fixed) : gate.kind === "choice" ? Boolean(selected) : true);
  const acceptLabel = !backend.stage_accepted ? "完成对话后确认验收" : gate.kind === "choice" && !selected ? "请选择下一阶段" : `验收通过，进入 ${ selected || gate.fixed || "工具包下一阶段" }`;
  const action = passed ? `<button class="primary-button" id="acceptStageButton" type="button" ${ acceptEnabled ? "" : "disabled" } title="${ !backend.stage_accepted ? "请先完成自然语言验收" : gate.kind === "choice" && !selected ? "请先选择下一阶段" : "" }"><span>${ escapeHtml(acceptLabel) }</span><span class="button-arrow">↗</span></button>` : `<button class="primary-button" id="verifyBackendButton" type="button"><span>重新运行阶段自检</span><span class="button-arrow">↗</span></button>`;
  const copy = passed ? (gate.kind === "choice" ? "先完成自然语言验收，再在下面的真实候选项里选择下一阶段。没有选择时不会默认进入某一阶段，也不会把它当成自检失败。" : `按阶段工具包，${ stage } 之后进入 ${ gate.fixed || "下一阶段" }。先完成自然语言验收，再由你点击验收通过。`) : "这里不直接要求你读日志。先通过自然语言确认缺口，再让外部编码工具修复并重新自检。";
  showOnly("#previewPanel");
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块二 · ${ escapeHtml(stage) } · 自然语言验收</span><h3>${ passed ? `${ stage } 自检通过，等待验收` : `${ stage } 自检未通过，先对话修正` }</h3></div><span class="status-chip ${ passed ? "is-confirm" : "is-revise" }">${ passed ? backend.stage_accepted ? "等待你最终确认" : "等待自然语言验收" : "需要处理" }</span></div><p class="panel-copy">${ escapeHtml(copy) }</p>${ renderTeacherChat(project, "development", intro) }${ teacherChatDock(project, "development") }${ choice }<details class="delivery-details"><summary>自检证据<span>原始输出</span></summary><pre class="self-check-output">${ escapeHtml(output || "暂无自检输出") }</pre></details><div class="panel-actions">${ action }<button class="secondary-button" id="refreshBuildButton" type="button">刷新状态</button></div>`;
  bindTeacherChat(project, "development");
  $("#previewPanel").querySelectorAll("[data-next-stage]").forEach(button => {
    button.addEventListener("click", () => {
      safety.stageChoices[project.id] = button.dataset.nextStage;
      render();
    });
  });
  if (passed)
    $("#acceptStageButton")?.addEventListener("click", () => acceptDevelopmentStage(project));
  else
    $("#verifyBackendButton")?.addEventListener("click", () => verifyBackendStage(project));
  $("#refreshBuildButton")?.addEventListener("click", () => loadProject(project.id));
}

async function confirmPlan(project, confirmed = true) {
  if (confirmed && !canConfirmPlan(project))
    return showError(planBlockers(project).join("\uFF1B"));
  clearError();
  const button = $("#confirmPlanButton");
  setActionBusy(button, "正在交接方案");
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/confirm-plan`, {
      method: "POST",
      body: JSON.stringify({
        confirmed,
        note: confirmed ? "用户确认方案\uFF0C进入开发准备" : "用户提出方案修改"
      })
    });
    replaceProject(payload.project);
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
async function createNextVersion(project) {
  if (!canCreateNextVersion(project))
    return showError("请先开始试用并记录一次非空反馈\u3002");
  const change = $("#newRequirementInput")?.value.trim();
  if (!change)
    return showError("先说清楚 V2 要改变什么\u3002");
  const token = safety.selection;
  const button = $("#createVersionButton");
  setActionBusy(button, "正在创建独立版本");
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/iterations`, {
      method: "POST",
      body: JSON.stringify({ change_request: change })
    });
    if (!payload.project?.parent_id || !payload.project?.root_id || !payload.project?.version)
      throw new Error("后端没有返回完整版本关系\uFF0C请重新查询\uFF0C切勿重复创建\u3002");
    replaceProject(payload.project, token === safety.selection && state.current?.id === project.id);

    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
async function acceptBuild(project) {
  clearError();
  const button = $("#acceptanceButton");
  setActionBusy(button, "正在保存验收");
  try {
    {
      const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/acceptance`, {
        method: "POST",
        body: JSON.stringify({ passed: true })
      });
      replaceProject(payload.project);
    }
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
async function startTrial(project) {
  if (!canStartTrial(project)) {
    showError("请先完成预览验证\uFF0C再开始试用");
    render();
    return;
  }
  clearError();
  const button = $("#startTrialButton");
  setActionBusy(button, "正在进入试用");
  try {
    {
      const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/trial`, {
        method: "POST",
        body: JSON.stringify({})
      });
      replaceProject(payload.project);
    }
    render();
  } catch (error) {
    restoreAction(button);
    showError(error.message);
  }
}
async function submitTrialFeedback(project) {
  if (!canSubmitTrialFeedback(project)) {
    showError("请先开始试用\uFF0C再记录反馈");
    render();
    return;
  }
  const input = $("#trialFeedbackInput");
  const feedback = input?.value.trim();
  const outcome = $("#trialOutcome")?.value || "needs_change";
  if (!feedback) {
    showError("先写一条真实试用反馈");
    return;
  }
  const button = $("#submitTrialFeedbackButton");
  if (button)
    button.disabled = true;
  clearError();
  try {
    {
      const payload = await api(`/api/v1/projects/${ encodeURIComponent(project.id) }/trial-feedback`, {
        method: "POST",
        body: JSON.stringify({
          feedback,
          outcome
        })
      });
      replaceProject(payload.project);
      safety.trialFeedbackOpen[project.id] = false;

    }
    render();
  } catch (error) {
    showError(error.message);
    if (button)
      button.disabled = false;
  }
}
async function verifyCodedProduct(project) {
  const button = $("#verifyProductButton") || $("#openPreviewButton") || $("#trialPreviewCta");
  setActionBusy(button, "正在探测编码产物");
  clearError();
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview/verify`, {method:"POST"});
    if (payload.project) replaceProject(payload.project);
    safety.previews[project.id] = payload.preview || {};
    if (payload.playground) safety.playgrounds[project.id] = payload.playground;
    render();
    if (!isPreviewVerified(state.current) && project.id === state.current?.id) {
      const checks = list(payload.preview?.checks || safety.previews[project.id]?.checks);
      const pending = checks.filter(check => check?.status && check.status !== "passed").map(check => `${check.label || check.id || "检查"}：${check.detail || check.status}`);
      const detail = pending.length ? pending.join("；") : "页面、健康检查和核心动作尚未全部探测通过";
      showError(`编码产物尚未验证通过。${detail}。方案试玩里的模拟回复不能当作这些检查已通过。缺地址或路径 404 时，请在产物 README.md、产品README.md 或 docs/项目状态.md 中补上本机地址后再验证。`);
    }
  } catch (error) {
    restoreAction(button);
    showError(error.message);
    render();
  }
}
async function openCodedProduct(project) {
  const button = $("#openPreviewButton") || $("#openTrialPreviewButton");
  setActionBusy(button, "正在打开编码产物");
  clearError();
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) previewWindow.opener = null;
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview`);
    if (payload.project) replaceProject(payload.project);
    safety.previews[project.id] = payload.preview || {};
    if (payload.playground) safety.playgrounds[project.id] = payload.playground;
    render();
    const url = safeRuntimeUrl(payload.preview?.url);
    if (url && previewWindow) previewWindow.location.replace(url);
    else {
      previewWindow?.close();
      showError(url ? "预览状态已保存，浏览器阻止了新窗口。请使用预览详情中的链接打开。" : "还没有可打开的编码产物地址。请先验证产物，不要把方案试玩当成产品预览。");
    }
  } catch (error) {
    previewWindow?.close();
    restoreAction(button);
    showError(error.message);
  }
}
async function openPlayground(project) {
  const button = $("#openPlaygroundButton");
  setActionBusy(button, "正在打开方案试玩");
  clearError();
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) previewWindow.opener = null;
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview`);
    if (payload.project) replaceProject(payload.project);
    safety.previews[project.id] = payload.preview || {};
    if (payload.playground) safety.playgrounds[project.id] = payload.playground;
    render();
    const url = safeRuntimeUrl(payload.playground?.url);
    if (url && previewWindow) previewWindow.location.replace(url);
    else {
      previewWindow?.close();
      showError("没有可用的方案试玩地址。这不会验证编码产物，也不会开启试用。");
    }
  } catch (error) {
    previewWindow?.close();
    restoreAction(button);
    showError(error.message);
  }
}
async function openPreview(project) {
  if (isPreviewVerified(project))
    return openCodedProduct(project);
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow)
    previewWindow.opener = null;
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview/verify`, {method:"POST"});
    if (payload.project)
      replaceProject(payload.project);
    safety.previews[project.id] = payload.preview || {};
    if (payload.playground)
      safety.playgrounds[project.id] = payload.playground;
    const url = safeRuntimeUrl(payload.preview?.url);
    if (url && payload.preview?.status === "verified" && previewWindow)
      previewWindow.location.replace(url);
    else {
      previewWindow?.close();
      showError(url ? "编码产物尚未通过完整验证，先处理验证结果后再打开。" : "还没有可打开的编码产物地址。请先验证产物。");
    }
    render();
  } catch (error) {
    previewWindow?.close();
    showError(error.message);
    render();
  }
}
const ONLINE_STORAGE_SCHEMA_VERSION = "2";
const LEGACY_STATUS_MIGRATIONS = {
  idea: "needs_discovery",
  needs_clarification: "needs_discovery",
  requirements_confirmed: "needs_intent_confirmation",
  plan_draft: "needs_plan_confirmation",
  plan_ready: "needs_plan_confirmation",
  accepted: "preview_ready"
};
function normalizeSavedProject(project) {
  if (!project || typeof project !== "object")
    return null;
  const normalized = { ...project };
  let changed = false;
  const nextStatus = LEGACY_STATUS_MIGRATIONS[normalized.status];
  if (nextStatus && nextStatus !== normalized.status) {
    normalized.status = nextStatus;
    changed = true;
  }
  if (!Number.isInteger(normalized.discovery_round) && Number.isInteger(normalized.round)) {
    normalized.discovery_round = Math.max(0, normalized.round);
    changed = true;
  }
  if ("round" in normalized) {
    delete normalized.round;
    changed = true;
  }
  if (!normalized.backend && normalized.engineering && typeof normalized.engineering === "object") {
    normalized.backend = normalized.engineering;
    changed = true;
  }
  if ("engineering" in normalized) {
    delete normalized.engineering;
    changed = true;
  }
  if (normalized.answers && normalized.answers.core_action && !normalized.answers.desired_outcome) {
    normalized.answers = {
      ...normalized.answers,
      desired_outcome: normalized.answers.core_action
    };
    changed = true;
  }
  if ("accepted" in normalized) {
    delete normalized.accepted;
    changed = true;
  }
  return {
    project: normalized,
    changed
  };
}
function persist() {
  storageSet("ai-workbench-online-preview-projects", JSON.stringify(state.projects));
  storageSet("ai-workbench-online-preview-current", state.current?.id || "");
  storageSet("ai-workbench-online-preview-schema", ONLINE_STORAGE_SCHEMA_VERSION);
}
function loadSaved() {
  let saved;
  let parsed = true;
  try {
    saved = JSON.parse(storageGet("ai-workbench-online-preview-projects") || "[]");
  } catch (_) {
    saved = [];
    parsed = false;
  }
  const migrated = parsed && Array.isArray(saved) ? saved.map(normalizeSavedProject).filter(Boolean) : [];
  state.projects = migrated.map(entry => entry.project);
  const currentId = storageGet("ai-workbench-online-preview-current");
  state.current = state.projects.find(project => project.id === currentId) || state.projects[0] || null;
  if (parsed && Array.isArray(saved) && (storageGet("ai-workbench-online-preview-schema") !== ONLINE_STORAGE_SCHEMA_VERSION || migrated.some(entry => entry.changed)))
    persist();
  render();
}

$("#ideaForm").addEventListener("submit", createProject);
$("#settingsButton")?.addEventListener("click", () => renderModelSettings());
$("#helpButton").addEventListener("click", () => {
  state.helpOpen = !state.helpOpen;
  render();
});
$("#showNewProjectButton").addEventListener("click", () => {
  safety.selection++;
  state.creating = true;
  setNavigationOpen(false);
  render();
  $("#idea").focus();
});
$("#cancelNewProjectButton")?.addEventListener("click", () => {
  state.creating = false;
  render();
});
$("#refreshButton").addEventListener("click", () => refreshServerState());
initializeClient();
function setNavigationOpen(open, restoreFocus = false) {
  const shell = $("#workbenchShell");
  const trigger = $("#openNavigationButton");
  const navigation = $("#projectNavigation");
  const backdrop = $("#navBackdrop");
  if (!shell || !trigger || !navigation || !backdrop)
    return;
  shell.classList.toggle("nav-open", open);
  trigger.setAttribute("aria-expanded", String(open));
  backdrop.hidden = !open;
  if (window.matchMedia?.("(max-width: 800px)").matches) {
    navigation.inert = !open;
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (open)
    $("#closeNavigationButton")?.focus();
  else if (restoreFocus)
    trigger.focus();
}
$("#openNavigationButton")?.addEventListener("click", () => setNavigationOpen(true));
$("#closeNavigationButton")?.addEventListener("click", () => setNavigationOpen(false, true));
$("#navBackdrop")?.addEventListener("click", () => setNavigationOpen(false, true));
document.addEventListener("keydown", event => {
  const shell = $("#workbenchShell");
  if (!shell?.classList.contains("nav-open"))
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    setNavigationOpen(false, true);
  }
  if (event.key === "Tab") {
    const controls = [...$("#projectNavigation").querySelectorAll("a[href], button:not(:disabled)")].filter(node => node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first)
      return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
const navigationMedia = window.matchMedia?.("(max-width: 800px)");
function syncNavigationViewport() {
  setNavigationOpen(false);
  const navigation = $("#projectNavigation");
  if (navigation)
    navigation.inert = Boolean(navigationMedia?.matches);
  if (document.body)
    document.body.style.overflow = "";
}
navigationMedia?.addEventListener("change", syncNavigationViewport);
syncNavigationViewport();
document.querySelectorAll("[data-idea-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    const input = $("#idea");
    if (input) {
      input.value = button.dataset.ideaPrompt;
      input.focus();
    }
  });
});
$("#helpButton")?.addEventListener("click", () => {
  if (state.helpOpen)
    $("#welcomeGuide")?.scrollIntoView({
      block: "nearest",
      behavior: "smooth"
    });
});
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}
function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_) {
  }
}
function tabStorageGet(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch (_) {
    return null;
  }
}
function tabStorageSet(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch (_) {
  }
}
function readClientState() {
  try {
    const value = JSON.parse(storageGet(CLIENT_STORAGE) || "{}");
    const tabValue = JSON.parse(tabStorageGet(TAB_PENDING_STORAGE) || "{}");
    return {
      drafts: value.drafts || {},
      pending: tabValue.pending || {},
      unsent: tabValue.unsent || {}
    };
  } catch (_) {
    return {
      drafts: {},
      pending: {},
      unsent: {}
    };
  }
}
function saveSafety() {
  storageSet(CLIENT_STORAGE, JSON.stringify({ drafts: safety.drafts }));
  tabStorageSet(TAB_PENDING_STORAGE, JSON.stringify({
    pending: safety.pending,
    unsent: safety.unsent
  }));
}
function modelGate() {
  if (state.modelUnavailable)
    return {
      allowed: false,
      label: "本地后端不可达",
      reason: "连接本地服务失败\u3002这不代表模型未配置\uFF1B请确认本地服务已启动\uFF0C再重新查询\u3002"
    };
  if (!state.model)
    return {
      allowed: false,
      label: "正在连接本地服务",
      reason: "正在读取后端能力\uFF0C尚未调用模型\u3002"
    };
  const model = state.model;
  if (model.required && !model.configured)
    return {
      allowed: false,
      label: "模型尚未配置",
      reason: "后端要求真实模型\uFF0C但尚未完成配置\u3002请由服务管理者在后端处理\uFF0C前端不接收密钥\u3002"
    };
  if (!model.can_build)
    return {
      allowed: false,
      label: "模型或后端能力不可用",
      reason: "后端当前不允许创建或开发\u3002已配置不等于可用\uFF0C请检查服务能力后重试查询\u3002"
    };
  if (!model.required)
    return {
      allowed: true,
      label: "后端 mock 模式",
      reason: "后端未要求真实模型\u3002当前仅按后端能力提供 mock\uFF0C不代表真实模型已成功执行\u3002"
    };
  return {
    allowed: true,
    label: "本地服务已连接",
    reason: "通过同源后端执行\uFF1B每个关键阶段都等待你的确认\u3002"
  };
}
function primaryPlanBlocker(project) {
  const answerQuestions = list(project?.workshop?.answer_questions);
  const openQuestions = list(project?.plan?.open_questions);
  const uncoveredAnswers = answerQuestions.filter(item => !questionHasReusableDecision(project?.workshop, item));
  const uncoveredOpen = openQuestions.filter(item => !questionHasReusableDecision(project?.workshop, item));
  if (list(project?.workshop?.answer_draft).length)
    return "待将回答写回 PRD 并重新审稿。";
  if (uncoveredAnswers.length || uncoveredOpen.length)
    return `还有 ${uncoveredAnswers.length || uncoveredOpen.length} 个待确认问题。`;
  if (!(Number(project?.plan?.review_score) >= 80))
    return "独立审稿未达到 80 分。";
  if (project?.plan?.review_ok !== true)
    return "独立审稿尚未通过。";
  if (project?.plan_revision?.status === "needs_input")
    return "方案修改尚未完成。";
  return "先完成待确认项和审稿门禁。";
}
function planBlockers(project) {
  const reasons = [];
  if (project?.status !== "needs_plan_confirmation")
    reasons.push("当前不在方案确认阶段");
  if (project?.confirmations?.intent !== true)
    reasons.push("需求稿尚未确认");
  const answerQuestions = list(project?.workshop?.answer_questions);
  const openQuestions = list(project?.plan?.open_questions);
  const uncoveredAnswers = answerQuestions.filter(item => !questionHasReusableDecision(project?.workshop, item));
  const uncoveredOpen = openQuestions.filter(item => !questionHasReusableDecision(project?.workshop, item));
  const revisingNow = needsExistingDecisionRevision(project);
  const revisingCoveredAnswers = revisingNow || Boolean(project?.workshop) && answerQuestions.length && !uncoveredAnswers.length && !planReviewPassed(project?.plan) && hasReusablePlanDecisions(project);
  const revisingCoveredOpen = revisingNow || Boolean(project?.workshop) && openQuestions.length && !uncoveredOpen.length && !planReviewPassed(project?.plan) && hasReusablePlanDecisions(project);
  if (answerQuestions.length)
    reasons.push(revisingCoveredAnswers ? "待按已有答复修订方案并重新审稿" : `还有 ${ uncoveredAnswers.length || answerQuestions.length } 个方案问题`);
  if (openQuestions.length) {
    const openReason = revisingCoveredOpen ? "待按已有答复修订方案并重新审稿" : `还有 ${ uncoveredOpen.length || openQuestions.length } 个待确认项`;
    if (!reasons.includes(openReason))
      reasons.push(openReason);
  }
  if (list(project?.workshop?.answer_draft).length)
    reasons.push("待将回答写回 PRD 并重新审稿");
  if (!(Number(project?.plan?.review_score) >= 80))
    reasons.push("独立审稿未达到 80 分");
  if (project?.plan?.review_ok !== true)
    reasons.push("独立审稿尚未通过");
  if (project?.plan_revision?.status === "needs_input")
    reasons.push("方案修改尚未完成");
  if (!project?.workshop)
    reasons.push("还没有方案问答记录，请先开始方案问答");
  return reasons;
}
function canConfirmPlan(project) {
  return planBlockers(project).length === 0;
}
function isHistorical(project) {
  if (!project || !safety.authoritativeProjects.has(project.id)) return false;
  const canonical = safety.authoritativeProjects.get(project.id);
  // Cached descendants are retained, but cannot establish a server-side version relationship.
  return [...safety.authoritativeProjects.values()].some(other =>
    other.id !== canonical.id &&
    (other.root_id || other.id) === (canonical.root_id || canonical.id) &&
    Number(other.version) > Number(canonical.version));
}
function draftContext(id) {
  const project = state.current;
  if (id === "idea")
    return {
      owner: "new",
      stage: "idea"
    };
  let stage = project?.status || "new";
  if (id === "teacherChatInput")
    stage = project?.status === "needs_discovery" ? "intake" : project?.status === "needs_plan_confirmation" ? "answers" : "development";
  if (stage === "development")
    stage += `:${ projectBackend(project).kit_stage || "" }:${ projectBackend(project).status || "" }`;
  return {
    owner: project?.id || "new",
    stage
  };
}
function draftKey(owner, id, stage) {
  return `${ owner }:${ stage || draftContext(id).stage }:${ id }`;
}
function clearDraft(owner, id, stage) {
  for (const key of Object.keys(safety.drafts)) {
    if (!key.startsWith(owner + ":") || !key.endsWith(":" + id)) continue;
    if (!stage || stage === "development" || key === draftKey(owner,id,stage)) delete safety.drafts[key];
  }
  saveSafety();
}
function clearSubmittedFields(path, body, owner) {
  let id = "", submitted = "", stage = "";
  if (/\/(workshop-chat|development-chat)$/.test(path)) {
    id = "teacherChatInput"; submitted = body.messages?.at(-1)?.text || "";
    stage = path.endsWith("development-chat") ? "development" : body.stage;
    delete safety.unsent[owner + ":" + stage];
  } else if (path === "/api/v1/projects") { owner = "new"; id = "idea"; submitted = body.idea; }
  else if (path.endsWith("/confirm-intent")) { id = "workshopDraft"; submitted = body.draft; }
  else if (path.endsWith("/trial-feedback")) { id = "trialFeedbackInput"; submitted = body.feedback; }
  else if (path.endsWith("/iterations")) { id = "newRequirementInput"; submitted = body.change_request; }
  if (!id || typeof submitted !== "string") return;
  for (const key of Object.keys(safety.drafts)) {
    if (key.startsWith(owner + ":") && key.endsWith(":" + id) && String(safety.drafts[key]).trim() === submitted.trim()) delete safety.drafts[key];
  }
  saveSafety();
}
function rememberInput(input) {
  if (!input?.id || !input.matches("textarea, input:not([type=password]), select"))
    return;
  const {owner, stage} = draftContext(input.id);
  safety.drafts[draftKey(owner, input.id, stage)] = input.value;
  saveSafety();
}
function restoreInputs() {
  document.querySelectorAll("textarea[id],input[id]:not([type=password]),select[id]").forEach(input => {
    const {owner, stage} = draftContext(input.id), value = safety.drafts[draftKey(owner, input.id, stage)];
    if (typeof value === "string")
      input.value = value;
  });
}
function safeRuntimeUrl(value) {
  if (!value)
    return null;
  try {
    const url = new URL(value, location.origin);
    return [
      "http:",
      "https:"
    ].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch (_) {
    return null;
  }
}
function mutationKey(path) {
  const match = path.match(/^\/api\/v1\/projects\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : "create";
}
function assertMutationAllowed(path, body) {
  const key = mutationKey(path), project = state.projects.find(p => p.id === key);
  if (key !== "create") {
    if (!safety.serverIds.has(key))
      throw new Error("这个项目尚未从服务器恢复\u3002请先重新查询\uFF1B缓存只读\u3002");
    if (isHistorical(project))
      throw new Error("这是历史版本\uFF0C只读查看与下载\uFF1B请切换到最新版本继续\u3002");
  }
  if (/\/confirm-intent$/.test(path) && (project?.status !== "needs_intent_confirmation" || body.confirmed && !String(body.draft ?? project.workshop?.draft ?? "").trim())) throw new Error("先完成需求澄清并核对非空需求稿。");
  if (/\/development-chat$/.test(path) && (project?.status !== "backend_building" || !["stage_task_ready","stage_advanced","kit_self_check_failed","kit_self_check_passed"].includes(projectBackend(project).status))) throw new Error("当前不在阶段确认或自然语言验收环节。");
  if (/\/development\/verify$/.test(path) && (project?.status !== "backend_building" || !["awaiting_external_coding","kit_self_check_failed","kit_self_check_passed","stage_advanced"].includes(projectBackend(project).status))) throw new Error("请先开始本阶段开发，由外部编码完成后再运行自检。");
  if (/\/acceptance$/.test(path) && project?.status !== "backend_verified") throw new Error("先完成全部开发阶段与阶段验收，再确认最终交付。");
  if (/\/trial-feedback$/.test(path) && project?.status !== "trial") throw new Error("请先进入试用，再记录反馈。");
  if (/\/confirm-plan$/.test(path) && body.confirmed && !canConfirmPlan(project))
    throw new Error(planBlockers(project).join("\uFF1B"));
  if (/\/build$/.test(path)) {
    const backend = projectBackend(project);
    if (project?.status !== "backend_building" || project?.confirmations?.plan !== true || !backend.stage_confirmed || ![
        "stage_task_ready",
        "stage_advanced",
        "kit_self_check_failed"
      ].includes(backend.status))
      throw new Error("先完成当前阶段的自然语言确认\uFF1B外部编码已开始时不能重复开始\u3002");
  }
  if (/\/development\/accept$/.test(path)) {
    const backend = projectBackend(project);
    if (project?.status !== "backend_building" || backend.status !== "kit_self_check_passed" || backend.stage_accepted !== true)
      throw new Error("阶段自检和自然语言验收均通过后，才能明确验收。");
    if (!body.next_stage && project?.backend?.next_stage_options?.length)
      throw new Error("请先选择或确认阶段工具包给出的下一阶段，不能提交空的阶段选择。");
  }
  if (/\/trial$/.test(path) && !canStartTrial(project))
    throw new Error("编码产物尚未验证，不能进入试用。");
  if (/\/trial-feedback$/.test(path) && !String(body.feedback || "").trim())
    throw new Error("试用反馈不能为空\u3002");
  if (/\/iterations$/.test(path) && (!canCreateNextVersion(project) || !String(body.change_request || "").trim()))
    throw new Error("先记录非空试用反馈\uFF0C并填写新版本需求\u3002");
}
async function fetchJson(path, options = {}) {
  if (!/^\/api\/v1\//.test(path))
    throw new Error("只允许同源 API\u3002");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs(path, options.method));
  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Accept": "application/json",
        ...options.body ? { "Content-Type": "application/json" } : {},
        ...options.headers
      },
      cache: "no-store",
      signal: controller.signal
    });
    const payload = await response.json().catch(() => {
      throw new Error("后端未返回有效 JSON\uFF0C请重新查询状态\u3002");
    });
    if (!response.ok) {
      const error = new Error(payload.error?.message || payload.detail?.message || `本地服务返回 ${ response.status }，请检查当前阶段。`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error && (error.name === "AbortError" || /aborted|abort/i.test(String(error.message || "")))) {
      const timeout = new Error(isLongMutation(path) ? "请求时间较长，正在查询服务器是否已经完成。" : "请求超时，请重新查询当前状态。");
      timeout.aborted = true;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function request(path, options = {}) {
  const mutation = (options.method || "GET").toUpperCase() !== "GET";
  if (!mutation)
    return fetchJson(path, options);
  const key = mutationKey(path), body = JSON.parse(options.body || "{}");
  const currentProject = state.projects.find(item => item.id === key) || (state.current?.id === key ? state.current : null);
  if (isLeftoverSettledConfirmIntent(currentProject) && /\/workshop-chat\/save$/.test(path))
    settleSavedPlanDerivation(currentProject);
  if (isWorkshopSaveInFlight(currentProject) && /\/workshop-chat\/save$/.test(path))
    throw new Error("正在把回答写回并重新审稿\u3002请等待完成\uFF0C不要重复提交\u3002");
  if (safety.busy.has(key))
    throw new Error("这个项目已有请求进行中\uFF0C请等待完成\uFF0C避免重复提交\u3002");
  if (safety.pending[key] && !safety.busy.has(key)) {
    const leftover = safety.pending[key];
    const samePath = pendingPathOf(leftover).split("?")[0] === String(path || "").split("?")[0];
    if (!samePath && (isStalePendingForCurrentStage(currentProject, leftover) || !isLongMutation(leftover.path)))
      settleUnresolvedPending(key);
  }
  if (safety.pending[key]) {
    scheduleRender();
    throw new Error("上一请求结果尚未确认\uFF0C请先重新查询\uFF0C或明确选择确认重试\u3002");
  }
  assertMutationAllowed(path, body);
  const baseline = state.projects.find(p => p.id === key);
  const pending = {
    path,
    options: {
      method: options.method || "POST",
      ...options.body ? { body: options.body } : {}
    },
    before: baseline ? structuredClone(baseline) : null,
    knownIds: state.projects.map(p => p.id),
    started: Date.now()
  };
  safety.busyTokens = safety.busyTokens || {};
  const busyToken = bumpBusyToken(key);
  pending.busyToken = busyToken;
  safety.pending[key] = pending;
  safety.writeEpoch++;
  safety.busy.add(key);
  saveSafety();
  scheduleRender();
  try {
    const payload = await fetchJson(path, options);
    if (!payload.project && key !== "create") {
      const detail = await fetchJson(`/api/v1/projects/${ encodeURIComponent(key) }`);
      if (!detail.project?.id)
        throw new Error("无法确认服务器项目状态\u3002请重新查询\u3002");
      payload.project = detail.project;
    }
    if (key === "create" && !payload.project?.id)
      throw new Error("创建结果不完整\u3002请先查询项目列表\u3002");
    if (safety.pending[key] === pending)
      delete safety.pending[key];
    clearSubmittedFields(path, body, key);
    safety.lastError = "";
    saveSafety();
    return payload;
  } catch (error) {
    const alreadySettled = !safety.pending[key] || safety.pending[key] !== pending;
    if (alreadySettled) {
      const recovered = key === "create" || path.endsWith("/iterations") ? state.projects.find(item => !pending.knownIds.includes(item.id) && (key === "create" ? item.idea === body.idea : item.parent_id === key && item.change_request === body.change_request)) : state.projects.find(item => item.id === key);
      if (recovered)
        return { project: recovered };
    }
    if (error.status >= 400 && error.status < 600) {
      if (safety.pending[key] === pending)
        delete safety.pending[key];
      saveSafety();
    } else {
      try {
        await reconcile(key);
        if (!safety.pending[key]) {
          const recovered = key === "create" || path.endsWith("/iterations") ? state.projects.find(item => !pending.knownIds.includes(item.id) && (key === "create" ? item.idea === body.idea : item.parent_id === key && item.change_request === body.change_request)) : state.projects.find(item => item.id === key);
          if (recovered)
            return { project: recovered };
        }
      } catch (_) {
      }
      if (isLongMutation(path) && safety.pending[key] === pending) {
        pending.aborted = true;
        pending.watching = true;
        saveSafety();
        startPendingResultWatch(key);
        const wait = new Error("正在查询写回是否完成，不会自动重发请求。");
        wait.silent = true;
        wait.aborted = Boolean(isAbortError(error) || pending.aborted);
        throw wait;
      }
      error.message = "连接中断或响应不完整\u3002请求可能已执行\uFF1B已保留输入并先查询服务器\u3002请查看上方恢复提示\uFF0C不会自动重发\u3002";
    }
    throw error;
  } finally {
    if ((safety.busyTokens?.[key] || 0) === busyToken)
      safety.busy.delete(key);
    safety.writeEpoch++;
    scheduleRender();
  }
}

function outcomeSaved(pending, project, projects = []) {
  const path = pending.path, body = JSON.parse(pending.options.body || "{}"), before = pending.before;
  if (path === "/api/v1/projects")
    return projects.filter(p => !pending.knownIds.includes(p.id) && p.idea === body.idea).length === 1;
  if (/\/iterations$/.test(path))
    return projects.filter(p => !pending.knownIds.includes(p.id) && p.parent_id === before?.id && p.change_request === body.change_request).length === 1;
  if (!project)
    return false;
  if (/\/(?:workshop-chat|development-chat)$/.test(path)) {
    const messages = path.endsWith("development-chat") ? project.backend?.stage_transcript : body.stage === "answers" ? project.workshop?.answer_transcript : project.workshop?.transcript;
    return Array.isArray(messages) && messages.length > body.messages.length && body.messages.every((m, i) => messages[i]?.role === m.role && messages[i]?.text === m.text);
  }
  if (/\/confirm-intent$/.test(path))
    return body.confirmed ? project.confirmations?.intent === true || project.status === "needs_plan_confirmation" && hasDerivedPlanEvidence(project) : project.status === "needs_discovery";
  if (/\/confirm-plan$/.test(path))
    return body.confirmed ? project.confirmations?.plan === true : Boolean(project.plan_revision);
  if (/\/build$/.test(path))
    return project.backend?.status === "awaiting_external_coding" || project.backend?.stage_confirmed && project.backend?.status !== before?.backend?.status;
  if (/\/development\/verify$/.test(path))
    return [
      "kit_self_check_passed",
      "kit_self_check_failed"
    ].includes(project.backend?.status) && JSON.stringify(project.backend) !== JSON.stringify(before?.backend);
  if (/\/development\/accept$/.test(path))
    return project.backend?.kit_stage !== before?.backend?.kit_stage || project.status === "backend_verified";
  if (/\/workshop-resume$/.test(path))
    return Boolean(project.workshop?.transcript?.length);
  if (/\/workshop-chat\/save$/.test(path))
    return workshopSaveCompleted(pending, project);
  if (/\/preview\/verify$/.test(path))
    return project.preview?.status === "verified";
  if (/\/acceptance$/.test(path))
    return [
      "preview_ready",
      "trial"
    ].includes(project.status);
  if (/\/trial$/.test(path))
    return project.status === "trial";
  if (/\/trial-feedback$/.test(path))
    return project.trial?.feedback?.length > (before?.trial?.feedback?.length || 0) && project.trial.feedback.includes(body.feedback);
  return false;
}
async function reconcile(key) {
  const pending = safety.pending[key];
  if (!pending)
    return;
  const token = safety.selection;
  let project = null, projects = [];
  if (key === "create" || pending.path.endsWith("/iterations")) {
    const payload = await fetchJson("/api/v1/projects");
    projects = payload.projects || [];
    projects.forEach(p => replaceProject(p));
  }
  if (key !== "create") {
    const payload = await fetchJson(`/api/v1/projects/${ encodeURIComponent(key) }`);
    project = payload.project;
    if (project)
      replaceProject(project);
    if (pending.path.includes("/development") || pending.path.endsWith("/build")) {
      const result = await fetchJson(`/api/v1/projects/${ encodeURIComponent(key) }/development`);
      safety.development[key] = result.development || {};
      if (result.project) {
        project = result.project;
        replaceProject(project);
      }
    }
  }
  if (outcomeSaved(pending, project, projects) || isPlanDerivationPath(pending.path) && planDerivationAlreadySaved(pending, project)) {
    delete safety.pending[key];
    stopPendingResultWatch(key);
    const body = JSON.parse(pending.options.body || "{}");
    clearSubmittedFields(pending.path, body, key);
    bumpBusyToken(key);
    safety.busy.delete(key);
    if (state.planProgress?.projectId === key)
      state.planProgress.active = false;
    if (pending.path.endsWith("/iterations") || key === "create") {
      const found = projects.find(p => !pending.knownIds.includes(p.id) && (key === "create" ? p.idea === body.idea : p.parent_id === key && p.change_request === body.change_request));
      if (found && token === safety.selection)
        replaceProject(found, true);
    }
    if (!pending.watching)
      safety.lastError = "已查询到服务器保存结果\uFF0C没有重发请求\u3002请检查最新阶段\u3002";
    else
      safety.lastError = "";
  } else if (project && isStalePendingForCurrentStage(project, pending)) {
    settleUnresolvedPending(key);
    safety.lastError = "";
  } else
    pending.checked = true;
  saveSafety();
}
function scheduleRender() {
  if (safety.renderScheduled)
    return;
  safety.renderScheduled = true;
  queueMicrotask(() => {
    safety.renderScheduled = false;
    render();
  });
}
function renderRecovery() {
  const host = $("#recoveryPanel");
  if (!host)
    return;
  if (state.current)
    settleSavedPlanDerivation(state.current);
  if (state.current && isStalePendingForCurrentStage(state.current, safety.pending[state.current.id]))
    settleUnresolvedPending(state.current.id);
  const key = state.creating || !state.current ? "create" : state.current.id, pending = safety.pending[key];
  if (!pending || isLeftoverSettledConfirmIntent(state.current)) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  // 请求恢复状态属于当前任务的辅助信息，不再在主画布里生成一张独立大卡片。
  // 当前阶段和等待原因由 stageSummary 展示，避免遮住需求对话或方案内容。
  if (safety.busy.has(key) || pending.watching || pending.aborted) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (safety.busy.has(key)) {
    if (pending && pending.started == null)
      pending.started = Date.now();
    const derivation = isPlanDerivationPath(pending?.path);
    const waited = Date.now() - Number(pending?.started || Date.now());
    const showQuery = derivation && waited >= 4000;
    if (derivation && !showQuery) {
      window.clearTimeout(safety.busyQueryTimer);
      safety.busyQueryTimer = window.setTimeout(() => {
        safety.busyQueryTimer = 0;
        if (safety.busy.has(key))
          renderRecovery();
      }, Math.max(50, 4000 - waited));
    }
    const saving = isWorkshopSaveInFlight(state.current);
    const query = showQuery && !saving ? `<div class="panel-actions"><button id="queryPlanProgressButton" class="secondary-button" type="button">重新查询当前进度</button></div>` : "";
    host.innerHTML = saving ? `<strong>正在写回并重新审稿</strong><p>这次请求只发送一次，不会自动重发。请等待写回和重新评分完成。</p>` : `<strong>正在等待本地后端</strong><p>请求仅发送一次。你可以离开此页，未提交输入仍会保留。${ showQuery ? "查询只会读取当前进度和项目详情，不会自动重发请求。" : "" }</p>${ query }`;
    $("#queryPlanProgressButton")?.addEventListener("click", () => queryPlanProgress(state.current));
    return;
  }
  const watchingWriteback = isWorkshopSavePending(state.current) || isLongMutation(pending.path) && (pending.watching || pending.aborted);
  if (watchingWriteback && !canRetryUnresolvedMutation(pending)) {
    host.innerHTML = "";
    host.hidden = true;
    return;
  }
  const allowRetry = canRetryUnresolvedMutation(pending);
  const writeback = isLongMutation(pending.path);
  host.innerHTML = `<strong>${ writeback ? "仍未查询到这次写回结果" : "上一次提交的结果待确认" }</strong><p>${ writeback ? "自动查询还没有看到写回完成。可以继续等待自动查询；只有确认服务器没有这次写回或已经明确失败时，才可以重试。重试可能造成重复，不会自动重发。" : pending.checked ? "已重新查询\uFF0C尚不能确认这次操作是否完成\u3002请先查看最新对话和真实阶段\uFF1B重试可能造成重复\u3002" : "请求可能已在服务器执行\u3002先重新查询\uFF0C不会自动重发\u3002" }</p><div class="panel-actions"><button id="queryPending" class="secondary-button">重新查询</button><button id="retryPending" class="text-button" ${ allowRetry ? "" : "disabled" }>确认重试这次操作</button></div>`;
  $("#queryPending").onclick = async () => {
    try {
      await reconcile(key);
      render();
    } catch (_) {
      showError("查询失败\uFF0C原请求与输入继续保留\u3002请确认本地服务可达\u3002");
    }
  };
  $("#retryPending").onclick = async () => {
    if (!window.confirm("服务器可能已经执行此操作\u3002你已检查最新状态\uFF0C仍确认重试原请求吗\uFF1F"))
      return;
    const operation = safety.pending[key];
    delete safety.pending[key];
    saveSafety();
    try {
      const token = safety.selection;
      const payload = await api(operation.path, operation.options);
      if (payload.project)
        replaceProject(payload.project, token === safety.selection && (key === "create" || operation.path.endsWith("/iterations")));
      safety.lastError = "重试已返回\uFF0C请核对服务器最新状态\u3002";
    } catch (error) {
      safety.lastError = error.message;
    }
    render();
  };
}
function renderStageMeter(project) {
  const labels = ["想法", "需求澄清", "需求确认", "方案确认", "后端开发", "后端验收", "产品预览", "试用反馈"];
  const index = project ? Math.max(0, Math.min(labels.length - 1, phaseForStatus(statusOf(project), project))) : 0;
  const percent = labels.length > 1 ? Math.round(index / (labels.length - 1) * 100) : 0;
  return `<div class="stage-meter" role="progressbar" aria-label="产品流程进度" aria-valuemin="1" aria-valuemax="${labels.length}" aria-valuenow="${index + 1}"><div class="stage-meter-fill" style="width:${percent}%"></div></div><div class="stage-meter-meta"><span>第 ${index + 1} / ${labels.length} 阶段</span><strong>${escapeHtml(labels[index])}</strong></div>`;
}
function stageSummary(project) {
  if (!project)
    return {
      current: "01 / 想法",
      next: "用一句话描述你想做的产品",
      block: modelGate().allowed ? "从真实后端创建项目\uFF0C不生成演示数据\u3002" : modelGate().reason
    };
  const backend = projectBackend(project), status = project.status;
  if (!safety.serverIds.has(project.id))
    return safety.serverIds.size
      ? {
          current: "缓存快照 · 只读",
          next: "从左侧打开服务器上的项目",
          block: "已查询过本地后端，服务器上没有这个缓存快照。缓存仍保留，只读，不会用它推进阶段。"
        }
      : {
          current: "缓存快照 · 只读",
          next: "重新查询本地后端",
          block: "尚未从服务器恢复，缓存不能推进阶段或覆盖服务器数据。"
        };
  if (isHistorical(project))
    return {
      current: `历史版本 V${ project.version } · 只读`,
      next: "查看或下载\uFF1B选择最新版本继续",
      block: "历史版本保留原始项目关系\uFF0C不改写已确认的旧版本\u3002"
    };
  const pending = safety.pending[project.id];
  const planReadyFromServer = status === "needs_plan_confirmation" && hasDerivedPlanEvidence(project);
  if (pending && !planReadyFromServer) {
    const path = pendingPathOf(pending);
    const waiting = safety.busy.has(project.id) ? "正在处理" : "正在查询结果";
    if (/\/(confirm-intent|workshop-chat\/save|real-plan)$/.test(path))
      return { current: "03 / 方案推导", next: waiting, block: "系统正在整理 PRD、推导方案并完成独立审稿；本次请求只发送一次。" };
    if (/\/workshop-resume$|\/workshop-chat$/.test(path))
      return { current: "02 / 需求澄清", next: waiting, block: "系统正在处理当前轮次，回复回来后继续当前对话。" };
    if (/\/development-chat$/.test(path))
      return { current: "05 / 开发阶段确认", next: waiting, block: "系统正在处理当前产品决定，不会自动开始开发。" };
  }
  if (status === "needs_discovery")
    return {
      current: "02 / 需求澄清",
      next: project.workshop ? "继续需求对话" : "点击开始，澄清需求",
      block: "问题由系统根据上下文动态追问\uFF1B可自定义回答或跳过\u3002"
    };
  if (shouldShowPlanProgress(project))
    return {
      current: status === "needs_plan_confirmation" ? "03 / 正在重新推导方案" : "03 / 正在推导方案",
      next: "完成后会进入方案确认",
      block: "正在根据已确认的需求推导方案，完成后会进入方案确认；可以离开此页，未提交输入会保留。"
    };
  if (status === "needs_intent_confirmation")
    return {
      current: "03 / 需求稿",
      next: "编辑并明确确认需求稿",
      block: "工具提出的草稿不等于你的确认\u3002"
    };
  if (status === "needs_plan_confirmation") {
    const revising = needsExistingDecisionRevision(project);
    const reviewFollowUp = list(project.workshop?.answer_questions).some(item => String(item || "").startsWith("审稿追问"));
    const ready = canConfirmPlan(project);
    return {
      current: "04 / 方案与独立审稿",
      next: ready ? "确认方案\uFF0C交接开发准备" : revising ? "按已有答复重新审稿" : reviewFollowUp ? "继续回答审稿缺口" : "继续回答待确认问题",
      block: ready ? "审稿和待确认项全部满足，确认后交接进入后端开发。" : revising ? "已有回答会直接用于修订方案并重新审稿。" : reviewFollowUp ? "只回答这次独立审稿指出的新问题，之前的回答会保留。" : primaryPlanBlocker(project)
    };
  }
  if (status === "backend_building") {
    const waiting = backend.status === "awaiting_external_coding" || safety.development[project.id]?.run_status === "external_tool_required";
    return {
      current: `05 / ${ backend.kit_stage || "开发准备" }`,
      next: waiting ? "由外部编码工具执行本阶段任务" : backend.status === "kit_self_check_passed" ? backend.stage_accepted ? "由你明确确认阶段验收通过" : "完成自然语言验收" : "按当前阶段完成对话\u3001开发或自检",
      block: waiting ? "正在等待外部编码\uFF0C不代表 AI 已完成开发\u3002编码完成后才运行阶段自检\u3002" : "自然语言确认 \u2192 开始开发 \u2192 外部编码 \u2192 自检 \u2192 自然语言验收 \u2192 你的明确验收 \u2192 下一阶段"
    };
  }
  if (status === "backend_verified")
    return {
      current: "06 / 交付验收",
      next: "由你核对交付并确认验收",
      block: "阶段通过不代表产品预览已验证\u3002"
    };
  if (status === "preview_ready")
    return {
      current: "07 / 产品预览",
      next: isPreviewVerified(project) ? "开始试用" : "验证页面\u3001健康检查与核心动作",
      block: isPreviewVerified(project) ? "后端已记录预览验证\u3002" : "未验证预览不能进入试用\u3002"
    };
  return {
    current: "08 / 试用与反馈",
    next: hasTrialFeedback(project) ? "保留反馈\uFF0C创建独立 V2" : "记录一次非空的真实试用反馈",
    block: "新版会得到新的项目身份。下一版不自动继承上一版代码；身份、父子关系和版本号全部由后端返回。"
  };
}
function scrollActiveConversation(toEnd, previousScroll = 0) {
  const panel = document.querySelector(".panel:not(.hidden)");
  if (!panel)
    return;
  if (toEnd) {
    const anchor = panel.querySelector(".teacher-current-question, .teacher-choice-context, .teacher-chat-message.is-current, .review-gap-card");
    if (anchor) {
      window.requestAnimationFrame(() => anchor.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }));
      return;
    }
  }
  const thread = panel.querySelector(".teacher-chat-thread");
  const scroller = panel.querySelector(":scope > .task-scroll") || thread;
  if (!scroller)
    return;
  if (toEnd)
    scroller.scrollTop = scroller.scrollHeight;
  else
    scroller.scrollTop = previousScroll;
}
function render() {
  const previousScroller = document.querySelector(".panel:not(.hidden) > .task-scroll") || document.querySelector(".panel:not(.hidden) .teacher-chat-thread");
  const previousScroll = previousScroller?.scrollTop || 0;
  const wasAtEnd = !previousScroller || previousScroller.scrollHeight - previousScroller.scrollTop - previousScroller.clientHeight < 70;
  const current = state.current;
  if (current)
    settleSavedPlanDerivation(current);
  if (current)
    ensurePendingResultWatch(current);
  const canonical = current && safety.authoritativeProjects.get(current.id);
  if (current && canonical?.workshop?.transcript?.length && !current.workshop?.transcript?.length) current.workshop = structuredClone(canonical.workshop);
  if (current?.status === "trial" && hasTrialFeedback(current) && safety.drafts[draftKey(current.id,"newRequirementInput","trial")]) current.new_requirement_draft = true;
  renderBase();
  restoreInputs();
  renderRecovery();
  const project = state.creating ? null : state.current, info = stageSummary(project);
  const host = $("#stageSummary");
  if (host) {
    if (project && safety.serverIds.has(project.id) && safety.serverRecoveryNotice)
      safety.serverRecoveryNotice = "";
    const cacheOnly = Boolean(project && !safety.serverIds.has(project.id));
    const serverKnown = safety.serverIds.size > 0;
    const notice = safety.serverRecoveryNotice ? `<p class="workflow-scope">${escapeHtml(safety.serverRecoveryNotice)}</p>` : "";
    let actionHtml = "";
    if (cacheOnly && serverKnown)
      actionHtml = `<div class="panel-actions stage-requery"><button class="primary-button" id="openServerProjectsButton" type="button" data-primary-action="true">查看服务器项目列表</button></div>`;
    else if (cacheOnly)
      actionHtml = `<div class="panel-actions stage-requery"><button class="primary-button" id="requeryBackendButton" type="button" data-primary-action="true">重新查询本地后端</button></div>`;
    else if (project && project.status === "needs_plan_confirmation") {
      actionHtml = `<div class="stage-summary-action"><strong>${escapeHtml(info.next)}</strong><button class="primary-button" id="stagePlanAction" type="button"><span>${escapeHtml(info.next)}</span><span class="button-arrow">↗</span></button></div>`;
    } else
      actionHtml = `<strong>${escapeHtml(info.next)}</strong>`;
    host.innerHTML = `<span class="section-kicker">${escapeHtml(info.current)}</span>${renderStageMeter(project)}${actionHtml}${notice}<p>${escapeHtml(info.block)}</p>`;
    host.querySelector("#requeryBackendButton")?.addEventListener("click", async () => {
      const button = host.querySelector("#requeryBackendButton");
      setActionBusy(button, "正在查询");
      clearError();
      try {
        await refreshServerState();
      } finally {
        restoreAction(button);
      }
    });
    host.querySelector("#openServerProjectsButton")?.addEventListener("click", () => {
      state.current = null;
      state.creating = false;
      safety.selection++;
      render();
    });
    host.querySelector("#stagePlanAction")?.addEventListener("click", () => {
      if (canConfirmPlan(project))
        return confirmPlan(project, true);
      safety.planOverview = safety.planOverview || {};
      safety.planOverview[project.id] = false;
      render();
    });
  }
  const mode = $(".mode-pill");
  if (mode)
    mode.textContent = modelGate().label;
  const readOnly = project && (isHistorical(project) || !safety.serverIds.has(project.id));
  const key = project?.id || "create";
  const leftoverDerivationLock = isLeftoverSettledConfirmIntent(project);
  const locked = (safety.busy.has(key) || Boolean(safety.pending[key])) && !leftoverDerivationLock;
  const panels = [
    "#questionPanel",
    "#planPanel",
    "#previewPanel"
  ];
  for (const selector of panels) {
    const panel = $(selector);
    if (!panel || panel.classList.contains("hidden"))
      continue;
    if (readOnly || locked)
      panel.querySelectorAll("button,textarea,input,select").forEach(node => {
        if (!/refresh|backTo|openPlanResult|requeryBackend|queryPlanProgress|retryPlanDerivation/i.test(node.id)) {
          node.disabled = true;
          if (readOnly && project && !safety.serverIds.has(project.id))
            node.title = safety.serverIds.size ? "这是本地缓存快照，请打开服务器上的项目继续" : "请先重新查询本地后端";
        }
      });
    const action = [...panel.querySelectorAll(".primary-button:not(:disabled)")].filter(node => node.id !== "teacherChatSend");
    if (action.length && $("#teacherChatSend")) {
      $("#teacherChatSend").classList.remove("primary-button");
      $("#teacherChatSend").classList.add("secondary-button");
    }
    panel.querySelectorAll(".teacher-chat-thread").forEach(node => node.setAttribute("aria-live", "polite"));
  }
  if (safety.lastError) {
    const panel = $("#errorPanel");
    panel.textContent = safety.lastError;
    panel.classList.remove("hidden");
  }
  if (project?.backend?.kit_task) {
    const target = $("#previewPanel .panel-copy");
    if (project.backend.status === "awaiting_external_coding" && target)
      target.insertAdjacentHTML("afterend", `<details class="delivery-details"><summary>本阶段外部编码任务与交接包</summary><p class="stage-task-copy">${ escapeHtml(project.backend.kit_task) }</p><a class="secondary-button" href="/api/v1/projects/${ encodeURIComponent(project.id) }/handoff">下载交接包</a></details>`);
  }
  if (project && ["backend_verified","preview_ready","trial"].includes(project.status)) {
    const panel = $("#previewPanel");
    const meta = safety.previews[project.id] || project.preview || {};
    const url = safeRuntimeUrl(meta.url), health = safeRuntimeUrl(meta.health_url), action = safeRuntimeUrl(meta.action_url);
    const checks = list(meta.checks, []).map(check => `<li><strong>${escapeHtml(check.label || check.id || "运行检查")}</strong> · ${escapeHtml(check.status || "未返回")}<br>${escapeHtml(check.detail || "")}</li>`).join("");
    panel.insertAdjacentHTML("beforeend", `<details class="delivery-details"><summary>本版本交付与预览详情</summary><p>预览状态：${escapeHtml(meta.status || "尚未验证")}</p>${checks ? `<ul>${checks}</ul>` : "<p>后端尚未返回运行检查记录。</p>"}<div class="panel-actions"><a class="secondary-button" href="/api/v1/projects/${encodeURIComponent(project.id)}/handoff">下载本版本交接包</a>${url ? `<a class="secondary-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">打开预览</a>` : ""}${health ? `<a class="text-button" href="${escapeHtml(health)}" target="_blank" rel="noopener noreferrer">查看健康状态</a>` : ""}</div>${action ? `<p>核心动作验证地址：<code>${escapeHtml(action)}</code>（由运行时执行）</p>` : ""}${readOnly ? `<h4>本版本需求稿</h4><p class="stage-task-copy">${escapeHtml(project.workshop?.draft || "此版本未返回需求稿")}</p><h4>本版本方案</h4><p>${escapeHtml(project.plan?.summary || "此版本未返回方案")}</p>` : ""}</details>`);
  }

  layoutActiveTask(project);
  const stickToEnd = Boolean(state.scrollConversationToEnd) || wasAtEnd;
  state.scrollConversationToEnd = false;
  scrollActiveConversation(stickToEnd, previousScroll);
}
function layoutActiveTask(project) {
  const editor = document.querySelector(".editor-sheet");
  editor?.classList.remove("is-compact-task");
  if (!project) return;
  for (const hidden of document.querySelectorAll(".panel.hidden"))
    hidden.querySelector(":scope > .task-controls")?.remove();
  const panel = document.querySelector(".panel:not(.hidden)");
  if (!panel || panel.querySelector(":scope > .task-scroll")) return;
  if (panel.dataset.taskLayout === "compact") {
    editor?.classList.add("is-compact-task");
    const primary = panel.querySelector(".primary-button:not(:disabled)");
    if (primary) primary.dataset.primaryAction = "true";
    return;
  }
  const scroll = document.createElement("div"), controls = document.createElement("div");
  scroll.className = "task-scroll"; controls.className = "task-controls";
  controls.setAttribute("aria-label", "当前阶段操作");
  const dock = panel.querySelector(".teacher-chat-dock");
  if (dock) controls.appendChild(dock);
  else {
    for (const node of [...panel.querySelectorAll(".teacher-choice-grid, .teacher-suggestions, .teacher-utility-actions")]) {
      if (!controls.contains(node) && !node.closest(".teacher-chat-dock"))
        controls.appendChild(node);
    }
    const composer = panel.querySelector(".teacher-chat-composer");
    if (composer) controls.appendChild(composer);
  }
  const choice = panel.querySelector(".stage-choice");
  if (choice) controls.appendChild(choice);
  for (const next of [...panel.querySelectorAll(".plan-progress-next, .plan-next-step")])
    controls.appendChild(next);
  for (const actions of [...panel.children].filter(node => node.classList.contains("panel-actions"))) controls.appendChild(actions);
  for (const button of panel.querySelectorAll(".teacher-chat-draft > button"))
    controls.appendChild(button);
  // Nested feedback / iteration forms keep their fields in the scroll region, not their CTA.
  for (const button of panel.querySelectorAll(".primary-button")) {
    if (!controls.contains(button))
      controls.appendChild(button);
  }
  while (panel.firstChild) scroll.appendChild(panel.firstChild);
  panel.appendChild(scroll);
  if (controls.children.length) panel.appendChild(controls);
  const primary = controls.querySelector(".primary-button:not(:disabled)");
  if (primary) primary.dataset.primaryAction = "true";
}
function initializeClient() {
  document.addEventListener("input", event => rememberInput(event.target));
  document.addEventListener("change", event => rememberInput(event.target));
  try {
    loadSaved();
  } catch (_) {
    render();
  }
  Promise.all([
    loadModelStatus(),
    loadProjects()
  ]).then(async () => {
    for (const key of Object.keys(safety.pending)) {
      try {
        await reconcile(key);
      } catch (_) {
      }
    }
    for (const key of Object.keys(safety.pending)) {
      if (isLongMutation(safety.pending[key]?.path) && !safety.busy.has(key))
        startPendingResultWatch(key);
    }
    render();
  });
}
