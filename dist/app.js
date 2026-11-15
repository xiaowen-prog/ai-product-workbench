const state = { projects: [], current: null };
const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = "ai-workbench-online-preview-projects";

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function showError(message) { const panel = $("#errorPanel"); panel.textContent = message; panel.classList.remove("hidden"); }
function clearError() { $("#errorPanel").classList.add("hidden"); }
function statusLabel(status) { return { needs_clarification: "等待澄清", preview_ready: "可预览" }[status] || "已保存"; }
function setFlow(step) {
  [...document.querySelectorAll(".flow-item")].forEach((item, index) => {
    item.classList.toggle("active", index === step); item.classList.toggle("done", index < step);
    item.querySelector(".flow-state").textContent = index < step ? "完成" : index === step ? "现在" : "等待";
  });
  $("#phaseLabel").textContent = `阶段 0${step + 1} · ${["想法", "澄清", "方案", "预览"][step]}`;
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.projects)); }
function renderProjects() {
  const list = $("#projectList");
  if (!state.projects.length) { list.innerHTML = '<div class="empty-projects">还没有项目<br /><span>从左侧输入一句话开始</span></div>'; return; }
  list.innerHTML = state.projects.map((project) => `<button class="project-item ${state.current?.id === project.id ? "selected" : ""}" data-project-id="${escapeHtml(project.id)}" type="button"><strong>${escapeHtml(project.idea)}</strong><small>${statusLabel(project.status)}</small></button>`).join("");
  list.querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", () => loadProject(button.dataset.projectId)));
}
function mockPlan(project, answers) {
  const target = answers.target_user || "第一次做产品的个人创作者";
  const action = answers.core_action || "把想法变成可预览的最小产品";
  return {
    title: project.idea.slice(0, 32), summary: `为${target}提供一个从一句话开始的工作流，帮助用户${action}。`,
    intent: { target_user: target, goal: `为${target}提供一个从一句话开始的工作流，帮助用户${action}。`, core_loop: `输入一句话 → 澄清关键目标 → ${action} → 查看结果并确认`, acceptance: ["用户能看懂当前进度", "方案包含明确的用户、动作和结果", "刷新后项目仍可继续"] },
    mvp_features: ["自然语言输入", "关键补问", "内部需求摘要", "方案和验收标准", "预览入口"],
    preview_label: "方案预览已就绪"
  };
}
function render() {
  clearError(); const project = state.current;
  ["#questionPanel", "#planPanel", "#previewPanel"].forEach((selector) => $(selector).classList.add("hidden"));
  if (!project) { setFlow(0); renderProjects(); return; }
  if (project.status === "needs_clarification") {
    setFlow(1);
    $("#questionPanel").innerHTML = `<div class="panel-heading"><div><span class="section-kicker">TWO SMALL QUESTIONS</span><h3>先把方向说准</h3></div><span class="phase-label">${escapeHtml(project.idea.slice(0, 22))}</span></div><p class="panel-copy">只问会改变产品方向的问题。你可以用很短的话回答，不需要专业术语。</p><div class="question-list">${project.questions.map((question) => `<div class="question-card"><label>${escapeHtml(question.text)}</label><input data-question-id="${escapeHtml(question.id)}" placeholder="${escapeHtml(question.hint)}" autocomplete="off" /><small>这会影响后面的产品方案</small></div>`).join("")}</div><div class="panel-actions"><button class="primary-button" id="answerButton" type="button"><span>生成最小方案</span><span class="button-arrow">↗</span></button></div>`;
    $("#questionPanel").classList.remove("hidden"); $("#answerButton").addEventListener("click", submitAnswers);
  } else if (project.plan) {
    setFlow(2); $("#planPanel").innerHTML = renderPlan(project); $("#planPanel").classList.remove("hidden");
    $("#previewPanel").innerHTML = renderPreview(project); $("#previewPanel").classList.remove("hidden"); $("#previewButton").addEventListener("click", openPreview); setFlow(3);
  }
  renderProjects();
}
function renderPlan(project) {
  const { plan } = project;
  return `<div class="panel-heading"><div><span class="section-kicker">MINIMUM PRODUCT PLAN</span><h3>${escapeHtml(plan.title)}</h3></div><span class="phase-label">mock 方案</span></div><p class="panel-copy">${escapeHtml(plan.summary)}</p><div class="plan-grid"><div class="plan-block"><h4>用户与目标</h4><p>${escapeHtml(plan.intent.target_user)}<br />${escapeHtml(plan.intent.goal)}</p></div><div class="plan-block"><h4>核心闭环</h4><p>${escapeHtml(plan.intent.core_loop)}</p></div><div class="plan-block"><h4>MVP 包含</h4><ul>${plan.mvp_features.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div><div class="plan-block"><h4>验收标准</h4><ul>${plan.intent.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></div><div class="real-model-row"><span>在线预览为 mock 流程；真实模型请使用本地版</span></div>`;
}
function renderPreview(project) { return `<div class="panel-heading"><div><span class="section-kicker">PRODUCT PREVIEW</span><h3>打开你刚刚定义的产品</h3></div><button class="primary-button" id="previewButton" type="button"><span>刷新预览</span><span class="button-arrow">↗</span></button></div><div class="preview-shell"><div class="preview-top"><span>${escapeHtml(project.plan.preview_label)}</span><span>在线 mock 预览</span></div><div class="preview-body"><h4>${escapeHtml(project.plan.title)}</h4><p>${escapeHtml(project.plan.summary)}</p><span class="preview-cta">${escapeHtml(project.answers.core_action || "开始体验")} ↗</span></div></div>`; }
function createProject(event) { event.preventDefault(); const idea = $("#idea").value.trim(); if (idea.length < 3) { showError("先用一句话说清楚你想做什么"); return; } const project = { id: `p_${Date.now()}`, idea, status: "needs_clarification", questions: [{ id: "target_user", text: "这个想法最先服务哪一类人？", hint: "例如：第一次做产品的个人创作者" }, { id: "core_action", text: "用户完成后最希望得到哪一个结果？", hint: "用一个动词描述，例如：生成、整理、预览或发布" }], answers: {} }; state.current = project; state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)]; $("#idea").value = ""; persist(); render(); }
function submitAnswers() { const answers = {}; document.querySelectorAll("[data-question-id]").forEach((input) => { answers[input.dataset.questionId] = input.value.trim(); }); if (Object.values(answers).some((answer) => !answer)) { showError("还有一个关键问题没有回答"); return; } state.current.answers = answers; state.current.plan = mockPlan(state.current, answers); state.current.status = "preview_ready"; state.current.updated_at = new Date().toISOString(); persist(); render(); }
function loadProject(projectId) { state.current = state.projects.find((project) => project.id === projectId) || null; localStorage.setItem("ai-workbench-online-preview-current", projectId); render(); }
function openPreview() { const body = $("#previewPanel .preview-body"); body.innerHTML = `<span class="section-kicker" style="color:#39756a">LIVE PREVIEW</span><h4>${escapeHtml(state.current.plan.title)}</h4><p>${escapeHtml(state.current.plan.summary)}</p><span class="preview-cta">${escapeHtml(state.current.answers.core_action || "开始体验")} ↗</span>`; }
function loadSaved() { try { state.projects = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { state.projects = []; } const currentId = localStorage.getItem("ai-workbench-online-preview-current"); state.current = state.projects.find((project) => project.id === currentId) || state.projects[0] || null; render(); }
$("#ideaForm").addEventListener("submit", createProject); $("#refreshButton").addEventListener("click", loadSaved); loadSaved();
