const state = { projects: [], current: null, model: null, modelUnavailable: false, creating: false, helpOpen: false, inflightChats: new Set() };
const online = Boolean(window.__ONLINE_PREVIEW__);
const offlineDemo = new URLSearchParams(window.location.search).get("mode") === "offline-demo";
const $ = (selector) => document.querySelector(selector);

const modePill = document.querySelector(".mode-pill");
if (modePill) modePill.innerHTML = `<span class="status-dot"></span>${offlineDemo ? "离线示例 · mock" : online ? "浏览器 mock · localStorage" : "本地 API · JSON 可恢复"}`;
const footerMode = document.querySelector("footer span");
if (footerMode) footerMode.textContent = offlineDemo ? "AI 产品工作台 · 离线示例" : online ? "AI 产品工作台 · 浏览器 mock" : "AI 产品工作台 · 本地 API";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function showError(message) { const panel = $("#errorPanel"); panel.textContent = message; panel.classList.remove("hidden"); }
function clearError() { $("#errorPanel").classList.add("hidden"); }
function statusOf(project) { return project?.status || ""; }
const KNOWN_STATUSES = ["idea", "needs_discovery", "needs_intent_confirmation", "needs_plan_confirmation", "backend_building", "backend_verified", "preview_ready", "trial"];
function isKnownStatus(status) { return KNOWN_STATUSES.includes(status); }
function isUnknownProject(project) { return Boolean(project) && !isKnownStatus(statusOf(project)); }
function isPreviewVerified(project) { return project?.preview?.status === "verified"; }
function isMockExampleViewed(project) { return project?.preview?.kind === "mock" && project?.preview?.status === "example_viewed"; }
function markMockExampleViewed(project) {
  if (!project) return project;
  project.preview = { kind: "mock", status: "example_viewed", viewed_at: now() };
  return project;
}
function hasTrialFeedback(project) { return Array.isArray(project?.trial?.feedback) && project.trial.feedback.some((item) => String(item || "").trim()); }
function isPlanRevising(project) { return project?.plan_revision?.status === "needs_input"; }
function pickModelStatus(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  return {
    configured: Boolean(src.configured),
    required: Boolean(src.required),
    teacher_workflow: Boolean(src.teacher_workflow),
    can_build: Boolean(src.can_build),
    provider: src.provider || "",
    model: src.model || "",
    base_url: src.base_url || "",
    key_masked: src.key_masked || "",
    providers: Array.isArray(src.providers) ? src.providers : [],
  };
}
function canStartTrial(project) {
  if (!project || statusOf(project) !== "preview_ready") return false;
  if (online) return isMockExampleViewed(project);
  return isPreviewVerified(project);
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
  const exampleViewed = isMockExampleViewed(project);
  if (online) {
    return {
      mode: "mock",
      previewReady,
      runtimeReady: false,
      exampleViewed,
      canTrial: canStartTrial(project),
      title: !previewReady ? "" : (exampleViewed ? "示例已查看，可以开始试用" : "查看产品示例"),
      chip: exampleViewed ? "示例已查看" : "产品示例 · mock",
      chipKind: exampleViewed ? "example-viewed" : "example-pending",
      openLabel: exampleViewed ? "再次查看示例" : "查看示例",
      startEnabled: canStartTrial(project),
      startDisabledReason: "请先查看示例",
      previewLabel: "产品示例 · mock",
      previewState: exampleViewed ? "示例已查看" : "示例已准备",
      copy: "这里展示产品示例，用来查看流程和界面。这不是真实运行时预览，也不会做健康检查或核心动作验证。"
    };
  }
  return {
    mode: "api",
    previewReady,
    runtimeReady,
    exampleViewed: false,
    canTrial: canStartTrial(project),
    title: !previewReady ? "" : (runtimeReady ? "可运行预览已验证" : "先验证可运行预览"),
    chip: runtimeReady ? "预览已验证" : "预览待验证",
    chipKind: runtimeReady ? "preview-verified" : "preview-pending",
    openLabel: runtimeReady ? "打开可运行预览" : "验证并打开预览",
    startEnabled: canStartTrial(project),
    startDisabledReason: "先验证可运行预览",
    previewLabel: runtimeReady ? "本地可运行预览" : "运行时预览待验证",
    previewState: runtimeReady ? "运行检查通过" : "等待运行检查",
    copy: "这里展示 API、数据模型、测试和运行时结果。只有实际打开并完成规定检查的成果，才会标记为可运行。验收通过只代表进入产品预览，不代表预览已经验证。"
  };
}
function statusLabel(status, project) {
  if (!isKnownStatus(status)) return "无法识别";
  if (status === "preview_ready") {
    if (online) return isMockExampleViewed(project) ? "示例已查看" : "示例待查看";
    return isPreviewVerified(project) ? "预览已验证" : "预览待验证";
  }
  if (status === "trial") {
    if (!hasTrialFeedback(project)) return "试用与反馈";
    const outcome = project?.trial?.outcome;
    if (outcome === "needs_change" || outcome === "blocked") return "需要修改";
    return "试用反馈已记录";
  }
  if (status === "needs_plan_confirmation" && isPlanRevising(project)) return "需要修改";
  return {
    idea: "想法", needs_discovery: "需求发现",
    needs_intent_confirmation: "需求确认", needs_plan_confirmation: "方案确认",
    backend_building: "后端开发中", backend_verified: "等你验收"
  }[status] || "无法识别";
}
function sourceLabel(project) { return project?.tasks?.some((task) => task.kind === "generate_plan_real" && task.status === "succeeded") ? "真实模型方案" : "本地结构化方案 · mock"; }
function phaseForStatus(status, project) {
  if (status === "idea") return 0;
  if (!isKnownStatus(status)) return -1;
  if (status === "needs_discovery") return 1;
  if (status === "needs_intent_confirmation") return 2;
  if (status === "needs_plan_confirmation") return 3;
  if (status === "backend_building") return 4;
  if (status === "backend_verified") return 5;
  if (status === "preview_ready") return 6;
  if (status === "trial") return 7;
  return -1;
}
function resultKind(status, project) {
  if (!project) return "progress";
  if (!isKnownStatus(status)) return "unknown";
  if (status === "needs_plan_confirmation" && isPlanRevising(project)) return "revise";
  if (status === "idea" || status === "needs_discovery" || status === "backend_building") return "progress";
  if (status === "needs_intent_confirmation" || status === "needs_plan_confirmation" || status === "backend_verified") return "confirm";
  if (status === "preview_ready") {
    if (online) return isMockExampleViewed(project) ? "example-viewed" : "example-pending";
    return isPreviewVerified(project) ? "preview-verified" : "preview-pending";
  }
  if (status === "trial") {
    const outcome = project?.trial?.outcome;
    if (hasTrialFeedback(project) && (outcome === "needs_change" || outcome === "blocked")) return "revise";
    if (hasTrialFeedback(project)) return "done";
    return "confirm";
  }
  return "progress";
}
function applyChipClass(el, kind) {
  if (!el) return;
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
  if (!project) return "想法";
  const version = versionLabel(project);
  if (!isKnownStatus(status)) return `无法识别${version}`;
  if (status === "preview_ready") return `${statusLabel(status, project)}${version}`;
  if (status === "trial") {
    if (!hasTrialFeedback(project)) return `试用与反馈${version}`;
    if (resultKind(status, project) === "revise") return `需要修改${version}`;
    return `试用反馈已记录${version}`;
  }
  if (status === "needs_plan_confirmation" && isPlanRevising(project)) return `需要修改${version}`;
  if (status === "backend_building") return `后端开发中${version}`;
  if (status === "backend_verified") return `等你验收${version}`;
  if (status === "needs_intent_confirmation" || status === "needs_plan_confirmation") return `等你确认${version}`;
  const labels = ["想法", "需求发现", "需求确认", "方案确认", "后端开发", "后端验收", "产品预览", "试用与反馈"];
  return `${labels[phaseForStatus(status, project)] || statusLabel(status, project)}${version}`;
}
function taskCopy(project, creating) {
  if (creating) {
    return {
      kicker: "新建项目",
      title: "再写一个新想法",
      decision: "用一句话写下要做的产品。当前任务还在，可以随时返回。",
      next: "返回后继续当前任务，或开始一个新项目"
    };
  }
  if (!project) {
    return {
      kicker: "新的可能，从这里开始",
      title: "把一个想法，\n做成第一版。",
      decision: "从你想解决的一个小问题开始。",
      next: "完成后进入：需求发现"
    };
  }
  const status = statusOf(project);
  const title = project.idea || "未命名项目";
  const kicker = project.version > 1 ? `当前任务 · V${project.version}` : "当前任务";
  if (isUnknownProject(project)) return { kicker, title, decision: "当前状态无法识别，请重新加载或返回列表", next: "不会进入后端验收或试用" };
  if (status === "needs_discovery") return { kicker, title, decision: "回答会改变方向的问题", next: "完成后进入：系统判断是否还需追问，或进入需求确认" };
  if (status === "needs_intent_confirmation") return { kicker, title, decision: "确认用户、问题和范围是否准确", next: "完成后进入：方案确认" };
  if (status === "needs_plan_confirmation" && isPlanRevising(project)) return { kicker, title, decision: "说明方案要改哪一处", next: "完成后进入：仍在方案确认" };
  if (status === "needs_plan_confirmation") return { kicker, title, decision: "确认这份方案能否作为开发输入", next: "完成后进入：后端开发" };
  if (status === "backend_building") return { kicker, title, decision: "等待或刷新开发状态", next: "完成后进入：后端验收" };
  if (status === "backend_verified") return { kicker, title, decision: "验收这次后端交付", next: "完成后进入：产品预览（待验证）" };
  if (status === "preview_ready" && online) {
    if (!isMockExampleViewed(project)) return { kicker, title, decision: "查看这份产品示例。这不是真实运行时验证。", next: "查看示例后可以开始试用" };
    return { kicker, title, decision: "开始试用并准备记录结果", next: "完成后进入：试用与反馈" };
  }
  if (status === "preview_ready" && !isPreviewVerified(project)) return { kicker, title, decision: "先完成页面、健康检查和核心动作验证", next: "完成后进入：预览已验证后可开始试用" };
  if (status === "preview_ready") return { kicker, title, decision: "开始试用并准备记录结果", next: "完成后进入：试用与反馈" };
  if (status === "trial" && !hasTrialFeedback(project)) return { kicker, title, decision: "记录一次试用结果和文字反馈", next: "完成后进入：反馈写入后才能加新需求" };
  if (status === "trial") return { kicker, title, decision: "决定是否开启下一版", next: "完成后进入：新版本的需求发现（不覆盖旧版）" };
  return { kicker, title, decision: "继续当前任务", next: "" };
}
function setFlow(step, project) {
  const status = project ? statusOf(project) : "idea";
  const kind = resultKind(status, project);
  [...document.querySelectorAll(".flow-item")].forEach((item, index) => {
    item.classList.toggle("active", index === step);
    item.classList.toggle("done", index < step);
    item.classList.remove("revise", "preview-pending", "preview-verified", "is-confirm");
    const stateEl = item.querySelector(".flow-state");
    if (!stateEl) return;
    if (step < 0) { stateEl.textContent = "无法识别"; item.classList.remove("active", "done"); return; }
    if (index < step) { stateEl.textContent = "已完成"; return; }
    if (index > step) { stateEl.textContent = "未开始"; return; }
    if (step === 6 && project) {
      if (online) {
        const viewed = isMockExampleViewed(project);
        stateEl.textContent = viewed ? "示例已查看" : "示例待查看";
        item.classList.add(viewed ? "is-confirm" : "preview-pending");
        return;
      }
      const verified = isPreviewVerified(project);
      stateEl.textContent = verified ? "预览已验证" : "预览待验证";
      item.classList.add(verified ? "preview-verified" : "preview-pending");
      return;
    }
    if (step === 7 && project) {
      if (!hasTrialFeedback(project)) { stateEl.textContent = "等你确认"; item.classList.add("is-confirm"); }
      else if (kind === "revise") { stateEl.textContent = "需要修改"; item.classList.add("revise"); }
      else { stateEl.textContent = "已完成"; }
      return;
    }
    if (kind === "revise") { stateEl.textContent = "需要修改"; item.classList.add("revise"); }
    else if (kind === "confirm") { stateEl.textContent = "等你确认"; item.classList.add("is-confirm"); }
    else stateEl.textContent = "进行中";
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
  if (!form || !bar) return;
  form.classList.toggle("hidden", Boolean(project) && !creating);
  bar.classList.toggle("hidden", !project || creating);
  if (intro) intro.classList.toggle("hidden", Boolean(state.current));
  if (cancel) cancel.classList.toggle("hidden", !(creating && state.current));
  const kicker = $("#entryKicker");
  const title = $("#entryTitle");
  if (kicker) kicker.textContent = copy.kicker;
  if (title) {
    title.textContent = copy.title;
    if (project?.idea && !creating) title.title = project.idea;
    else title.removeAttribute("title");
  }
  const decision = $("#taskDecision");
  const next = $("#taskNext");
  if (decision) decision.textContent = copy.decision;
  if (next) next.textContent = copy.next;
  const status = project && !creating ? statusOf(project) : "idea";
  const kind = creating ? "progress" : resultKind(status, project);
  applyChipClass($("#phaseLabel"), kind);
  if ($("#phaseLabel")) $("#phaseLabel").textContent = creating ? "新建项目" : chipText(status, project);
  const summary = bar.querySelector(".current-project-summary");
  if (summary && state.current) {
    const idea = summary.querySelector("strong");
    const meta = summary.querySelector("small");
    if (idea) idea.textContent = state.current.idea || "未命名项目";
    if (meta) meta.textContent = `${statusLabel(statusOf(state.current), state.current)}${versionLabel(state.current)}`;
  }
}
function canStartBuild() { return online || Boolean(state.model?.can_build ?? state.model?.configured); }
function setStartButton(start, { disabled, loading, label }) {
  if (!start) return;
  const span = start.querySelector("span");
  start.disabled = Boolean(disabled);
  start.classList.toggle("is-loading", Boolean(loading));
  if (span) span.textContent = label;
}

function setActionBusy(button, label) {
  if (!button) return;
  const textNode = button.querySelector("span:not(.button-arrow)") || button;
  button.dataset.originalLabel = textNode.textContent;
  button.disabled = true;
  button.classList.add("is-loading");
  textNode.textContent = label;
}

function restoreAction(button) {
  if (!button) return;
  const textNode = button.querySelector("span:not(.button-arrow)") || button;
  if (button.dataset.originalLabel) textNode.textContent = button.dataset.originalLabel;
  button.disabled = false;
  button.classList.remove("is-loading");
}
function renderStartGate() {
  const gate = $("#setupGate");
  const start = $("#startBuildButton");
  if (!gate || !start) return;
  if (online) {
    gate.classList.add("hidden");
    setStartButton(start, { disabled: false, loading: false, label: "开始搭建" });
    return;
  }
  if (!state.model) {
    gate.classList.remove("hidden");
    gate.innerHTML = "<strong>正在检查配置</strong><span>正在读取后端的模型配置状态，不会在浏览器里查看或保存密钥。</span>";
    setStartButton(start, { disabled: true, loading: true, label: "检查配置中" });
    return;
  }
  if (state.modelUnavailable) {
    gate.classList.remove("hidden");
    gate.innerHTML = '<strong>无法连接本地 API</strong><span>请先启动 backend/start.sh，再重新检查配置。API Key 状态暂时无法读取。未确认配置前，不能创建真实项目或开始真实搭建。你可以先打开独立离线示例查看完整流程。</span><div class="setup-actions"><button id="refreshModelButton" class="secondary-button" type="button">重新检查配置</button></div>';
    setStartButton(start, { disabled: true, loading: false, label: "等待本地 API" });
    $("#refreshModelButton")?.addEventListener("click", async () => { await loadModelStatus(); render(); });
    return;
  }
  if (!canStartBuild()) {
    gate.classList.remove("hidden");
    gate.innerHTML = '<strong>尚未配置 API Key</strong><span>真实搭建需要在后端调用模型，所以要先配置密钥。请在 <code>backend/.env</code> 写入 <code>MODEL_API_KEY</code>，保存后重启后端。未配置时不能创建真实项目或开始真实搭建。你可以先打开独立离线示例查看完整流程。</span><div class="setup-actions"><button id="showConfigExampleButton" class="secondary-button" type="button">查看配置示例</button><button id="refreshModelButton" class="secondary-button" type="button">重新检查配置</button></div><pre id="configExample" class="config-example hidden">MODEL_API_KEY=你的服务端密钥\nMODEL_BASE_URL=https://api.deepseek.com/v1\nMODEL_NAME=deepseek-chat\nAI_WORKBENCH_REQUIRE_MODEL=true</pre>';
    setStartButton(start, { disabled: true, loading: false, label: "先配置 API Key" });
    $("#showConfigExampleButton")?.addEventListener("click", () => { const example = $("#configExample"); if (example) example.classList.toggle("hidden"); });
    $("#refreshModelButton")?.addEventListener("click", async () => { await loadModelStatus(); render(); });
    return;
  }
  if (state.model.configured) {
    gate.innerHTML = "";
    gate.classList.add("hidden");
  } else {
    gate.classList.remove("hidden");
    gate.innerHTML = '<strong>当前为离线结构化模式</strong><span>后端未要求 API Key，现在可以使用本地结构化方案。这不是真实模型，也不代表已经配置密钥。如要使用真实模型，请在 <code>backend/.env</code> 配置 <code>MODEL_API_KEY</code> 并重启后端。</span>';
  }
  setStartButton(start, { disabled: false, loading: false, label: "开始搭建" });
}
function renderWelcomeGuide() {
  const guide = $("#welcomeGuide");
  if (!guide) return;
  const seen = localStorage.getItem("ai-workbench-onboarding-seen-v1") === "1";
  const helpOpen = state.helpOpen === true;
  if (!helpOpen && (state.creating || state.current || seen)) { guide.classList.add("hidden"); return; }
  const intro = !online
    ? state.modelUnavailable
      ? "这是本地 API 模式：先启动 backend/start.sh，工作台才能读取 API Key 状态。没有 Key 也可以单独查看离线示例。"
      : state.model?.configured
        ? "可以直接开始真实搭建，回答会逐步收敛产品方向。"
        : "这是本地 API 模式：先配置服务，再开始真实搭建。没有 Key 也可以单独查看离线示例。"
    : offlineDemo
      ? "这是独立离线示例，不需要 API Key；输入一句话就可以体验完整流程。"
      : "这是浏览器里的离线 mock，用来先看流程和界面，不会调用真实模型。";
  const firstStep = !online ? (state.modelUnavailable ? "启动 backend/start.sh 并重新检查" : state.model?.configured ? "输入一句话描述想做的产品" : "在 backend/.env 配置 MODEL_API_KEY") : "输入一句话描述想做的产品";
  const secondStep = !online && !state.model?.configured && !canStartBuild() ? "也可以先打开独立离线示例" : "回答会改变方向的问题";
  const thirdStep = !online ? "确认需求和方案后再验收、验证预览并记录试用反馈" : "确认后查看示例并继续修改";
  guide.classList.remove("hidden");
  guide.innerHTML = `<div class="welcome-head"><span class="section-kicker">${helpOpen ? "使用说明" : "第一次使用"}</span><button id="dismissWelcomeGuide" class="guide-dismiss" type="button">${helpOpen ? "关闭说明" : "知道了"}</button></div><h3>${helpOpen ? "这套工作台怎么用？" : "第一次使用，先看这 3 步"}</h3><p>${intro}</p><ol class="welcome-steps"><li>${escapeHtml(firstStep)}</li><li>${escapeHtml(secondStep)}</li><li>${escapeHtml(thirdStep)}</li></ol>`;
  $("#dismissWelcomeGuide")?.addEventListener("click", () => { if (helpOpen) state.helpOpen = false; else localStorage.setItem("ai-workbench-onboarding-seen-v1", "1"); renderWelcomeGuide(); });
}
function showOnly(...ids) {
  ["#questionPanel", "#planPanel", "#previewPanel"].forEach((id) => $(id).classList.toggle("hidden", !ids.includes(id)));
}
function projectDiscovery(project) { return project?.discovery || project?.evidence || {}; }
function projectIntent(project) { return project?.intent || projectDiscovery(project).intent || {}; }
function projectBackend(project) { return project?.backend || project?.engineering || {}; }
function list(value, fallback = []) { return Array.isArray(value) && value.length ? value : fallback; }
function displayItem(item) { return item && typeof item === "object" ? (item.text || item.message || item.kind || JSON.stringify(item)) : item; }
function listHtml(value, fallback = ["待补充"]) { return list(value, fallback).map((item) => `<li>${escapeHtml(displayItem(item))}</li>`).join(""); }
function now() { return new Date().toISOString(); }
function replaceProject(project) {
  state.current = project;
  state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)];
}
function transition(project, nextStatus, meta = {}) {
  const from = statusOf(project);
  project.events = Array.isArray(project.events) ? project.events : [];
  project.events.push({ id: `evt_${Date.now()}_${project.events.length}`, from, to: nextStatus, actor: meta.actor || "user", input_version: project.version || 1, output_version: project.version || 1, evidence: meta.evidence || [], pending: meta.pending || [], at: now() });
  project.status = nextStatus;
  project.updated_at = now();
}
function versionLabel(project) { return project?.version && project.version > 1 ? ` · V${project.version}` : ""; }

function renderProjects() {
  const listEl = $("#projectList");
  if (!state.projects.length) { listEl.innerHTML = '<div class="empty-projects">还没有项目<br /><span>从一个想法开始</span></div>'; return; }
  listEl.innerHTML = state.projects.map((project) => `<button class="project-item ${state.current?.id === project.id ? "selected" : ""}" data-project-id="${escapeHtml(project.id)}" type="button"><strong>${escapeHtml(project.idea)}${escapeHtml(versionLabel(project))}</strong><small>${statusLabel(statusOf(project), project)}${project.parent_id ? " · 由上一版迭代" : ""}</small></button>`).join("");
  listEl.querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", () => { setNavigationOpen(false); loadProject(button.dataset.projectId); }));
}

function render() {
  clearError();
  renderWelcomeGuide();
  const project = state.current;
  if (state.creating) {
    syncEntry(project, true); renderStartGate(); showOnly(); setFlow(0, project); renderProjects(); return;
  }
  syncEntry(project, false);
  if (!project) { renderStartGate(); showOnly(); setFlow(0, null); renderProjects(); return; }
  if (isUnknownProject(project)) { setFlow(-1, project); renderUnknownStatus(project); renderProjects(); return; }
  const status = statusOf(project);
  setFlow(phaseForStatus(status, project), project);
  if (!online && state.model?.teacher_workflow && !project.workshop && phaseForStatus(status, project) < 4) renderWorkshopResume(project);
  else if (status === "needs_discovery") renderDiscovery(project);
  else if (status === "needs_intent_confirmation") renderRequirements(project);
  else if (status === "needs_plan_confirmation") renderPlanConfirmation(project);
  else if (status === "backend_building") renderBackend(project, false);
  else if (status === "backend_verified" || status === "preview_ready") renderBackend(project, true);
  else if (status === "trial") renderTrial(project);
  else renderUnknownStatus(project);
  renderProjects();
}

function renderWorkshopResume(project) {
  showOnly("#questionPanel");
  $("#questionPanel").innerHTML = '<div class="panel-heading"><div><span class="section-kicker">需求澄清</span><h3>继续核对这个项目的需求</h3></div></div><p class="panel-copy">会带上已记录的回答，按 Agent 工坊流程检查还有哪些需要确认。</p><div class="panel-actions"><button class="primary-button" id="resumeWorkshopButton" type="button">继续需求澄清</button></div>';
  $("#resumeWorkshopButton").addEventListener("click", (event) => workshopAction(project, "workshop-resume", event.currentTarget, "正在检查需求"));
}

function renderWorkshopTranscript(project, extra = "") {
  const messages = list(project.workshop?.transcript).filter((message) => String(message?.text || "").trim());
  const transcript = messages.map((message) => `<div class="teacher-chat-message is-${message.role === "user" ? "user" : "assistant"}"><span class="teacher-chat-role">${message.role === "user" ? "你" : "Agent 工坊"}</span><p>${escapeHtml(message.text)}</p></div>`).join("");
  return `<div class="teacher-chat-thread">${transcript}${extra}</div>`;
}

function workshopQuestionProgress(project) {
  const total = Object.keys(project.workshop?.originals || {}).length;
  const pending = list(project.workshop?.pending);
  if (!total) return "";
  return `第 ${Math.min(total, total - pending.length + 1)} / ${total} 题`;
}

async function workshopAction(project, action, button, busy, body = undefined) {
  setActionBusy(button, busy); clearError();
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/${action}`, {
      method: "POST", body: body ? JSON.stringify(body) : undefined,
    });
    if (state.current?.id === project.id) { replaceProject(payload.project); render(); }
  } catch (error) { restoreAction(button); showError(error.message); }
}

function bindWorkshopQuestion(project, panel, question) {
  panel.querySelectorAll("[data-question-option], [data-question-recommend]").forEach((button) => {
    button.addEventListener("click", () => selectQuestionOption(button.closest("[data-question-card]"), button.dataset.optionValue || button.dataset.recommendValue));
  });
  panel.querySelector("#answerButton")?.addEventListener("click", submitAnswers);
  panel.querySelector("#workshopOptionsButton")?.addEventListener("click", (event) => {
    workshopAction(project, `questions/${encodeURIComponent(question.id)}/options`, event.currentTarget, "正在准备选项");
  });
  panel.querySelectorAll("[data-workshop-save]").forEach((button) => {
    button.addEventListener("click", (event) => workshopAction(project, "replan", event.currentTarget, "正在保存并重新推导"));
  });
  panel.querySelectorAll("[data-workshop-reply]").forEach((button) => {
    button.addEventListener("click", () => workshopAction(project, "answers", button, "正在整理回答", {
      answers: { [question.id]: button.dataset.workshopReply },
    }));
  });
}

function renderUnknownStatus(project) {
  showOnly("#previewPanel");
  const raw = statusOf(project) || "空";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">项目状态</span><h3>无法识别当前项目状态</h3></div><span class="status-chip is-unknown">无法识别</span></div><p class="panel-copy">当前状态「${escapeHtml(raw)}」不在已知流程里，所以没有给出后端验收或试用操作，避免误入下一步。你可以重新加载项目，或返回项目列表。</p><div class="panel-actions"><button class="primary-button" id="reloadUnknownProjectButton" type="button">重新加载项目</button><button class="secondary-button" id="returnFromUnknownButton" type="button">返回项目列表</button></div>`;
  $("#reloadUnknownProjectButton").addEventListener("click", () => loadProject(project.id));
  $("#returnFromUnknownButton").addEventListener("click", () => {
    state.current = null;
    if (online) localStorage.setItem("ai-workbench-online-preview-current", "");
    render();
  });
}

const QUESTION_OPTION_CATALOG = {
  target_user: [
    { id: "A", label: "个人创作者", description: "独立工作者、自由职业者或个人用户", recommended: true },
    { id: "B", label: "小团队或工作室", description: "需要协作完成同一项工作的几个人" },
    { id: "C", label: "企业或组织", description: "有部门、权限或流程要求的团队" },
  ],
  problem: [
    { id: "A", label: "整理和沟通成本高", description: "信息分散，需要反复整理、确认或转述", recommended: true },
    { id: "B", label: "协作和流程容易断", description: "多人或多工具之间难以持续推进" },
    { id: "C", label: "结果不稳定或难验收", description: "同样的任务每次结果差异很大" },
  ],
  desired_outcome: [
    { id: "A", label: "一份可以直接使用的结果", description: "例如报价单、方案或整理后的文档", recommended: true },
    { id: "B", label: "清楚的下一步行动", description: "知道接下来该做什么、由谁来做" },
    { id: "C", label: "自动完成一段重复工作", description: "减少复制、整理或反复检查" },
  ],
  current_workaround: [
    { id: "A", label: "手工处理或使用表格", description: "靠复制、整理和人工检查完成", recommended: true },
    { id: "B", label: "多个工具拼接使用", description: "在聊天、文档、表格之间来回切换" },
    { id: "C", label: "目前没有固定办法", description: "遇到一次解决一次，没有稳定流程" },
  ],
  constraints: [
    { id: "A", label: "先做本地单用户", description: "不接入外部账号，不自动发布", recommended: true },
    { id: "B", label: "需要多人在线协作", description: "首版就要支持共享或权限" },
    { id: "C", label: "需要接入已有系统", description: "要连接企业内部数据或已有工具" },
  ],
  affected_area: [
    { id: "A", label: "需求和流程", description: "改变用户目标、步骤或判断方式", recommended: true },
    { id: "B", label: "方案和后端", description: "改变功能、接口或数据结构" },
    { id: "C", label: "预览和体验", description: "主要改变界面、展示或试用方式" },
  ],
};

function questionOptions(question) {
  return Array.isArray(question.options) && question.options.length ? question.options : QUESTION_OPTION_CATALOG[question.id] || [];
}

function optionMatchesAnswer(option, value) {
  const answer = String(value || "").trim();
  return answer === option.label || answer.startsWith(`${option.label}；`);
}

function renderQuestionCard(question, answer) {
  const options = questionOptions(question);
  if (!options.length) {
    return `<div class="question-card"><label for="answer-${escapeHtml(question.id)}">${escapeHtml(question.text)}</label><input id="answer-${escapeHtml(question.id)}" data-question-id="${escapeHtml(question.id)}" value="${escapeHtml(answer)}" placeholder="${escapeHtml(question.hint || "用自己的话回答即可")}" autocomplete="off" /><small>${escapeHtml(question.reason || "这会影响需求、范围或验收")}</small></div>`;
  }
  const recommended = options.find((option) => option.recommended) || options[0];
  return `<div class="question-card" data-question-card="${escapeHtml(question.id)}"><div class="question-label">${escapeHtml(question.text)}</div><div class="question-options" role="group" aria-label="${escapeHtml(question.text)}">${options.map((option) => `<button class="question-option${optionMatchesAnswer(option, answer) ? " is-selected" : ""}" data-question-option="${escapeHtml(question.id)}" data-option-value="${escapeHtml(option.label)}" type="button" aria-pressed="${optionMatchesAnswer(option, answer)}"><span class="question-option-key">${escapeHtml(option.id)}</span><span class="question-option-copy"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description || "")}</small></span>${option.recommended ? '<span class="question-option-badge">推荐</span>' : ""}</button>`).join("")}</div><input class="question-answer-value" type="hidden" data-question-id="${escapeHtml(question.id)}" value="${escapeHtml(answer)}" /><button class="question-recommend" data-question-recommend="${escapeHtml(question.id)}" data-recommend-value="${escapeHtml(recommended.label)}" type="button">按推荐选择：${escapeHtml(recommended.label)} ↗</button><input class="question-option-custom" data-question-custom="${escapeHtml(question.id)}" placeholder="也可以补充具体情况（可选）" value="" autocomplete="off" /><small>${escapeHtml(question.reason || "这会影响需求、范围或验收")}</small></div>`;
}

function selectQuestionOption(card, value) {
  const input = card.querySelector("[data-question-id]");
  if (input) input.value = value;
  card.querySelectorAll("[data-question-option]").forEach((button) => {
    const selected = button.dataset.optionValue === value;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function teacherChatMessages(project, stage) {
  return stage === "answers" ? list(project.workshop?.answer_transcript) : list(project.workshop?.transcript);
}

function renderTeacherChat(project, stage, extra = "") {
  const messages = teacherChatMessages(project, stage).filter((message) => String(message?.text || "").trim());
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const transcript = messages.map((message) => {
    const isChoiceMessage = message === latestAssistant && teacherOptionItems(project, stage).length > 0;
    const text = isChoiceMessage
      ? String(message.text).split("\n").filter((line) => !/^\s*[A-CＡ-Ｃ][.．、:：)]\s+/.test(line)).join("\n").trim()
      : message.text;
    return `<div class="teacher-chat-message is-${message.role === "user" ? "user" : "assistant"}"><span class="teacher-chat-role">${message.role === "user" ? "你" : "Agent 工坊"}</span><p>${escapeHtml(text)}</p></div>`;
  }).join("");
  return `<div class="teacher-chat-thread">${transcript}${extra}</div>`;
}

function teacherOptionItems(project, stage) {
  const messages = teacherChatMessages(project, stage);
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return [];
  return String(assistant.text || "").split("\n").map((line) => line.match(/^\s*[A-CＡ-Ｃ][.．、:：)]\s*(.+)$/))
    .filter(Boolean).map((match, index) => ({ label: match[0].trim().slice(0, 1).toUpperCase(), text: match[1].trim(), recommended: index === 0 })).filter((item) => item.text).slice(0, 3);
}

function teacherOptionSuggestions(project, stage) {
  return teacherOptionItems(project, stage).map((item) => item.text);
}

function renderTeacherSuggestions(project, stage) {
  const source = stage === "answers" ? list(project.workshop?.answer_suggestions) : list(project.workshop?.intake_suggestions);
  const defaults = stage === "answers" ? ["帮我想想", "跳过这题", "先保存已回答的"] : ["不确定，先跳过", "信息够了，帮我整理"];
  const optionItems = teacherOptionItems(project, stage);
  const optionButtons = optionItems.map((item) => `<button class="teacher-choice-card${item.recommended ? " is-recommended" : ""}" data-teacher-choice="${escapeHtml(item.text)}" type="button"><span class="teacher-choice-key">${escapeHtml(item.label)}</span><span class="teacher-choice-copy">${escapeHtml(item.text)}${item.recommended ? '<small class="teacher-choice-badge">推荐方向</small>' : ""}</span></button>`).join("");
  const utilityItems = [...new Set([...source, ...defaults].map((item) => String(item || "").trim()).filter(Boolean))];
  const utilityButtons = utilityItems.map((item) => `<button class="teacher-suggestion" data-teacher-suggestion="${escapeHtml(item)}" type="button">${escapeHtml(item)}</button>`).join("");
  return `${optionButtons ? `<div class="teacher-choice-grid">${optionButtons}</div>` : ""}<div class="teacher-suggestions teacher-utility-actions">${utilityButtons}</div>`;
}

function bindTeacherChat(project, stage) {
  const panel = stage === "answers" ? $("#questionPanel") : $("#questionPanel");
  panel.querySelectorAll("[data-teacher-suggestion]").forEach((button) => button.addEventListener("click", () => sendTeacherChat(project, stage, button.dataset.teacherSuggestion, button)));
  panel.querySelectorAll("[data-teacher-choice]").forEach((button) => button.addEventListener("click", () => sendTeacherChat(project, stage, button.dataset.teacherChoice, button)));
  const send = () => {
    const input = panel.querySelector("#teacherChatInput");
    const value = input?.value.trim();
    if (value) sendTeacherChat(project, stage, value, panel.querySelector("#teacherChatSend"));
  };
  panel.querySelector("#teacherChatSend")?.addEventListener("click", send);
  panel.querySelector("#teacherChatInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); }
  });
}

async function sendTeacherChat(project, stage, text, button) {
  const value = String(text || "").trim();
  if (!value) return;
  const requestKey = `${project.id}:${stage}`;
  if (state.inflightChats.has(requestKey)) return;
  const workshop = project.workshop || {};
  const history = stage === "answers" ? list(workshop.answer_transcript) : list(workshop.transcript);
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  if (lastUser && String(lastUser.text || "").trim() === value) {
    await loadProject(project.id);
    showError("上一条回答可能已经保存，已先刷新项目状态，请确认后再继续。");
    return;
  }
  state.inflightChats.add(requestKey);
  setActionBusy(button, "正在回复"); clearError();
  const messages = [...history, { role: "user", text: value }];
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/workshop-chat`, { method: "POST", body: JSON.stringify({ stage, messages }) });
    replaceProject(payload.project); render();
  } catch (error) {
    if (!online) {
      await loadProject(project.id);
      const latest = state.current;
      const latestHistory = stage === "answers" ? list(latest?.workshop?.answer_transcript) : list(latest?.workshop?.transcript);
      const saved = latestHistory.some((message) => message.role === "user" && String(message.text || "").trim() === value);
      if (saved) {
        showError("已检查服务端状态，这条回答已经保存，请继续当前对话。");
        return;
      }
    }
    restoreAction(button);
    showError(error.message);
  }
  finally { state.inflightChats.delete(requestKey); }
}

function teacherChatComposer(stage) {
  return `<div class="teacher-chat-composer"><textarea id="teacherChatInput" rows="3" placeholder="直接说你的回答，也可以点击下面的建议"></textarea><button class="primary-button" id="teacherChatSend" type="button">发送回答 <span class="button-arrow">↗</span></button></div>`;
}

function renderPlanProgress(project, progress = {}) {
  showOnly("#planPanel");
  const stages = list(progress.stages);
  const stageRows = stages.length ? stages.map((stage, index) => {
    const status = stage.status || "todo";
    const marker = status === "done" ? "✓" : status === "active" ? "…" : status === "failed" ? "×" : String(index + 1).padStart(2, "0");
    return `<li class="plan-progress-row is-${escapeHtml(status)}"><span class="plan-progress-marker">${marker}</span><div><strong>${escapeHtml(stage.label || "方案阶段")}</strong><small>${escapeHtml(stage.description || "")}</small></div></li>`;
  }).join("") : "<li class=\"plan-progress-empty\">正在创建老师工作区和阶段记录</li>";
  const review = progress.review || {};
  const reviewText = review.score == null ? "独立审稿尚未开始" : `独立审稿 ${Number(review.score)} 分 · ${review.ok ? "通过" : "待处理"}`;
  const statusText = progress.status === "failed" ? "方案推导中断" : progress.status === "done" ? "方案推导完成" : "正在推导方案";
  const done = progress.status === "done";
  const reviewPassed = review.ok === true && Number(review.score || 0) >= 80;
  const answerDraftPending = list(project.workshop?.answer_draft).length > 0;
  const reviewFollowUpPending = list(project.workshop?.answer_questions).some((item) => String(item || "").startsWith("审稿追问"));
  const nextCopy = done
    ? (reviewPassed
      ? "独立审稿已通过。请打开方案，确认后才能交接进入后端开发。"
      : answerDraftPending
        ? (reviewFollowUpPending
          ? "这些是独立审稿指出的定向缺口。请先写回回答并重新审稿，不会回到上一批方案问题。"
          : "这批方案问题已经回答完，先把回答写回 PRD 并重新审阅；只有复审仍未通过，才会生成定向追问。")
        : "独立审稿未达到 80 分，不能确认方案。请打开审稿指出的具体缺口，重新回答后整理 PRD。")
    : "这里沿用老师项目的阶段进度。需求拆解、架构设计和独立审稿完成后，才会整理待确认问题和交接文档。";
  const nextAction = done ? `<div class="plan-progress-next"><strong>${reviewPassed ? "下一步：确认方案" : answerDraftPending ? (reviewFollowUpPending ? "下一步：重新审稿" : "下一步：写回这批回答") : "下一步：回答审稿缺口"}</strong><p>${reviewPassed ? "查看完整方案并点击确认，进入后端开发准备。" : answerDraftPending ? (reviewFollowUpPending ? "点击“重新审稿”，写回这些定向回答并重新评分。" : "先点击“重新整理 PRD”，系统才会重新审稿并决定是否需要定向追问。") : "查看审稿指出的缺口，回答后重新整理 PRD。"}</p><button class="primary-button" id="openPlanResultButton" type="button">${reviewPassed ? "查看方案并确认" : answerDraftPending ? (reviewFollowUpPending ? "继续重新审稿" : "继续整理这批回答") : "查看定向追问"}<span class="button-arrow">↗</span></button></div>` : "";
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案推导</span><h3>${escapeHtml(statusText)}</h3></div><span class="status-chip ${progress.status === "failed" ? "is-revise" : progress.status === "done" ? (reviewPassed ? "is-done" : "is-revise") : "is-progress"}">${escapeHtml(reviewText)}</span></div><p class="panel-copy">${escapeHtml(nextCopy)}</p><ol class="plan-progress-list">${stageRows}</ol>${nextAction}${progress.status === "failed" ? `<div class="supplement-box"><strong>方案推导需要重试</strong><p>当前阶段已经保留在本地工作区，重新执行会优先复用已完成的阶段。</p></div>` : ""}`;
  $("#openPlanResultButton")?.addEventListener("click", () => {
    state.planProgressToken = Number(state.planProgressToken || 0) + 1;
    loadProject(project.id);
  });
}

function startPlanProgress(project) {
  let stopped = false;
  let timer = null;
  const token = (state.planProgressToken = Number(state.planProgressToken || 0) + 1);
  const poll = async () => {
    if (stopped) return;
    try {
      const progress = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/plan-progress`);
      if (!stopped && state.planProgressToken === token) renderPlanProgress(project, progress);
    } catch (_) {
      // The confirm request remains the authoritative result. A temporary progress read failure should not stop it.
    }
    if (!stopped) timer = window.setTimeout(poll, 1200);
  };
  poll();
  return () => { stopped = true; if (timer) window.clearTimeout(timer); if (state.planProgressToken === token) state.planProgressToken += 1; };
}

function teacherIntakeRound(project) {
  const rounds = list(project.workshop?.transcript).filter((message) => message.role === "assistant").length;
  return rounds ? `第 ${rounds} 轮` : "准备第 1 轮";
}

function renderDiscovery(project) {
  showOnly("#questionPanel");
  if (project.workshop) {
    const panel = $("#questionPanel");
    panel.innerHTML = `<div class="panel-heading"><div><span class="section-kicker">需求澄清 · 老师 Agent · ${teacherIntakeRound(project)}</span><h3>把想法聊清楚</h3></div><span class="status-chip is-progress">动态追问</span></div><p class="panel-copy">当前问题会根据六个需求维度的覆盖情况继续变化。回答后进入下一轮，拿不准可以点推荐方向或直接说不知道。</p>${renderTeacherChat(project, "intake")}<div class="teacher-suggestions">${renderTeacherSuggestions(project, "intake")}</div>${teacherChatComposer("intake")}`;
    bindTeacherChat(project, "intake");
    return;
  }
  const round = Math.max(1, Number(project.discovery_round ?? project.round ?? 0) + 1);
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">需求澄清 · 第 ${round} 轮${project.version > 1 ? ` · V${project.version}` : ""}</span><h3>进入老师 Agent 对话</h3></div><span class="status-chip is-progress">等待聊天入口</span></div><p class="panel-copy">正式需求澄清使用老师源码的动态对话。请先点击“继续需求澄清”，再由 Agent 按需求覆盖情况追问。</p><div class="panel-actions"><button class="primary-button" id="continueDiscoveryButton" type="button">继续需求澄清</button></div>`;
  const continueButton = $("#continueDiscoveryButton");
  continueButton.addEventListener("click", () => workshopAction(project, "workshop-resume", continueButton, "正在进入老师对话"));
}

function renderRequirements(project) {
  showOnly("#questionPanel");
  const intent = projectIntent(project); const discovery = projectDiscovery(project);
  if (project.workshop) {
    $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · 需求确认</span><h3>${escapeHtml(project.workshop.name || "确认需求草稿")}</h3></div><span class="status-chip is-confirm">等你确认</span></div><div class="question-card"><label for="workshopDraft">核对需求草稿，有需要可以直接修改</label><textarea id="workshopDraft" class="workshop-draft" rows="14" maxlength="26000">${escapeHtml(project.workshop.draft)}</textarea></div><div class="panel-actions"><button class="primary-button" id="confirmIntentButton" type="button">确认需求，推导方案并审稿</button></div>`;
    $("#confirmIntentButton").addEventListener("click", () => confirmIntent(project));
    return;
  }
  const supplement = project.requirement_supplement?.status === "needs_input";
  const supplementBox = supplement ? `<div class="supplement-box"><div class="section-kicker">补充信息</div><h4>补充一条会改变判断的信息</h4><p>可以补充事实、约束或必须纳入的用户场景；提交后仍停留在需求确认。</p><textarea id="supplementInput" aria-label="补充需求信息" placeholder="例如：已有 5 次访谈都提到需要导入原始记录"></textarea><div class="panel-actions"><button class="secondary-button" id="skipSupplementButton" type="button">无需补充</button><button class="primary-button" id="submitSupplementButton" type="button"><span>提交补充</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 需求确认</span><h3>确认需求判断，生成 PRD</h3></div><span class="status-chip is-confirm">等你确认</span></div><p class="panel-copy">这一步会把用户、问题、证据、目标和风险整理成 PRD 的需求判断。确认后继续补齐方案，完成后交给模块二进行后端开发。</p><div class="plan-grid"><div class="plan-block"><h4>用户与目标</h4><p>${escapeHtml(intent.target_user || discovery.target_user || "待确认")}<br />${escapeHtml(intent.goal || discovery.problem || "待确认")}</p></div><div class="plan-block"><h4>证据与假设</h4><ul>${listHtml(discovery.evidence || discovery.facts, ["当前暂无外部证据，先按假设记录"])}</ul></div><div class="plan-block"><h4>核心结果</h4><p>${escapeHtml(intent.core_loop || discovery.desired_outcome || "待确认")}</p></div><div class="plan-block"><h4>红灯与待验证</h4><ul>${listHtml(discovery.red_flags || discovery.open_questions, ["暂无红灯；真实用户验证仍待完成"])}</ul></div></div>${supplementBox}<div class="panel-actions"><button class="secondary-button" id="continueDiscoveryButton" type="button">我还要补充</button><button class="primary-button" id="confirmIntentButton" type="button"><span>确认需求，继续整理 PRD</span><span class="button-arrow">↗</span></button></div>`;
  $("#continueDiscoveryButton").addEventListener("click", () => { project.requirement_supplement = { status: "needs_input", prompt: "补充一条会改变判断的信息" }; persist(); render(); });
  if (supplement) {
    $("#skipSupplementButton").addEventListener("click", () => { project.requirement_supplement = { status: "skipped", at: now() }; persist(); render(); });
    $("#submitSupplementButton").addEventListener("click", () => submitSupplement(project));
  }
  $("#confirmIntentButton").addEventListener("click", () => confirmIntent(project));
}

function renderPlanConfirmation(project) {
  showOnly("#planPanel");
  const intent = projectIntent(project); const plan = project.plan || {};
  const correction = project.plan_revision?.status === "needs_input" ? project.plan_revision : null;
  if (correction) {
    $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">修改方案</span><h3>告诉我方案哪里要改</h3></div><span class="status-chip is-revise">仍在方案确认</span></div><p class="panel-copy">这里只修改方案，不会把你拉回需求发现，也不会重新回答旧问题。</p><div class="question-list"><div class="question-card"><label for="answer-plan-correction">${escapeHtml(correction.prompt || "方案需要调整哪一处？")}</label><input id="answer-plan-correction" placeholder="用自己的话描述修改" autocomplete="off" /></div></div><div class="panel-actions"><button class="primary-button" id="planCorrectionButton" type="button"><span>更新方案</span><span class="button-arrow">↗</span></button></div>`;
    $("#planCorrectionButton").addEventListener("click", async () => {
      const value = $("#answer-plan-correction").value.trim(); if (!value) { showError("先说清楚要改哪一处"); return; }
      try { if (online) { project.plan.summary = `${project.plan.summary}（用户补充调整：${value}）`; project.plan_revision = { status: "applied", note: value, applied_at: now() }; project.events = Array.isArray(project.events) ? project.events : []; project.events.push({ id: `evt_${Date.now()}_${project.events.length}`, from: "needs_plan_confirmation", to: "needs_plan_confirmation", actor: "user", input_version: project.version || 1, output_version: project.version || 1, evidence: [value], pending: [], at: now() }); persist(); } else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/modify-plan`, { method: "POST", body: JSON.stringify({ note: value }) }); replaceProject(payload.project); } render(); }
      catch (error) { showError(error.message); }
    });
    return;
  }
  if (project.workshop) {
    renderWorkshopPlan(project, plan);
    return;
  }
  const configured = state.model?.configured;
  const modelHint = configured ? "已配置真实模型；可主动重生成方案" : "真实模型尚未配置，当前只能继续使用本地结构化方案";
  const modelButton = configured
    ? `<button class="secondary-button" id="realPlanButton" type="button">使用真实模型重生成</button>`
    : `<button class="secondary-button" id="realPlanButton" type="button" disabled title="当前未配置真实模型">真实模型未配置</button>`;
  const reviewScore = Number(plan.review_score ?? 0);
  const reviewOk = plan.review_ok === true && reviewScore >= 80;
  const reviewIssues = list(plan.review_issues);
  const reviewPanel = `<div class="requirement-review ${reviewOk ? "is-passed" : ""}"><div class="review-summary"><strong>方案审稿 ${reviewOk ? "通过" : "未通过"}</strong><span>${reviewScore} 分</span></div><p>${escapeHtml(plan.review_summary || "方案需要完成结构化审稿")}</p>${reviewIssues.length ? `<ul>${reviewIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}</div>`;
  const confirmButton = reviewOk
    ? '<button class="primary-button" id="confirmPlanButton" type="button"><span>确认 PRD，开始后端开发</span><span class="button-arrow">↗</span></button>'
    : '<button class="secondary-button" id="confirmPlanButton" type="button" disabled title="方案审稿需要达到 80 分">方案审稿未达到 80 分</button>';
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案</span><h3>${escapeHtml(plan.title || project.idea)}</h3></div><span class="status-chip ${reviewOk ? "is-done" : "is-confirm"}">${escapeHtml(sourceLabel(project))}</span></div><p class="panel-copy">这份 PRD 已经包含产品定位、核心闭环、MVP 范围和验收标准。先完成稳定审稿，再确认方案进入模块二。</p><div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${escapeHtml(plan.summary || intent.goal || "待生成")}</p></div><div class="plan-block"><h4>核心闭环</h4><p>${escapeHtml(intent.core_loop || "待补充")}</p></div><div class="plan-block"><h4>MVP 范围</h4><ul>${listHtml(plan.mvp_features || plan.scope)}</ul></div><div class="plan-block"><h4>验收标准</h4><ul>${listHtml(intent.acceptance)}</ul></div></div>${reviewPanel}<div class="panel-actions">${modelButton}<button class="secondary-button" id="modifyPlanButton" type="button">方案需要修改</button>${confirmButton}</div><div class="stage-note">${modelHint}</div>`;
  $("#confirmPlanButton").addEventListener("click", () => confirmPlan(project, true));
  $("#modifyPlanButton").addEventListener("click", () => confirmPlan(project, false));
  $("#realPlanButton").addEventListener("click", generateRealPlan);
}

function renderWorkshopPlan(project, plan) {
  const workshop = project.workshop || {};
  const questions = list(workshop.answer_questions).length ? list(workshop.answer_questions) : list(plan.open_questions);
  if (questions.length || list(workshop.answer_transcript).length || list(workshop.answer_draft).length) {
    renderWorkshopAnswers(project, plan);
    return;
  }
  showOnly("#planPanel");
  const data = plan.teacher_plan || {};
  const facts = Object.entries(data.facts || {}).map(([key, fact]) => {
    const label = { goal: "目标", users: "用户", core_loop: "核心闭环", deliverable: "交付物", boundaries: "边界", constraints: "约束" }[key] || key;
    return `<li><strong>${escapeHtml(label)}</strong> · ${escapeHtml(fact.value || "待确认")} ${fact.status === "待确认" ? "<small>待确认</small>" : ""}</li>`;
  }).join("");
  const pendingCount = questions.length;
  const reviewPassed = plan.review_ok === true && Number(plan.review_score || 0) >= 80;
  const ready = reviewPassed && !pendingCount;
  const reviewBlock = `<div class="plan-block"><h4>独立审稿</h4><strong>${reviewPassed ? "审稿通过" : "审稿未通过"} · ${Number(plan.review_score || 0)} 分</strong><p>${escapeHtml(plan.review_summary || "")}</p>${plan.review_issues?.length ? `<ul>${listHtml(plan.review_issues)}</ul>` : ""}</div>`;
  const summary = `<div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${escapeHtml(plan.summary || "")}</p></div><div class="plan-block"><h4>需求事实</h4><ul>${facts || "<li>待生成</li>"}</ul></div><div class="plan-block"><h4>待确认问题</h4><p>${pendingCount ? `还有 ${pendingCount} 个待答问题` : "当前没有待确认问题"}</p></div>${reviewBlock}</div>`;
  const design = data.design || {};
  const details = `<details class="delivery-details"><summary>完整方案<span>五要素、选型、架构与测试</span></summary><div class="plan-grid"><div class="plan-block"><h4>领域建模</h4><ul>${Object.values(data.elements || {}).map((items) => listHtml(items, [])).join("")}</ul></div><div class="plan-block"><h4>组件选型</h4><ul>${listHtml(list(data.components).map((item) => `${item.name} · ${item.decision} · ${item.reason}`), [])}</ul></div><div class="plan-block"><h4>技术与部署</h4><p>${escapeHtml(design.tech_stack_and_deployment || "")}</p><ul>${listHtml(design.security_and_degradation, [])}</ul></div><div class="plan-block"><h4>测试设计</h4><ul>${listHtml(design.testing, [])}</ul></div></div></details>`;
  const confirm = ready ? '<button class="primary-button" id="confirmPlanButton" type="button"><span>确认方案，交接进入后端开发</span><span class="button-arrow">↗</span></button>' : '<button class="secondary-button" id="confirmPlanButton" type="button" disabled>先完成待确认项和 80 分审稿门禁</button>';
  const nextStep = ready ? `<div class="plan-next-step"><div><strong>下一步</strong><span>方案已通过，可以进入后端开发准备。</span></div>${confirm}</div>` : "";
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块一 · PRD 方案</span><h3>${escapeHtml(plan.title || project.idea)}</h3></div><span class="status-chip ${ready ? "is-done" : "is-confirm"}">${ready ? "等你确认" : "待复核"}</span></div><p class="panel-copy">方案会先经过老师的待确认问题和统一审稿，达到 80 分且没有高严重度问题后才能进入后端开发。</p>${nextStep}${summary}${details}<div class="panel-actions"><button class="secondary-button" id="modifyPlanButton" type="button">方案需要修改</button>${ready ? "" : confirm}</div>`;
  $("#confirmPlanButton")?.addEventListener("click", () => confirmPlan(project, true));
  $("#modifyPlanButton")?.addEventListener("click", () => confirmPlan(project, false));
}

function renderWorkshopAnswers(project, plan) {
  showOnly("#questionPanel");
  const workshop = project.workshop || {};
  const questions = list(workshop.answer_questions).length ? list(workshop.answer_questions) : list(plan.open_questions);
  const draft = list(workshop.answer_draft);
  const reviewFollowUp = questions.some((item) => String(item || "").startsWith("审稿追问"));
  const intro = !list(workshop.answer_transcript).length && questions.length ? `<div class="teacher-chat-message is-assistant"><span class="teacher-chat-role">Agent 工坊</span><p>${escapeHtml(workshop.answer_intro || `方案里有 ${questions.length} 个还没想清楚的问题，我们一题一题过。想好的直接回答，拿不准可以点“帮我想想”。`)}</p></div>` : "";
  const draftCard = draft.length ? `<div class="teacher-chat-draft"><strong>${reviewFollowUp ? "审稿缺口回答已经收齐" : "这些回答已经收齐"}</strong>${draft.map((item) => `<p><b>${escapeHtml(item.question || "")}</b><br />${escapeHtml(item.answer || "")}</p>`).join("")}<button class="primary-button" id="saveWorkshopAnswersButton" type="button"><span>${reviewFollowUp ? "重新审稿" : "重新整理 PRD"}</span><span class="button-arrow">↗</span></button></div>` : "";
  const countLabel = questions.length ? `${questions.length} 条` : "动态";
  const answerComposer = draft.length ? "" : teacherChatComposer("answers");
  const answerSuggestions = draft.length ? "" : `<div class="teacher-suggestions">${renderTeacherSuggestions(project, "answers")}</div>`;
  const panel = $("#questionPanel");
  const heading = reviewFollowUp ? (draft.length ? "审稿缺口回答已收齐" : "回答审稿指出的缺口") : (draft.length ? "方案问题回答已收齐" : "继续和老师对话");
  const chip = draft.length ? (reviewFollowUp ? "等待重新审稿" : "等待重新整理 PRD") : (reviewFollowUp ? "复审定向追问" : "统一评分前必须答完");
  const copy = draft.length ? (reviewFollowUp ? "请点击“重新审稿”，系统会把这些审稿缺口写回 PRD 并重新评分。" : "请点击“重新整理 PRD”，系统会把这些回答写回方案并重新审阅。") : (reviewFollowUp ? "这些问题来自独立审稿缺口，不会重新开启上一批方案问题。" : "老师会按原始方案问题逐题推进。回答、选项、帮我想想、跳过和先保存都在同一段聊天里完成。");
  panel.innerHTML = `<div class="panel-heading"><div><span class="section-kicker">${reviewFollowUp ? "复审定向追问" : "方案待确认问题"} · ${countLabel}</span><h3>${heading}</h3></div><span class="status-chip is-confirm">${chip}</span></div><p class="panel-copy">${copy}</p>${renderTeacherChat(project, "answers", intro)}${answerSuggestions}${draftCard}${answerComposer}<div class="panel-actions"><button class="secondary-button" id="backToPlanButton" type="button">返回方案概览</button></div>`;
  bindTeacherChat(project, "answers");
  panel.querySelector("#backToPlanButton")?.addEventListener("click", () => renderWorkshopPlan(project, plan));
  panel.querySelector("#saveWorkshopAnswersButton")?.addEventListener("click", async (event) => {
    setActionBusy(event.currentTarget, "正在重新推导");
    const stopProgress = online ? () => {} : startPlanProgress(project);
    try {
      const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/workshop-chat/save`, { method: "POST", body: JSON.stringify({ answers: draft }) });
      replaceProject(payload.project); render();
    } catch (error) { restoreAction(event.currentTarget); render(); showError(error.message); }
    finally { stopProgress(); }
  });
}

function renderBackend(project, verified) {
  showOnly("#previewPanel");
  const backend = projectBackend(project); const tasks = list(project.tasks);
  if (backend.status === "prd_health_check" || backend.status === "stage_task_ready") {
    const id = encodeURIComponent(project.id);
    const title = backend.status === "stage_task_ready" ? "PRD 已交接，准备开发" : "PRD 体检";
    const copy = backend.status === "stage_task_ready" ? "方案确认已完成。下一步只调用一次真实 /build，读取老师 idea-to-launch-kit 的本阶段任务。" : "已交接这次确认的 PRD 和方案。Idea to Launch 已建立阶段 0 任务。";
    $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">模块二 · 阶段 0</span><h3>${title}</h3></div><span class="status-chip is-progress">等待开发准备</span></div><p class="panel-copy">${copy}</p><div class="plan-grid"><div class="plan-block"><h4>已交接</h4><ul>${listHtml(backend.checks)}</ul></div><div class="plan-block"><h4>开发阶段</h4><ul>${listHtml(backend.acceptance)}</ul></div></div><div class="panel-actions"><a class="secondary-button" href="/api/v1/projects/${id}/handoff">下载交接包</a><button class="primary-button" id="startBackendButton" type="button"><span>开始后端开发准备</span><span class="button-arrow">↗</span></button><button class="secondary-button" id="refreshBuildButton" type="button">刷新状态</button></div>`;
    $("#startBackendButton").addEventListener("click", () => startBackendBuild(project));
    $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
    return;
  }
  const checks = backend.verification || backend.tests || backend.checks || [];
  const stage = previewStageView(project);
  const previewReady = stage.previewReady;
  const previewLabel = stage.previewLabel;
  const previewState = stage.previewState;
  const preview = previewReady && project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${escapeHtml(previewReady ? previewLabel : project.plan.preview_label || "产品示例")}</span><span>${escapeHtml(previewReady ? previewState : verified ? "等你确认" : "后端开发中")}</span></div><div class="preview-body"><h4>${escapeHtml(project.plan.title || project.idea)}</h4><p>${escapeHtml(project.plan.summary || "方案正在生成")}</p><span class="preview-cta">${escapeHtml(project.answers?.desired_outcome || project.answers?.core_action || (online ? "查看示例结果" : "打开运行时预览"))} ↗</span></div></div>` : "";
  const title = previewReady ? stage.title : verified ? "后端已生成，等你验收" : backend.status === "awaiting_external_coding" ? "等待外部编码工具完成" : "等待后端开发准备";
  const headingKicker = previewReady ? "模块二 · 产品预览" : verified ? "模块二 · 后端验收" : backend.status === "awaiting_external_coding" ? "模块二 · 开发等待" : "模块二 · 后端开发";
  const chipClass = { "preview-verified": "is-preview-verified", "preview-pending": "is-preview-pending", "example-viewed": "is-confirm", "example-pending": "is-progress" }[stage.chipKind] || "is-progress";
  const headingChip = previewReady
    ? `<span class="status-chip ${chipClass}">${escapeHtml(stage.chip)}</span>`
    : verified ? '<span class="status-chip is-confirm">等你确认</span>' : '<span class="status-chip is-progress">进行中</span>';
  const startTrialButton = stage.startEnabled
    ? `<button class="primary-button" id="startTrialButton" type="button"><span>开始试用</span><span class="button-arrow">↗</span></button>`
    : `<button class="secondary-button" id="startTrialButton" type="button" disabled title="${escapeHtml(stage.startDisabledReason)}">开始试用</button>`;
  const openPreviewButton = previewReady
    ? (stage.startEnabled
      ? `<button class="secondary-button" id="openPreviewButton" type="button">${escapeHtml(stage.openLabel)}</button>`
      : `<button class="primary-button" id="openPreviewButton" type="button"><span>${escapeHtml(stage.openLabel)}</span><span class="button-arrow">↗</span></button>`)
    : "";
  const action = previewReady
    ? (stage.startEnabled ? `${openPreviewButton}${startTrialButton}` : `${startTrialButton}${openPreviewButton}`)
    : verified
      ? '<button class="primary-button" id="acceptanceButton" type="button"><span>验收通过，进入产品预览</span><span class="button-arrow">↗</span></button>'
      : `<button class="primary-button" id="refreshBuildButton" type="button"><span>${backend.status === "awaiting_external_coding" ? "刷新外部开发状态" : "刷新开发状态"}</span></button>`;
  const panelCopy = previewReady ? stage.copy : backend.status === "awaiting_external_coding" ? "老师工具包已经生成当前阶段任务。请由外部编码工具完成任务并运行原始 kit.sh 自检，工作台不会把等待态画成开发完成。" : "这里展示 API、数据模型、测试和运行时结果。验收通过只代表进入产品预览，不代表预览已经验证。";
  const newRequirementForm = previewReady && project.new_requirement_draft ? `<div class="iteration-box"><div class="section-kicker">新版本 · V${Number(project.version || 1) + 1}</div><h4>这次想新增或改变什么？</h4><p>这会创建新版本并重新判断受影响的需求，不会改写已经验收的版本。</p><textarea id="newRequirementInput" aria-label="下一版需求" placeholder="例如：新增一个让用户导入访谈记录的入口"></textarea><div class="panel-actions"><button class="primary-button" id="createVersionButton" type="button"><span>开启下一版需求发现</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">${headingKicker}</span><h3>${title}</h3></div>${headingChip}</div><p class="panel-copy">${escapeHtml(panelCopy)}</p>${preview}<details class="delivery-details" ${previewReady ? "" : "open"}><summary>交付详情<span>接口、任务与检查</span></summary><div class="plan-grid"><div class="plan-block"><h4>API 与数据</h4><ul>${listHtml(backend.api_contract || backend.api || ["项目状态接口", "需求与方案确认接口", "预览与验收接口"])}</ul></div><div class="plan-block"><h4>开发任务</h4><ul>${tasks.length ? tasks.map((task) => `<li>${escapeHtml(task.message || task.kind)} · ${escapeHtml(task.status || "进行中")}</li>`).join("") : listHtml(backend.tasks, ["后端任务已创建，等待状态回写"])}</ul></div><div class="plan-block"><h4>测试与恢复</h4><ul>${listHtml(checks, ["结构化 API 测试", "重启恢复待验证", "示例入口已生成"])}</ul></div><div class="plan-block"><h4>完成条件</h4><ul>${listHtml(backend.acceptance || projectIntent(project).acceptance, ["用户能打开示例", "测试结果可查看", "项目状态可恢复"])}</ul></div></div></details>${newRequirementForm}<div class="panel-actions">${action}</div>`;
  if (previewReady) {
    $("#openPreviewButton").addEventListener("click", () => openPreview(project));
    $("#startTrialButton").addEventListener("click", () => startTrial(project));
  } else if (verified) $("#acceptanceButton").addEventListener("click", () => acceptBuild(project));
  else $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
}

function renderTrial(project) {
  showOnly("#previewPanel");
  const trial = project.trial || {};
  const feedback = list(trial.feedback);
  const preview = project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${escapeHtml(online ? project.plan.preview_label || "产品示例" : "本地可运行预览")}</span><span>试用中</span></div><div class="preview-body"><h4>${escapeHtml(project.plan.title || project.idea)}</h4><p>${escapeHtml(project.plan.summary || "方案正在生成")}</p><span class="preview-cta">${escapeHtml(project.answers?.desired_outcome || "打开运行时预览")} ↗</span></div></div>` : "";
  const feedbackBox = feedback.length
    ? `<div class="supplement-box"><div class="section-kicker">试用反馈</div><h4>已记录试用反馈</h4><ul>${feedback.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p>可以继续观察，也可以基于这次反馈开启下一版。</p></div>`
    : `<div class="supplement-box"><div class="section-kicker">试用反馈</div><h4>试用后记下一条真实反馈</h4><p>写下你实际使用后的结果或卡点，再决定是否开启下一版。</p><select id="trialOutcome" aria-label="试用结果"><option value="works">可以继续使用</option><option value="needs_change">需要调整</option><option value="blocked">当前无法使用</option></select><textarea id="trialFeedbackInput" aria-label="试用反馈" placeholder="例如：核心闭环能走通，但导入入口还不够清楚"></textarea><div class="panel-actions"><button class="primary-button" id="submitTrialFeedbackButton" type="button"><span>记录试用结果</span><span class="button-arrow">↗</span></button></div></div>`;
  const iterationForm = feedback.length && project.new_requirement_draft ? `<div class="iteration-box"><div class="section-kicker">新版本 · V${Number(project.version || 1) + 1}</div><h4>这次想新增或改变什么？</h4><p>这会创建新版本并重新判断受影响的需求，不会改写已经试用的版本。</p><textarea id="newRequirementInput" aria-label="下一版需求" placeholder="例如：新增一个让用户导入访谈记录的入口"></textarea><div class="panel-actions"><button class="primary-button" id="createVersionButton" type="button"><span>开启下一版需求发现</span><span class="button-arrow">↗</span></button></div></div>` : "";
  const actions = feedback.length && !project.new_requirement_draft
    ? `<button class="secondary-button" id="openTrialPreviewButton" type="button">打开可运行预览</button><button class="primary-button" id="newRequirementButton" type="button">加新需求，开启下一版</button>`
    : `<button class="secondary-button" id="openTrialPreviewButton" type="button">打开可运行预览</button>`;
  const trialChip = !feedback.length ? '<span class="status-chip is-confirm">等你确认</span>' : (trial.outcome === "needs_change" || trial.outcome === "blocked") ? '<span class="status-chip is-revise">需要修改</span>' : '<span class="status-chip is-done">试用反馈已记录</span>';
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">试用与反馈 · V${project.version || 1}</span><h3>${online ? "试用这个产品示例" : "记录产品试用结果"}</h3></div>${trialChip}</div><p class="panel-copy">验收通过只说明交付检查完成；预览已验证只说明运行检查通过。这里记录一次实际使用结果，再决定要不要继续迭代。</p>${preview}${feedbackBox}${iterationForm}<div class="panel-actions">${actions}</div>`;
  if (!feedback.length) $("#submitTrialFeedbackButton").addEventListener("click", () => submitTrialFeedback(project));
  $("#openTrialPreviewButton").addEventListener("click", () => openPreview(project));
  if (feedback.length) {
    $("#newRequirementButton")?.addEventListener("click", () => { project.new_requirement_draft = true; persist(); render(); });
    if (project.new_requirement_draft) $("#createVersionButton").addEventListener("click", () => createNextVersion(project));
  }
}

window.__workbenchUi = { pickModelStatus, statusOf, statusLabel, phaseForStatus, resultKind, chipText, taskCopy, isPreviewVerified, isMockExampleViewed, markMockExampleViewed, previewStageView, hasTrialFeedback, isPlanRevising, isKnownStatus, isUnknownProject, canStartBuild, canStartTrial, canSubmitTrialFeedback, canCreateNextVersion, questionOptions, optionMatchesAnswer };

async function api(path, options = {}) {
  if (online) return mockApi(path, options);
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error?.message || payload.detail?.message || "这一步暂时失败，请再试一次"); error.status = response.status; throw error; }
  return payload;
}
async function loadModelStatus() {
  if (online) { state.model = pickModelStatus({ configured: false, required: false, can_build: true, model: "offline-mock" }); state.modelUnavailable = false; renderStartGate(); renderWelcomeGuide(); return; }
  try { state.model = pickModelStatus(await api("/api/v1/model/status")); state.modelUnavailable = false; }
  catch (_) { state.model = pickModelStatus({ configured: false, required: true, can_build: false }); state.modelUnavailable = true; }
  render();
}

const FALLBACK_MODEL_PROVIDERS = [
  { key: "deepseek", name: "DeepSeek（推荐）", model: "deepseek-chat", base_url: "https://api.deepseek.com/v1", key_page: "https://platform.deepseek.com" },
  { key: "glm", name: "智谱 GLM", model: "glm-4.5", base_url: "https://open.bigmodel.cn/api/paas/v4", key_page: "https://open.bigmodel.cn" },
  { key: "kimi", name: "Kimi 月之暗面", model: "kimi-k2-0711-preview", base_url: "https://api.moonshot.cn/v1", key_page: "https://platform.moonshot.cn" },
  { key: "anthropic", name: "Anthropic 官方", model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1", key_page: "https://console.anthropic.com" },
];

function modelProvider(key) {
  const providers = state.model?.providers?.length ? state.model.providers : FALLBACK_MODEL_PROVIDERS;
  return providers.find((provider) => provider.key === key) || providers[0];
}

function renderModelSettings(selectedKey = state.model?.provider || "deepseek") {
  let dialog = $("#settingsDialog");
  if (!dialog) {
    document.body.insertAdjacentHTML("beforeend", '<div id="settingsDialog" class="settings-dialog hidden" role="dialog" aria-modal="true" aria-labelledby="settingsDialogTitle"></div>');
    dialog = $("#settingsDialog");
  }
  const providers = state.model?.providers?.length ? state.model.providers : FALLBACK_MODEL_PROVIDERS;
  const provider = modelProvider(selectedKey);
  const options = providers.map((item) => `<option value="${escapeHtml(item.key)}" ${item.key === provider.key ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const fileMode = location.protocol === "file:" || online;
  const status = fileMode ? "当前是离线示例，配置需要打开本地 API" : state.model?.configured ? `已配置 ${escapeHtml(state.model.model || provider.model)}${state.model.key_masked ? ` · ${escapeHtml(state.model.key_masked)}` : ""}` : "尚未配置真实模型";
  const guide = providers.slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.model)}</span></li>`).join("");
  const keyLink = provider.key_page ? `<a class="settings-link" href="${escapeHtml(provider.key_page)}" target="_blank" rel="noreferrer">打开 ${escapeHtml(provider.name)} Key 页面 ↗</a>` : "";
  dialog.innerHTML = `<div class="settings-card"><div class="settings-card-head"><div><span class="section-kicker">本地 API</span><h3 id="settingsDialogTitle">模型设置</h3></div><button id="closeSettingsButton" class="icon-button" type="button" aria-label="关闭模型设置">×</button></div><p class="settings-copy">模型配置只从后端环境读取，不会通过页面写入配置文件或浏览器 localStorage。</p><div class="settings-guide"><strong>推荐模型</strong><ul>${guide}</ul><p>优先使用 DeepSeek。当前真实流程会通过后端调用模型。</p>${keyLink}</div><div class="settings-status ${state.model?.configured && !fileMode ? "is-ready" : ""}"><span class="status-dot"></span>${status}</div><label class="settings-field"><span>服务商</span><select id="settingsProvider">${options}</select></label><label class="settings-field"><span>模型名称</span><input id="settingsModel" value="${escapeHtml(state.model?.model || provider.model || "")}" autocomplete="off" readonly /></label><label class="settings-field"><span>API Key</span><input id="settingsApiKey" type="password" value="${escapeHtml(state.model?.key_masked || "")}" placeholder="仅显示状态，不读取密钥" autocomplete="off" readonly /></label><label class="settings-field"><span>接口地址</span><input id="settingsBaseUrl" value="${escapeHtml(state.model?.base_url || provider.base_url || "")}" autocomplete="off" readonly /></label><div class="settings-actions"><button id="cancelSettingsButton" class="secondary-button" type="button">关闭</button><button id="saveSettingsButton" class="primary-button" type="button" disabled><span>由后端环境管理</span></button></div><p id="settingsMessage" class="settings-message" role="status"></p></div>`;
  dialog.classList.remove("hidden");
  $("#closeSettingsButton")?.addEventListener("click", () => dialog.classList.add("hidden"));
  $("#cancelSettingsButton")?.addEventListener("click", () => dialog.classList.add("hidden"));
  $("#settingsProvider")?.addEventListener("change", () => renderModelSettings($("#settingsProvider").value));
  $("#saveSettingsButton")?.addEventListener("click", saveModelSettings);
}

function saveModelSettings() {
  const message = $("#settingsMessage");
  if (message) message.textContent = "配置由后端环境管理。修改 backend/.env 后重启本地服务。";
}

async function loadProjects() {
  try {
    if (online) { loadSaved(); return; }
    const payload = await api("/api/v1/projects"); state.projects = payload.projects || [];
    const savedId = localStorage.getItem("ai-workbench-project"); if (!state.current && savedId) state.current = state.projects.find((project) => project.id === savedId) || null;
    render();
  } catch (error) { showError(error.message); }
}
async function loadProject(projectId) {
  try {
    state.creating = false;
    if (online) { state.current = state.projects.find((project) => project.id === projectId) || null; render(); return; }
    const payload = await api(`/api/v1/projects/${encodeURIComponent(projectId)}`); replaceProject(payload.project); localStorage.setItem("ai-workbench-project", projectId); render();
  } catch (error) { showError(error.message); }
}
async function createProject(event) {
  event.preventDefault(); const idea = $("#idea").value.trim(); if (idea.length < 3) { showError("先用一句话说清楚你想做什么"); return; }
  if (!canStartBuild()) { showError(state.modelUnavailable ? "开始搭建前，请先启动 backend/start.sh 并重新检查" : "开始搭建前，请先配置 backend/.env 里的 MODEL_API_KEY"); renderStartGate(); return; }
  const button = $("#startBuildButton"); button.disabled = true; clearError();
  try {
    if (online) {
      const project = { id: `p_${Date.now()}`, idea, version: 1, status: "idea", discovery_round: 0, questions: mockQuestions(idea, 0), answers: {}, events: [], created_at: now(), updated_at: now() };
      transition(project, "needs_discovery", { pending: project.questions.map((question) => question.id) });
      state.current = project; state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)]; persist();
    } else {
      const payload = await api("/api/v1/projects", { method: "POST", body: JSON.stringify({ idea }) });
      const workshop = await api(`/api/v1/projects/${encodeURIComponent(payload.project.id)}/workshop-resume`, { method: "POST" });
      replaceProject(workshop.project);
      localStorage.setItem("ai-workbench-project", workshop.project.id);
      await loadProjects();
    }
    $("#idea").value = ""; state.creating = false; render();
  } catch (error) { showError(error.message); if (error.status === 503) await loadModelStatus(); }
  button.disabled = false;
}
function currentAnswers() { return state.current?.answers || {}; }
async function submitAnswers() {
  const answers = {};
  document.querySelectorAll("#questionPanel:not(.hidden) [data-question-id], #planPanel:not(.hidden) [data-question-id]").forEach((input) => {
    const custom = input.closest("[data-question-card]")?.querySelector("[data-question-custom]")?.value.trim();
    const selected = input.value.trim();
    answers[input.dataset.questionId] = custom ? (selected ? `${selected}；补充：${custom}` : custom) : selected;
  });
  if (Object.values(answers).some((answer) => !answer)) { showError("还有一个关键问题没有回答"); return; }
  const button = $("#answerButton"); setActionBusy(button, "正在判断需求"); clearError();
  try {
    if (online) {
      Object.assign(state.current.answers, answers);
      const nextRound = Number(state.current.discovery_round ?? state.current.round ?? 0) + 1;
      const nextQuestions = mockQuestions(state.current.idea, nextRound, state.current.answers);
      state.current.discovery_round = nextRound;
      state.current.questions = nextQuestions;
      if (nextQuestions.length) transition(state.current, "needs_discovery", { pending: nextQuestions.map((question) => question.id), evidence: Object.entries(answers).map(([id, value]) => `${id}: ${value}`) });
      else { state.current.discovery = mockDiscovery(state.current); state.current.intent = mockIntent(state.current); transition(state.current, "needs_intent_confirmation", { evidence: Object.entries(answers).map(([id, value]) => `${id}: ${value}`) }); }
      persist();
    }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/answers`, { method: "POST", body: JSON.stringify({ answers }) }); replaceProject(payload.project); }
    render();
  } catch (error) { restoreAction(button); showError(error.message); }
}
async function continueDiscovery(project) {
  const button = $("#continueDiscoveryButton");
  setActionBusy(button, "正在准备下一轮");
  if (online) { project.discovery_round = Number(project.discovery_round ?? project.round ?? 0) + 1; project.questions = mockQuestions(project.idea, project.discovery_round, project.answers || {}); transition(project, "needs_discovery", { pending: project.questions.map((question) => question.id) }); persist(); render(); return; }
  try { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-intent`, { method: "POST", body: JSON.stringify({ confirmed: false, note: "需要补充或修正需求" }) }); replaceProject(payload.project); render(); }
  catch (error) { restoreAction(button); showError(error.message); }
}
function submitSupplement(project) {
  const value = $("#supplementInput")?.value.trim();
  if (!value) { showError("先写一条需要纳入判断的补充"); return; }
  const button = $("#submitSupplementButton");
  setActionBusy(button, "正在保存补充");
  if (online) {
    project.answers = project.answers || {};
    project.answers.additional_context = project.answers.additional_context ? `${project.answers.additional_context}\n${value}` : value;
    project.discovery = project.discovery || {};
    project.discovery.evidence = [...list(project.discovery.evidence), value];
    project.requirement_supplement = { status: "applied", text: value, at: now() };
    project.events = Array.isArray(project.events) ? project.events : [];
    project.events.push({ id: `evt_${Date.now()}_${project.events.length}`, from: "needs_intent_confirmation", to: "needs_intent_confirmation", actor: "user", input_version: project.version || 1, output_version: project.version || 1, evidence: [value], pending: [], at: now() });
    persist(); render(); return;
  }
  api(`/api/v1/projects/${encodeURIComponent(project.id)}/supplement`, { method: "POST", body: JSON.stringify({ text: value }) }).then((payload) => { replaceProject(payload.project); render(); }).catch((error) => { restoreAction(button); showError(error.message); });
}
async function confirmIntent(project) {
  clearError();
  const button = $("#confirmIntentButton");
  setActionBusy(button, "正在整理 PRD");
  const stopProgress = online ? () => {} : startPlanProgress(project);
  try {
    if (online) { project.plan = mockPlan(project); transition(project, "needs_plan_confirmation", { pending: project.plan.open_questions || [] }); persist(); }
    else {
      const input = $("#workshopDraft");
      const body = input && project.workshop ? { confirmed: true, draft: input.value } : { confirmed: true };
      const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-intent`, { method: "POST", body: JSON.stringify(body) });
      replaceProject(payload.project);
    }
    render();
  } catch (error) { restoreAction(button); render(); showError(error.message); }
  finally { stopProgress(); }
}
async function generateRealPlan() {
  const button = $("#realPlanButton"); button.disabled = true; clearError();
  try { const payload = online ? null : await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/real-plan`, { method: "POST", body: JSON.stringify({ answers: currentAnswers() }) }); if (payload) replaceProject(payload.project); render(); }
  catch (error) { showError(`${error.message}。真实模型失败不会覆盖当前方案。`); button.disabled = false; }
}
async function startBackendBuild(project) {
  const button = $("#startBackendButton");
  setActionBusy(button, "正在准备开发"); clearError();
  try {
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/build`, { method: "POST", body: JSON.stringify({ execution_mode: "real" }) });
    replaceProject(payload.project); render();
  } catch (error) {
    restoreAction(button); showError(error.message); render();
  }
}

async function confirmPlan(project, confirmed = true) {
  clearError();
  const button = $("#confirmPlanButton");
  setActionBusy(button, confirmed ? "正在进入后端开发" : "正在保存修改");
  try {
    if (online) { if (confirmed) { project.backend = mockBackend(project); transition(project, "backend_verified", { pending: project.backend.tests || [] }); } else { project.plan_revision = { status: "needs_input", prompt: "方案需要调整哪一处？", requested_at: now() }; transition(project, "needs_plan_confirmation", { pending: ["plan_revision"] }); } persist(); }
    else {
      const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-plan`, { method: "POST", body: JSON.stringify({ confirmed }) });
      replaceProject(payload.project);
      if (confirmed && payload.project?.backend?.status === "stage_task_ready") {
        await startBackendBuild(payload.project);
        return;
      }
    }
    render();
  } catch (error) { restoreAction(button); showError(error.message); }
}
async function createNextVersion(project) {
  if (!canCreateNextVersion(project)) { showError("请先记录一次试用结果，再开启下一版"); render(); return; }
  const input = $("#newRequirementInput"); const change = input?.value.trim();
  if (!change) { showError("先说清楚这次要新增或改变什么"); return; }
  const button = $("#createVersionButton"); if (button) button.disabled = true; clearError();
  try {
    if (online) {
      const version = Number(project.version || 1) + 1;
      const next = { id: `p_${Date.now()}`, parent_id: project.id, root_id: project.root_id || project.id, version, idea: project.idea, change_request: change, status: "idea", discovery_round: 0, questions: [], answers: { change_request: change }, discovery: {}, intent: {}, plan: null, backend: null, events: [], created_at: now(), updated_at: now() };
      next.questions = mockQuestions(next.idea, 0, next.answers, change);
      transition(next, "needs_discovery", { evidence: [change], pending: next.questions.map((question) => question.id) });
      project.new_requirement_draft = false;
      state.current = next; state.projects = [next, ...state.projects]; persist(); render();
    } else {
      const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/iterations`, { method: "POST", body: JSON.stringify({ change_request: change }) });
      replaceProject(payload.project); render();
    }
  } catch (error) { showError(error.message); if (button) button.disabled = false; }
}
async function acceptBuild(project) {
  clearError();
  const button = $("#acceptanceButton");
  setActionBusy(button, "正在保存验收");
  try {
    if (online) { transition(project, "preview_ready", { pending: [] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/acceptance`, { method: "POST", body: JSON.stringify({ passed: true }) }); replaceProject(payload.project); }
    render();
  } catch (error) { restoreAction(button); showError(error.message); }
}

async function startTrial(project) {
  if (!canStartTrial(project)) {
    showError(online ? "请先查看示例，再开始试用" : "请先完成预览验证，再开始试用");
    render();
    return;
  }
  clearError();
  const button = $("#startTrialButton");
  setActionBusy(button, "正在进入试用");
  try {
    if (online) { project.trial = { status: "active", outcome: "", feedback: [], started_at: now(), updated_at: now() }; transition(project, "trial", { pending: ["trial_feedback"] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/trial`, { method: "POST", body: JSON.stringify({}) }); replaceProject(payload.project); }
    render();
  } catch (error) { restoreAction(button); showError(error.message); }
}

async function submitTrialFeedback(project) {
  if (!canSubmitTrialFeedback(project)) { showError("请先开始试用，再记录反馈"); render(); return; }
  const input = $("#trialFeedbackInput"); const feedback = input?.value.trim(); const outcome = $("#trialOutcome")?.value || "needs_change";
  if (!feedback) { showError("先写一条真实试用反馈"); return; }
  const button = $("#submitTrialFeedbackButton"); if (button) button.disabled = true; clearError();
  try {
    if (online) { project.trial = project.trial || { status: "active", outcome: "", feedback: [], started_at: now(), updated_at: now() }; project.trial.feedback = [...list(project.trial.feedback), feedback]; project.trial.outcome = outcome; project.trial.updated_at = now(); transition(project, "trial", { evidence: [feedback], pending: [] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/trial-feedback`, { method: "POST", body: JSON.stringify({ feedback, outcome }) }); replaceProject(payload.project); }
    render();
  } catch (error) { showError(error.message); if (button) button.disabled = false; }
}

async function openPreview(project) {
  let previewWindow = null;
  const button = $("#openPreviewButton");
  setActionBusy(button, "正在验证预览");
  try {
    if (online) { markMockExampleViewed(project); persist(); render(); return; }
    previewWindow = window.open("about:blank", "_blank");
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview/verify`, { method: "POST" });
    replaceProject(payload.project); render();
    if (payload.preview?.url) {
      if (previewWindow) previewWindow.location.href = payload.preview.url;
      else window.location.href = payload.preview.url;
    } else if (previewWindow) previewWindow.close();
  } catch (error) { if (previewWindow) previewWindow.close(); restoreAction(button); showError(error.message); }
}

function mockQuestions(idea, round, answers = {}, changeRequest = "") {
  const catalog = [
    { id: "target_user", text: "最先服务哪一类具体的人？", hint: "选最接近的一项即可", reason: "决定第一版服务谁", options: QUESTION_OPTION_CATALOG.target_user },
    { id: "problem", text: "他们现在最需要解决哪一种问题？", hint: "选最接近的一项即可", reason: "区分真实需求和想象", options: QUESTION_OPTION_CATALOG.problem },
    { id: "desired_outcome", text: "用户完成一次使用后必须得到什么结果？", hint: "选最接近的一项即可", reason: "决定核心闭环与验收", options: QUESTION_OPTION_CATALOG.desired_outcome },
    { id: "current_workaround", text: "用户现在通常怎么解决？", hint: "选最接近的一项即可", reason: "判断机会是否真实", options: QUESTION_OPTION_CATALOG.current_workaround }
  ];
  if (changeRequest && !answers.affected_area) catalog.unshift({ id: "affected_area", text: "这次新增会改变原产品的哪一段？", hint: "选最接近的一项即可", reason: "只重算受影响的链路", options: QUESTION_OPTION_CATALOG.affected_area });
  const missing = catalog.filter((question) => !answers[question.id]);
  if (/支付|医疗|健康|儿童|隐私|数据/.test(idea) && !answers.constraints) missing.push({ id: "constraints", text: "有哪些不能碰的边界？例如数据、平台、成本或权限。", hint: "选最接近的一项即可", reason: "避免方案越过约束", options: QUESTION_OPTION_CATALOG.constraints });
  return missing.slice(0, Math.min(3, missing.length));
}
function mockDiscovery(project) { const a = project.answers || {}; return { target_user: a.target_user, problem: a.problem, desired_outcome: a.desired_outcome, evidence: [a.problem].filter(Boolean), red_flags: ["证据仍来自当前输入，真实用户验证待完成"], open_questions: ["是否需要导入外部访谈或链接材料？"] }; }
function mockIntent(project) { const a = project.answers || {}; return { goal: `帮助${a.target_user || "目标用户"}${a.desired_outcome || "完成关键任务"}`, target_user: a.target_user || "待确认", core_loop: `输入需求 → 明确问题 → ${a.desired_outcome || "得到可验证结果"} → 用户确认`, scope: ["需求发现", "需求确认", "方案确认", "后端 API 与测试", "产品预览"], acceptance: ["用户能看懂当前需求判断", "用户确认方案后才进入开发", "后端测试和预览结果可查看", "刷新或重启后项目仍可继续"], constraints: ["首版本地单用户", "未经确认不外发或发布"], risks: ["需求证据仍需真实用户验证"] }; }
function mockPlan(project) { const intent = projectIntent(project); return { title: project.idea.slice(0, 32), summary: intent.goal, user_journey: ["说出想法", "澄清需求", "确认方案", "生成后端", "验收示例"], mvp_features: ["需求发现与红灯提示", "内部需求确认", "方案确认闸门", "API 与数据契约", "测试与示例"], generated_stack: ["FastAPI API", "Pydantic 数据契约", "可恢复任务状态", "结构化测试"], preview_label: "产品示例 · mock", open_questions: ["真实用户样例验证"] }; }
function mockBackend(project) { return { api_contract: ["创建与读取项目", "提交多轮需求回答", "确认需求与方案", "后端开发状态与验收"], api: ["/api/v1/projects", "/confirm-intent", "/confirm-plan", "/acceptance"], tasks: ["生成 API 和数据契约", "建立项目状态持久化", "运行结构化接口测试", "生成可打开的预览"], tests: ["关键链路测试通过", "重启恢复待验证", "预览入口已生成"], acceptance: projectIntent(project).acceptance }; }
const ONLINE_STORAGE_SCHEMA_VERSION = "2";
const LEGACY_STATUS_MIGRATIONS = { idea: "needs_discovery", needs_clarification: "needs_discovery", requirements_confirmed: "needs_intent_confirmation", plan_draft: "needs_plan_confirmation", plan_ready: "needs_plan_confirmation", accepted: "preview_ready" };
function normalizeSavedProject(project) {
  if (!project || typeof project !== "object") return null;
  const normalized = { ...project };
  let changed = false;
  const nextStatus = LEGACY_STATUS_MIGRATIONS[normalized.status];
  if (nextStatus && nextStatus !== normalized.status) { normalized.status = nextStatus; changed = true; }
  if (!Number.isInteger(normalized.discovery_round) && Number.isInteger(normalized.round)) { normalized.discovery_round = Math.max(0, normalized.round); changed = true; }
  if ("round" in normalized) { delete normalized.round; changed = true; }
  if (!normalized.backend && normalized.engineering && typeof normalized.engineering === "object") { normalized.backend = normalized.engineering; changed = true; }
  if ("engineering" in normalized) { delete normalized.engineering; changed = true; }
  if (normalized.answers && normalized.answers.core_action && !normalized.answers.desired_outcome) { normalized.answers = { ...normalized.answers, desired_outcome: normalized.answers.core_action }; changed = true; }
  if ("accepted" in normalized) { delete normalized.accepted; changed = true; }
  return { project: normalized, changed };
}
function persist() { localStorage.setItem("ai-workbench-online-preview-projects", JSON.stringify(state.projects)); localStorage.setItem("ai-workbench-online-preview-current", state.current?.id || ""); localStorage.setItem("ai-workbench-online-preview-schema", ONLINE_STORAGE_SCHEMA_VERSION); }
function loadSaved() { let saved; let parsed = true; try { saved = JSON.parse(localStorage.getItem("ai-workbench-online-preview-projects") || "[]"); } catch (_) { saved = []; parsed = false; } const migrated = parsed && Array.isArray(saved) ? saved.map(normalizeSavedProject).filter(Boolean) : []; state.projects = migrated.map((entry) => entry.project); const currentId = localStorage.getItem("ai-workbench-online-preview-current"); state.current = state.projects.find((project) => project.id === currentId) || state.projects[0] || null; if (parsed && Array.isArray(saved) && (localStorage.getItem("ai-workbench-online-preview-schema") !== ONLINE_STORAGE_SCHEMA_VERSION || migrated.some((entry) => entry.changed))) persist(); render(); }
async function mockApi() { throw new Error("在线演示不调用本地 API，请按页面按钮体验完整流程"); }

$("#ideaForm").addEventListener("submit", createProject);
$("#offlineExampleButton").addEventListener("click", () => { window.location.href = `${window.location.pathname}?mode=offline-demo`; });
$("#settingsButton")?.addEventListener("click", () => renderModelSettings());
$("#helpButton").addEventListener("click", () => { state.helpOpen = !state.helpOpen; render(); });
$("#showNewProjectButton").addEventListener("click", () => { state.creating = true; setNavigationOpen(false); render(); $("#idea").focus(); });
$("#cancelNewProjectButton")?.addEventListener("click", () => { state.creating = false; render(); });
$("#refreshButton").addEventListener("click", () => online ? loadSaved() : loadProjects());
Promise.all([loadModelStatus(), loadProjects()]);


// Visual navigation only: no project, persistence or workflow mutations.
function setNavigationOpen(open, restoreFocus = false) {
  const shell = $("#workbenchShell");
  const trigger = $("#openNavigationButton");
  const navigation = $("#projectNavigation");
  const backdrop = $("#navBackdrop");
  if (!shell || !trigger || !navigation || !backdrop) return;
  shell.classList.toggle("nav-open", open);
  trigger.setAttribute("aria-expanded", String(open));
  backdrop.hidden = !open;
  if (window.matchMedia?.("(max-width: 800px)").matches) {
    navigation.inert = !open;
    document.body.style.overflow = open ? "hidden" : "";
  }
  if (open) $("#closeNavigationButton")?.focus();
  else if (restoreFocus) trigger.focus();
}
$("#openNavigationButton")?.addEventListener("click", () => setNavigationOpen(true));
$("#closeNavigationButton")?.addEventListener("click", () => setNavigationOpen(false, true));
$("#navBackdrop")?.addEventListener("click", () => setNavigationOpen(false, true));
document.addEventListener("keydown", (event) => {
  const shell = $("#workbenchShell");
  if (!shell?.classList.contains("nav-open")) return;
  if (event.key === "Escape") { event.preventDefault(); setNavigationOpen(false, true); }
  if (event.key === "Tab") {
    const controls = [...$("#projectNavigation").querySelectorAll('a[href], button:not(:disabled)')].filter((node) => node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
const navigationMedia = window.matchMedia?.("(max-width: 800px)");
function syncNavigationViewport() {
  setNavigationOpen(false);
  const navigation = $("#projectNavigation");
  if (navigation) navigation.inert = Boolean(navigationMedia?.matches);
  if (document.body) document.body.style.overflow = "";
}
navigationMedia?.addEventListener("change", syncNavigationViewport);
syncNavigationViewport();
document.querySelectorAll("[data-idea-prompt]").forEach((button) => {
  button.addEventListener("click", () => { const input = $("#idea"); if (input) { input.value = button.dataset.ideaPrompt; input.focus(); } });
});
$("#helpButton")?.addEventListener("click", () => { if (state.helpOpen) $("#welcomeGuide")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
