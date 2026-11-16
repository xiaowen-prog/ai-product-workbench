const state = { projects: [], current: null, model: null };
const online = Boolean(window.__ONLINE_PREVIEW__);
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function showError(message) { const panel = $("#errorPanel"); panel.textContent = message; panel.classList.remove("hidden"); }
function clearError() { $("#errorPanel").classList.add("hidden"); }
function statusOf(project) { return project?.status || "idea"; }
function statusLabel(status) {
  return {
    idea: "等待开始", needs_clarification: "需求发现", needs_discovery: "需求发现",
    needs_intent_confirmation: "待确认需求", requirements_confirmed: "需求已确认",
    plan_draft: "待确认方案", needs_plan_confirmation: "待确认方案", plan_ready: "方案已确认",
    backend_building: "后端开发中", backend_verified: "等你验收", preview_ready: "示例可查看", accepted: "已完成"
  }[status] || "进行中";
}
function sourceLabel(project) { return project?.tasks?.some((task) => task.kind === "generate_plan_real" && task.status === "succeeded") ? "真实模型方案" : "本地结构化方案 · mock"; }
function phaseForStatus(status) {
  if (["needs_clarification", "needs_discovery"].includes(status)) return 1;
  if (["needs_intent_confirmation", "requirements_confirmed"].includes(status)) return 2;
  if (["plan_draft", "needs_plan_confirmation", "plan_ready"].includes(status)) return 3;
  if (status === "preview_ready" || status === "accepted") return 5;
  return 4;
}
function setFlow(step, project) {
  const labels = ["想法", "需求发现", "需求确认", "方案确认", "后端验收"];
  [...document.querySelectorAll(".flow-item")].forEach((item, index) => {
    item.classList.toggle("active", index === step && step < labels.length);
    item.classList.toggle("done", index < step);
    const stateEl = item.querySelector(".flow-state");
    if (stateEl) stateEl.textContent = index < step || step >= labels.length ? "完成" : index === step ? "现在" : "等待";
  });
  const version = project?.version > 1 ? ` · V${project.version}` : "";
  $("#phaseLabel").textContent = step >= labels.length ? `已完成${version}` : `阶段 0${step + 1} · ${labels[step]}${version}`;
}
function syncEntry(project) {
  const form = $("#ideaForm"); const bar = $("#newProjectBar");
  const kicker = $("#entryKicker"); const title = $("#entryTitle");
  if (!form || !bar) return;
  if (!project) {
    form.classList.remove("hidden"); bar.classList.add("hidden");
    if (kicker) kicker.textContent = "START HERE";
    if (title) title.textContent = "你想做什么？";
    return;
  }
  form.classList.add("hidden"); bar.classList.remove("hidden");
  if (kicker) kicker.textContent = "CURRENT TASK";
  if (title) title.textContent = "当前任务";
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
  if (!state.projects.length) { listEl.innerHTML = '<div class="empty-projects">还没有项目<br /><span>从左侧输入一句话开始</span></div>'; return; }
  listEl.innerHTML = state.projects.map((project) => `<button class="project-item ${state.current?.id === project.id ? "selected" : ""}" data-project-id="${escapeHtml(project.id)}" type="button"><strong>${escapeHtml(project.idea)}${escapeHtml(versionLabel(project))}</strong><small>${statusLabel(statusOf(project))}${project.parent_id ? " · 由上一版迭代" : ""}</small></button>`).join("");
  listEl.querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", () => loadProject(button.dataset.projectId)));
}

function render() {
  clearError();
  const project = state.current;
  syncEntry(project);
  if (!project) { showOnly(); setFlow(0, null); renderProjects(); return; }
  const status = statusOf(project);
  setFlow(phaseForStatus(status), project);
  if (["needs_clarification", "needs_discovery"].includes(status)) renderDiscovery(project);
  else if (["needs_intent_confirmation", "requirements_confirmed"].includes(status)) renderRequirements(project);
  else if (["plan_draft", "needs_plan_confirmation", "plan_ready"].includes(status)) renderPlanConfirmation(project);
  else if (status === "backend_building") renderBackend(project, false);
  else renderBackend(project, true);
  renderProjects();
}

function renderDiscovery(project) {
  showOnly("#questionPanel");
  const questions = list(project.questions);
  const round = Math.max(1, Number(project.round ?? project.discovery_round ?? 0) + 1);
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">DISCOVERY · ROUND ${round}${project.version > 1 ? ` · V${project.version}` : ""}</span><h3>先把需求说准</h3></div><span class="phase-label">${escapeHtml(project.idea.slice(0, 22))}</span></div><p class="panel-copy">这一轮只问会改变产品方向的问题。回答后，系统会判断还缺不缺信息；需要时会继续追问，不会把固定题数当成完成标准。${project.change_request ? `本次新增：${escapeHtml(project.change_request)}` : ""}</p><div class="question-list">${questions.map((question) => `<div class="question-card"><label for="answer-${escapeHtml(question.id)}">${escapeHtml(question.text)}</label><input id="answer-${escapeHtml(question.id)}" data-question-id="${escapeHtml(question.id)}" value="${escapeHtml(project.answers?.[question.id] || "")}" placeholder="${escapeHtml(question.hint || "用自己的话回答即可")}" autocomplete="off" /><small>${escapeHtml(question.reason || "这会影响需求、范围或验收")}</small></div>`).join("")}</div><div class="panel-actions"><button class="primary-button" id="answerButton" type="button"><span>记录回答，继续判断</span><span class="button-arrow">↗</span></button></div>`;
  $("#answerButton").addEventListener("click", submitAnswers);
}

function renderRequirements(project) {
  showOnly("#questionPanel");
  const intent = projectIntent(project); const discovery = projectDiscovery(project);
  const supplement = project.requirement_supplement?.status === "needs_input";
  const supplementBox = supplement ? `<div class="supplement-box"><div class="section-kicker">ADD CONTEXT</div><h4>补充一条会改变判断的信息</h4><p>可以补充事实、约束或必须纳入的用户场景；提交后仍停留在需求确认。</p><textarea id="supplementInput" placeholder="例如：已有 5 次访谈都提到需要导入原始记录"></textarea><div class="panel-actions"><button class="secondary-button" id="skipSupplementButton" type="button">无需补充</button><button class="primary-button" id="submitSupplementButton" type="button"><span>提交补充</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">REQUIREMENT CONFIRMATION</span><h3>先确认需求判断</h3></div><span class="phase-label">待你确认</span></div><p class="panel-copy">这不是长篇 PRD。请确认下面的用户、问题、证据和风险是否准确；确认后才会进入方案设计。</p><div class="plan-grid"><div class="plan-block"><h4>用户与目标</h4><p>${escapeHtml(intent.target_user || discovery.target_user || "待确认")}<br />${escapeHtml(intent.goal || discovery.problem || "待确认")}</p></div><div class="plan-block"><h4>证据与假设</h4><ul>${listHtml(discovery.evidence || discovery.facts, ["当前暂无外部证据，先按假设记录"])}</ul></div><div class="plan-block"><h4>核心结果</h4><p>${escapeHtml(intent.core_loop || discovery.desired_outcome || "待确认")}</p></div><div class="plan-block"><h4>红灯与待验证</h4><ul>${listHtml(discovery.red_flags || discovery.open_questions, ["暂无红灯；真实用户验证仍待完成"])}</ul></div></div>${supplementBox}<div class="panel-actions"><button class="secondary-button" id="continueDiscoveryButton" type="button">我还要补充</button><button class="primary-button" id="confirmIntentButton" type="button"><span>确认需求，进入方案</span><span class="button-arrow">↗</span></button></div>`;
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
    $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">PLAN REVISION</span><h3>告诉我方案哪里要改</h3></div><span class="phase-label">仍在方案确认</span></div><p class="panel-copy">这里只修改方案，不会把你拉回需求发现，也不会重新回答旧问题。</p><div class="question-list"><div class="question-card"><label for="answer-plan-correction">${escapeHtml(correction.prompt || "方案需要调整哪一处？")}</label><input id="answer-plan-correction" placeholder="用自己的话描述修改" autocomplete="off" /></div></div><div class="panel-actions"><button class="primary-button" id="planCorrectionButton" type="button"><span>更新方案</span><span class="button-arrow">↗</span></button></div>`;
    $("#planCorrectionButton").addEventListener("click", async () => {
      const value = $("#answer-plan-correction").value.trim(); if (!value) { showError("先说清楚要改哪一处"); return; }
      try { if (online) { project.plan.summary = `${project.plan.summary}（用户补充调整：${value}）`; project.plan_revision = { status: "applied", note: value, applied_at: now() }; project.events = Array.isArray(project.events) ? project.events : []; project.events.push({ id: `evt_${Date.now()}_${project.events.length}`, from: "plan_draft", to: "plan_draft", actor: "user", input_version: project.version || 1, output_version: project.version || 1, evidence: [value], pending: [], at: now() }); persist(); } else { const payload = await postCandidates(project.id, ["/modify-plan", "/plan/modify"], { note: value }); state.current = payload.project; } render(); }
      catch (error) { showError(error.message); }
    });
    return;
  }
  const configured = state.model?.configured;
  const modelHint = configured ? `已配置 ${escapeHtml(state.model.model)}；可主动重生成方案` : "真实模型尚未配置，当前只能继续使用本地结构化方案";
  const modelButton = configured ? `<button class="secondary-button" id="realPlanButton" type="button">使用真实模型重生成</button>` : `<button class="secondary-button" id="realPlanButton" type="button" disabled title="当前未配置真实模型">真实模型未配置</button>`;
  $("#planPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">PLAN CONFIRMATION</span><h3>${escapeHtml(plan.title || project.idea)}</h3></div><span class="phase-label">${escapeHtml(sourceLabel(project))}</span></div><p class="panel-copy">方案是后端开发的输入。确认前不会生成开发任务，也不会自动发布或外发。</p><div class="plan-grid"><div class="plan-block"><h4>产品定位</h4><p>${escapeHtml(plan.summary || intent.goal || "待生成")}</p></div><div class="plan-block"><h4>核心闭环</h4><p>${escapeHtml(intent.core_loop || "待补充")}</p></div><div class="plan-block"><h4>MVP 范围</h4><ul>${listHtml(plan.mvp_features || plan.scope)}</ul></div><div class="plan-block"><h4>验收标准</h4><ul>${listHtml(intent.acceptance)}</ul></div></div><div class="panel-actions">${modelButton}<button class="primary-button" id="confirmPlanButton" type="button"><span>确认方案，开始后端开发</span><span class="button-arrow">↗</span></button></div><div class="stage-note">${modelHint}</div>`;
  $("#confirmPlanButton").addEventListener("click", () => confirmPlan(project, true));
  const modifyButton = document.createElement("button"); modifyButton.className = "secondary-button"; modifyButton.id = "modifyPlanButton"; modifyButton.type = "button"; modifyButton.textContent = "方案需要修改"; $("#planPanel .panel-actions").prepend(modifyButton); modifyButton.addEventListener("click", () => confirmPlan(project, false));
  $("#realPlanButton").addEventListener("click", generateRealPlan);
}

function renderBackend(project, verified) {
  showOnly("#previewPanel");
  const backend = projectBackend(project); const tasks = list(project.tasks);
  const checks = backend.verification || backend.tests || backend.checks || [];
  const accepted = statusOf(project) === "preview_ready";
  const preview = project.plan ? `<div class="preview-shell"><div class="preview-top"><span>${escapeHtml(accepted ? "产品示例 · mock" : project.plan.preview_label || "产品示例")}</span><span>${accepted ? "示例已准备" : verified ? "等你确认" : "后端开发中"}</span></div><div class="preview-body"><h4>${escapeHtml(project.plan.title || project.idea)}</h4><p>${escapeHtml(project.plan.summary || "方案正在生成")}</p><span class="preview-cta">${escapeHtml(project.answers?.desired_outcome || project.answers?.core_action || "查看示例")} ↗</span></div></div>` : "";
  const title = accepted ? "产品示例已准备好" : verified ? "后端已生成，等你验收" : "正在生成后端与测试";
  const action = accepted ? '<button class="secondary-button" id="newRequirementButton" type="button">加新需求，开启下一版</button><button class="primary-button" id="openPreviewButton" type="button"><span>查看示例</span><span class="button-arrow">↗</span></button>' : verified ? '<button class="primary-button" id="acceptanceButton" type="button"><span>验收通过，完成首版闭环</span><span class="button-arrow">↗</span></button>' : '<button class="secondary-button" id="refreshBuildButton" type="button">刷新开发状态</button>';
  const newRequirementForm = accepted && project.new_requirement_draft ? `<div class="iteration-box"><div class="section-kicker">NEW VERSION · V${Number(project.version || 1) + 1}</div><h4>这次想新增或改变什么？</h4><p>这会创建新版本并重新判断受影响的需求，不会改写已经验收的版本。</p><textarea id="newRequirementInput" placeholder="例如：新增一个让用户导入访谈记录的入口"></textarea><div class="panel-actions"><button class="primary-button" id="createVersionButton" type="button"><span>开启下一版需求发现</span><span class="button-arrow">↗</span></button></div></div>` : "";
  $("#previewPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">BACKEND DELIVERY · ${accepted ? "EXAMPLE" : verified ? "VERIFY" : "BUILDING"}</span><h3>${title}</h3></div><span class="phase-label">${accepted ? "已完成示例" : verified ? "待你验收" : "进行中"}</span></div><p class="panel-copy">这里展示 API、数据模型、测试和示例结果。只有实际打开并完成规定检查的成果，才会标记为已交付。</p><div class="plan-grid"><div class="plan-block"><h4>API 与数据</h4><ul>${listHtml(backend.api_contract || backend.api || ["项目状态接口", "需求与方案确认接口", "预览与验收接口"])}</ul></div><div class="plan-block"><h4>开发任务</h4><ul>${tasks.length ? tasks.map((task) => `<li>${escapeHtml(task.message || task.kind)} · ${escapeHtml(task.status || "进行中")}</li>`).join("") : listHtml(backend.tasks, ["后端任务已创建，等待状态回写"])}</ul></div><div class="plan-block"><h4>测试与恢复</h4><ul>${listHtml(checks, ["结构化 API 测试", "重启恢复待验证", "示例入口已生成"])}</ul></div><div class="plan-block"><h4>完成条件</h4><ul>${listHtml(backend.acceptance || projectIntent(project).acceptance, ["用户能打开示例", "测试结果可查看", "项目状态可恢复"])}</ul></div></div>${preview}${newRequirementForm}<div class="panel-actions">${action}</div>`;
  if (accepted) $("#openPreviewButton").addEventListener("click", () => openPreview(project));
  if (accepted) {
    $("#newRequirementButton").addEventListener("click", () => { project.new_requirement_draft = true; persist(); render(); });
    if (project.new_requirement_draft) $("#createVersionButton").addEventListener("click", () => createNextVersion(project));
  } else if (verified) $("#acceptanceButton").addEventListener("click", () => acceptBuild(project));
  else $("#refreshBuildButton").addEventListener("click", () => loadProject(project.id));
}

async function api(path, options = {}) {
  if (online) return mockApi(path, options);
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error?.message || payload.detail?.message || "这一步暂时失败，请再试一次"); error.status = response.status; throw error; }
  return payload;
}
async function postCandidates(projectId, paths, body) {
  let lastError;
  for (const path of paths) {
    try { return await api(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, { method: "POST", body: JSON.stringify(body) }); }
    catch (error) { lastError = error; if (![404, 405].includes(error.status)) throw error; }
  }
  throw lastError || new Error("接口暂未接入");
}
async function loadModelStatus() { if (online) { state.model = { configured: false, model: "online-mock" }; return; } try { state.model = await api("/api/v1/model/status"); } catch (_) { state.model = { configured: false }; } }
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
    if (online) { state.current = state.projects.find((project) => project.id === projectId) || null; render(); return; }
    const payload = await api(`/api/v1/projects/${encodeURIComponent(projectId)}`); state.current = payload.project; localStorage.setItem("ai-workbench-project", projectId); render();
  } catch (error) { showError(error.message); }
}
async function createProject(event) {
  event.preventDefault(); const idea = $("#idea").value.trim(); if (idea.length < 3) { showError("先用一句话说清楚你想做什么"); return; }
  const button = $("#ideaForm button"); button.disabled = true; clearError();
  try {
    if (online) {
      const project = { id: `p_${Date.now()}`, idea, version: 1, status: "idea", round: 0, questions: mockQuestions(idea, 0), answers: {}, events: [], created_at: now(), updated_at: now() };
      transition(project, "needs_discovery", { pending: project.questions.map((question) => question.id) });
      state.current = project; state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)]; persist();
    } else { const payload = await api("/api/v1/projects", { method: "POST", body: JSON.stringify({ idea }) }); state.current = payload.project; localStorage.setItem("ai-workbench-project", state.current.id); await loadProjects(); }
    $("#idea").value = ""; render();
  } catch (error) { showError(error.message); }
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
      const nextQuestions = mockQuestions(state.current.idea, Number(state.current.round || 0) + 1, state.current.answers);
      state.current.round = Number(state.current.round || 0) + 1;
      state.current.questions = nextQuestions;
      if (nextQuestions.length) transition(state.current, "needs_discovery", { pending: nextQuestions.map((question) => question.id), evidence: Object.entries(answers).map(([id, value]) => `${id}: ${value}`) });
      else { state.current.discovery = mockDiscovery(state.current); state.current.intent = mockIntent(state.current); transition(state.current, "needs_intent_confirmation", { evidence: Object.entries(answers).map(([id, value]) => `${id}: ${value}`) }); }
      persist();
    }
    else { const payload = await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/answers`, { method: "POST", body: JSON.stringify({ answers }) }); state.current = payload.project; state.projects = [state.current, ...state.projects.filter((project) => project.id !== state.current.id)]; }
    render();
  } catch (error) { showError(error.message); button.disabled = false; }
}
async function continueDiscovery(project) {
  if (online) { project.round = Number(project.round || 0) + 1; project.questions = mockQuestions(project.idea, project.round, project.answers || {}); transition(project, "needs_discovery", { pending: project.questions.map((question) => question.id) }); persist(); render(); return; }
  try { const payload = await postCandidates(project.id, ["/confirm-intent"], { confirmed: false, note: "需要补充或修正需求" }); state.current = payload.project; render(); }
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
  api(`/api/v1/projects/${encodeURIComponent(project.id)}/supplement`, { method: "POST", body: JSON.stringify({ text: value }) }).then((payload) => { state.current = payload.project; render(); }).catch((error) => showError(error.message));
}
async function confirmIntent(project) {
  clearError();
  try {
    if (online) { project.plan = mockPlan(project); transition(project, "needs_plan_confirmation", { pending: project.plan.open_questions || [] }); persist(); }
    else { const payload = await postCandidates(project.id, ["/confirm-intent", "/requirements/confirm"], { confirmed: true }); state.current = payload.project; }
    render();
  } catch (error) { showError(error.message); }
}
async function generateRealPlan() {
  const button = $("#realPlanButton"); button.disabled = true; clearError();
  try { const payload = online ? null : await api(`/api/v1/projects/${encodeURIComponent(state.current.id)}/real-plan`, { method: "POST", body: JSON.stringify({ answers: currentAnswers() }) }); if (payload) state.current = payload.project; render(); }
  catch (error) { showError(`${error.message}。真实模型失败不会覆盖当前方案。`); button.disabled = false; }
}
async function confirmPlan(project, confirmed = true) {
  clearError();
  try {
    if (online) { if (confirmed) { project.backend = mockBackend(project); transition(project, "backend_verified", { pending: project.backend.tests || [] }); } else { project.plan_revision = { status: "needs_input", prompt: "方案需要调整哪一处？", requested_at: now() }; transition(project, "needs_plan_confirmation", { pending: ["plan_revision"] }); } persist(); }
    else { const payload = await postCandidates(project.id, ["/confirm-plan", "/plan/confirm"], { confirmed }); state.current = payload.project; }
    render();
  } catch (error) { showError(error.message); }
}
async function createNextVersion(project) {
  const input = $("#newRequirementInput"); const change = input?.value.trim();
  if (!change) { showError("先说清楚这次要新增或改变什么"); return; }
  const button = $("#createVersionButton"); if (button) button.disabled = true; clearError();
  try {
    if (online) {
      const version = Number(project.version || 1) + 1;
      const next = { id: `p_${Date.now()}`, parent_id: project.id, root_id: project.root_id || project.id, version, idea: project.idea, change_request: change, status: "idea", round: 0, questions: [], answers: { change_request: change }, discovery: {}, intent: {}, plan: null, backend: null, events: [], created_at: now(), updated_at: now() };
      next.questions = mockQuestions(next.idea, 0, next.answers, change);
      transition(next, "needs_discovery", { evidence: [change], pending: next.questions.map((question) => question.id) });
      project.new_requirement_draft = false;
      state.current = next; state.projects = [next, ...state.projects]; persist(); render();
    } else {
      const payload = await postCandidates(project.id, ["/iterations", "/new-requirement"], { change_request: change });
      state.current = payload.project; state.projects = [state.current, ...state.projects.filter((item) => item.id !== state.current.id)]; render();
    }
  } catch (error) { showError(error.message); if (button) button.disabled = false; }
}
async function acceptBuild(project) {
  clearError();
  try {
    if (online) { project.accepted = true; transition(project, "preview_ready", { pending: [] }); persist(); }
    else { const payload = await postCandidates(project.id, ["/acceptance", "/verify"], { passed: true }); state.current = payload.project; }
    render();
  } catch (error) { showError(error.message); }
}

async function openPreview(project) {
  try {
    if (online) { const body = document.querySelector("#previewPanel .preview-body"); if (body) body.innerHTML = `<span class="section-kicker" style="color:#2f4f3c">EXAMPLE PREVIEW · MOCK</span><h4>${escapeHtml(project.plan?.title || project.idea)}</h4><p>${escapeHtml(project.plan?.summary || "示例结果已准备；当前没有真实可访问地址")}</p><span class="preview-cta">${escapeHtml(project.answers?.desired_outcome || "查看示例结果")} ↗</span>`; return; }
    const payload = await api(`/api/v1/projects/${encodeURIComponent(project.id)}/preview`); const body = document.querySelector("#previewPanel .preview-body"); if (body) body.innerHTML = `<span class="section-kicker" style="color:#2f4f3c">PREVIEW · ${escapeHtml(payload.preview.badge)}</span><h4>${escapeHtml(payload.preview.headline)}</h4><p>${escapeHtml(payload.preview.body)}</p><span class="preview-cta">${escapeHtml(payload.preview.primary_action)} ↗</span>`;
  } catch (error) { showError(error.message); }
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
function persist() { localStorage.setItem("ai-workbench-online-preview-projects", JSON.stringify(state.projects)); localStorage.setItem("ai-workbench-online-preview-current", state.current?.id || ""); }
function loadSaved() { try { state.projects = JSON.parse(localStorage.getItem("ai-workbench-online-preview-projects") || "[]"); } catch (_) { state.projects = []; } const currentId = localStorage.getItem("ai-workbench-online-preview-current"); state.current = state.projects.find((project) => project.id === currentId) || state.projects[0] || null; render(); }
async function mockApi() { throw new Error("在线演示不调用本地 API，请按页面按钮体验完整流程"); }

$("#ideaForm").addEventListener("submit", createProject);
$("#showNewProjectButton").addEventListener("click", () => { $("#ideaForm").classList.remove("hidden"); $("#newProjectBar").classList.add("hidden"); $("#idea").focus(); });
$("#refreshButton").addEventListener("click", () => online ? loadSaved() : loadProjects());
Promise.all([loadModelStatus(), loadProjects()]);
