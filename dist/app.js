const state = { projects: [], current: null, model: null, modelUnavailable: false, creating: false, helpOpen: false };
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
    can_build: Boolean(src.can_build)
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
  gate.classList.remove("hidden");
  if (state.model.configured) {
    gate.innerHTML = "<strong>AI 服务已配置</strong><span>搭建会使用后端配置的模型。Key 不会进入浏览器，这里也不会回显密钥。</span>";
  } else {
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
        ? "AI 服务已经配置好，可以直接开始真实搭建；Key 只保存在后端，不会进入浏览器。"
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
  if (status === "needs_discovery") renderDiscovery(project);
  else if (status === "needs_intent_confirmation") renderRequirements(project);
  else if (status === "needs_plan_confirmation") renderPlanConfirmation(project);
  else if (status === "backend_building") renderBackend(project, false);
  else if (status === "backend_verified" || status === "preview_ready") renderBackend(project, true);
  else if (status === "trial") renderTrial(project);
  else renderUnknownStatus(project);
  renderProjects();
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

function renderDiscovery(project) {
  showOnly("#questionPanel");
  const questions = list(project.questions);
  const round = Math.max(1, Number(project.discovery_round ?? project.round ?? 0) + 1);
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">需求发现 · 第 ${round} 轮${project.version > 1 ? ` · V${project.version}` : ""}</span><h3>先把需求说准</h3></div><span class="status-chip is-progress">${escapeHtml(project.idea.slice(0, 22))}</span></div><p class="panel-copy">这一轮只问会改变产品方向的问题。回答后，系统会判断还缺不缺信息；需要时会继续追问，不会把固定题数当成完成标准。${project.change_request ? `本次新增：${escapeHtml(project.change_request)}` : ""}</p><div class="question-list">${questions.map((question) => `<div class="question-card"><label for="answer-${escapeHtml(question.id)}">${escapeHtml(question.text)}</label><input id="answer-${escapeHtml(question.id)}" data-question-id="${escapeHtml(question.id)}" value="${escapeHtml(project.answers?.[question.id] || "")}" placeholder="${escapeHtml(question.hint || "用自己的话回答即可")}" autocomplete="off" /><small>${escapeHtml(question.reason || "这会影响需求、范围或验收")}</small></div>`).join("")}</div><div class="panel-actions"><button class="primary-button" id="answerButton" type="button"><span>记录回答，继续判断</span><span class="button-arrow">↗</span></button></div>`;
  $("#answerButton").addEventListener("click", submitAnswers);
}

function renderRequirements(project) {
  showOnly("#questionPanel");
  const intent = projectIntent(project); const discovery = projectDiscovery(project);
  const supplement = project.requirement_supplement?.status === "needs_input";
  const supplementBox = supplement ? `<div class="supplement-box"><div class="section-kicker">补充信息</div><h4>补充一条会改变判断的信息</h4><p>可以补充事实、约束或必须纳入的用户场景；提交后仍停留在需求确认。</p><textarea id="supplementInput" aria-label="补充需求信息" placeholder="例如：已有 5 次访谈都提到需要导入原始记录"></textarea><div class="panel-actions"><button class="secondary-button" id="skipSupplementButton" type="button">无需补充</button><button class="primary-button" id="submitSupplementButton" type="button"><span>提交补充</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">需求确认</span><h3>先确认需求判断</h3></div><span class="status-chip is-confirm">等你确认</span></div><p class="panel-copy">这不是长篇 PRD。请确认下面的用户、问题、证据和风险是否准确；确认后才会进入方案设计。</p><div class="plan-grid"><div class="plan-block"><h4>用户与目标</h4><p>${escapeHtml(intent.target_user || discovery.target_user || "待确认")}<br />${escapeHtml(intent.goal || discovery.problem || "待确认")}</p></div><div class="plan-block"><h4>证据与假设</h4><ul>${listHtml(discovery.evidence || discovery.facts, ["当前暂无外部证据，先按假设记录"])}</ul></div><div class="plan-block"><h4>核心结果</h4><p>${escapeHtml(intent.core_loop || discovery.desired_outcome || "待确认")}</p></div><div class="plan-block"><h4>红灯与待验证</h4><ul>${listHtml(discovery.red_flags || discovery.open_questions, ["暂无红灯；真实用户验证仍待完成"])}</ul></div></div>${supplementBox}<div class="panel-actions"><button class="secondary-button" id="continueDiscoveryButton" type="button">我还要补充</button><button class="primary-button" id="confirmIntentButton" type="button"><span>确认需求，进入方案</span><span class="button-arrow">↗</span></button></div>`;
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
  const configured = state.model?.configured;
  const modelHint = configured ? "已配置真实模型；可主动重生成方案" : "真实模型尚未配置，当前只能继续使用本地结构化方案";
  const modelButton = configured
    ? `<button class="secondary-button" id="realPlanButton" type="button">使用真实模型重生成</button>`
    : `<button class="secondary-button" id="realPlanButton" type="button" disabled title="当前未配置真实模型">真实模型未配置</button>`;
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">方案确认</span><h3>${escapeHtml(plan.title || project.idea)}</h3></div><span class="status-chip is-confirm">${escapeHtml(sourceLabel(project))}</span></div><p class="panel-copy">方案是后端开发的输入。确认前不会生成开发任务，也不会自动发布或外发。</p><div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${escapeHtml(plan.summary || intent.goal || "待生成")}</p></div><div class="plan-block"><h4>核心闭环</h4><p>${escapeHtml(intent.core_loop || "待补充")}</p></div><div class="plan-block"><h4>MVP 范围</h4><ul>${listHtml(plan.mvp_features || plan.scope)}</ul></div><div class="plan-block"><h4>验收标准</h4><ul>${listHtml(intent.acceptance)}</ul></div></div><div class="panel-actions">${modelButton}<button class="secondary-button" id="modifyPlanButton" type="button">方案需要修改</button><button class="primary-button" id="confirmPlanButton" type="button"><span>确认方案，开始后端开发</span><span class="button-arrow">↗</span></button></div><div class="stage-note">${modelHint}</div>`;
  $("#confirmPlanButton").addEventListener("click", () => confirmPlan(project, true));
  $("#modifyPlanButton").addEventListener("click", () => confirmPlan(project, false));
  $("#realPlanButton").addEventListener("click", generateRealPlan);
}

function renderBackend(project, verified) {
  showOnly("#previewPanel");
  const backend = projectBackend(project); const tasks = list(project.tasks);
  const checks = backend.verification || backend.tests || backend.checks || [];
  const stage = previewStageView(project);
  const previewReady = stage.previewReady;
  const previewLabel = stage.previewLabel;
  const previewState = stage.previewState;
  const preview = project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${escapeHtml(previewReady ? previewLabel : project.plan.preview_label || "产品示例")}</span><span>${escapeHtml(previewReady ? previewState : verified ? "等你确认" : "后端开发中")}</span></div><div class="preview-body"><h4>${escapeHtml(project.plan.title || project.idea)}</h4><p>${escapeHtml(project.plan.summary || "方案正在生成")}</p><span class="preview-cta">${escapeHtml(project.answers?.desired_outcome || project.answers?.core_action || (online ? "查看示例结果" : "打开运行时预览"))} ↗</span></div></div>` : "";
  const title = previewReady ? stage.title : verified ? "后端已生成，等你验收" : "正在生成后端与测试";
  const headingKicker = previewReady ? "产品预览" : verified ? "后端验收" : "后端开发";
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
      : '<button class="primary-button" id="refreshBuildButton" type="button"><span>刷新开发状态</span></button>';
  const panelCopy = previewReady ? stage.copy : "这里展示 API、数据模型、测试和运行时结果。验收通过只代表进入产品预览，不代表预览已经验证。";
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

window.__workbenchUi = { pickModelStatus, statusOf, statusLabel, phaseForStatus, resultKind, chipText, taskCopy, isPreviewVerified, isMockExampleViewed, markMockExampleViewed, previewStageView, hasTrialFeedback, isPlanRevising, isKnownStatus, isUnknownProject, canStartBuild, canStartTrial, canSubmitTrialFeedback, canCreateNextVersion };

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
  renderStartGate(); renderWelcomeGuide();
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
    } else { const payload = await api("/api/v1/projects", { method: "POST", body: JSON.stringify({ idea }) }); state.current = payload.project; localStorage.setItem("ai-workbench-project", state.current.id); await loadProjects(); }
    $("#idea").value = ""; state.creating = false; render();
  } catch (error) { showError(error.message); if (error.status === 503) await loadModelStatus(); }
  button.disabled = false;
}
function currentAnswers() { return state.current?.answers || {}; }
async function submitAnswers() {
  const answers = {}; document.querySelectorAll("[data-question-id]").forEach((input) => { answers[input.dataset.questionId] = input.value.trim(); });
  if (Object.values(answers).some((answer) => !answer)) { showError("还有一个关键问题没有回答"); return; }
  const button = $("#answerButton"); button.disabled = true; clearError();
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
  } catch (error) { showError(error.message); button.disabled = false; }
}
async function continueDiscovery(project) {
  if (online) { project.discovery_round = Number(project.discovery_round ?? project.round ?? 0) + 1; project.questions = mockQuestions(project.idea, project.discovery_round, project.answers || {}); transition(project, "needs_discovery", { pending: project.questions.map((question) => question.id) }); persist(); render(); return; }
  try { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-intent`, { method: "POST", body: JSON.stringify({ confirmed: false, note: "需要补充或修正需求" }) }); replaceProject(payload.project); render(); }
  catch (error) { showError(error.message); }
}
function submitSupplement(project) {
  const value = $("#supplementInput")?.value.trim();
  if (!value) { showError("先写一条需要纳入判断的补充"); return; }
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
  api(`/api/v1/projects/${encodeURIComponent(project.id)}/supplement`, { method: "POST", body: JSON.stringify({ text: value }) }).then((payload) => { replaceProject(payload.project); render(); }).catch((error) => showError(error.message));
}
async function confirmIntent(project) {
  clearError();
  try {
    if (online) { project.plan = mockPlan(project); transition(project, "needs_plan_confirmation", { pending: project.plan.open_questions || [] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-intent`, { method: "POST", body: JSON.stringify({ confirmed: true }) }); replaceProject(payload.project); }
    render();
  } catch (error) { showError(error.message); }
}
async function generateRealPlan() {
  const button = $("#realPlanButton"); button.disabled = true; clearError();
  try { const payload = online ? null : await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/real-plan`, { method: "POST", body: JSON.stringify({ answers: currentAnswers() }) }); if (payload) replaceProject(payload.project); render(); }
  catch (error) { showError(`${error.message}。真实模型失败不会覆盖当前方案。`); button.disabled = false; }
}
async function confirmPlan(project, confirmed = true) {
  clearError();
  try {
    if (online) { if (confirmed) { project.backend = mockBackend(project); transition(project, "backend_verified", { pending: project.backend.tests || [] }); } else { project.plan_revision = { status: "needs_input", prompt: "方案需要调整哪一处？", requested_at: now() }; transition(project, "needs_plan_confirmation", { pending: ["plan_revision"] }); } persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/confirm-plan`, { method: "POST", body: JSON.stringify({ confirmed }) }); replaceProject(payload.project); }
    render();
  } catch (error) { showError(error.message); }
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
  try {
    if (online) { transition(project, "preview_ready", { pending: [] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/acceptance`, { method: "POST", body: JSON.stringify({ passed: true }) }); replaceProject(payload.project); }
    render();
  } catch (error) { showError(error.message); }
}

async function startTrial(project) {
  if (!canStartTrial(project)) {
    showError(online ? "请先查看示例，再开始试用" : "请先完成预览验证，再开始试用");
    render();
    return;
  }
  clearError();
  try {
    if (online) { project.trial = { status: "active", outcome: "", feedback: [], started_at: now(), updated_at: now() }; transition(project, "trial", { pending: ["trial_feedback"] }); persist(); }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/trial`, { method: "POST", body: JSON.stringify({}) }); replaceProject(payload.project); }
    render();
  } catch (error) { showError(error.message); }
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
  try {
    if (online) { markMockExampleViewed(project); persist(); render(); return; }
    previewWindow = window.open("about:blank", "_blank");
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview/verify`, { method: "POST" });
    replaceProject(payload.project); render();
    if (payload.preview?.url) {
      if (previewWindow) previewWindow.location.href = payload.preview.url;
      else window.location.href = payload.preview.url;
    } else if (previewWindow) previewWindow.close();
  } catch (error) { if (previewWindow) previewWindow.close(); showError(error.message); }
}

function mockQuestions(idea, round, answers = {}, changeRequest = "") {
  const catalog = [
    { id: "target_user", text: "最先服务哪一类具体的人？", hint: "例如：第一次做产品的个人创作者", reason: "决定第一版服务谁" },
    { id: "problem", text: "他们现在遇到的具体问题是什么？", hint: "描述一个真实场景，不用写解决方案", reason: "区分真实需求和想象" },
    { id: "desired_outcome", text: "用户完成一次使用后必须得到什么结果？", hint: "用一个可观察的结果描述", reason: "决定核心闭环与验收" },
    { id: "current_workaround", text: "用户现在用什么办法解决？为什么还不够好？", hint: "没有现成办法可以填：目前没有", reason: "判断机会是否真实" }
  ];
  if (changeRequest && !answers.affected_area) catalog.unshift({ id: "affected_area", text: "这次新增会改变原产品的哪一段？", hint: "例如：只影响预览，不改变需求确认", reason: "只重算受影响的链路" });
  const missing = catalog.filter((question) => !answers[question.id]);
  if (/支付|医疗|健康|儿童|隐私|数据/.test(idea) && !answers.constraints) missing.push({ id: "constraints", text: "有哪些不能碰的边界？例如数据、平台、成本或权限。", hint: "不知道可以填：暂无", reason: "避免方案越过约束" });
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
