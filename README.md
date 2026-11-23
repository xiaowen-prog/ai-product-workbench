# AI 产品工作台本地与公网预览

当前 v29 界面保留浅色纸张工作台视觉。正式本地入口由老师第二个项目的 FastAPI 运行时承载，原有 `/api/v1/tasks`、Job、AgentRun、权限、错误格式和 OpenAPI 契约继续可用。v29 工作台在同一进程里接入老师第一个项目的需求澄清、PRD、方案审稿和交接包。

## 本地正式入口

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r backend/requirements-dev.txt
PORT=8770 ./tools/start-local-v29.sh
```

打开 <http://127.0.0.1:8770/>。模型配置通过页面右上角的「模型设置」提交给本机后端，Key 不进入前端代码或浏览器 localStorage。启动脚本会复用本机已有的 DeepSeek 配置。

`.local/teacher-engine/` 只保留为历史参考源码。正式融合源码分别保存在 `backend/teacher_source/` 和 `backend/teacher_backend/`，本地启动时只通过 v29 页面进入。

## 老师开发项目后端

`backend/teacher_backend/` 保留老师开发项目的 SQLAlchemy 数据模型、任务事件、Todo、工具权限、知识、后台 Job、AgentRun、暂停恢复、真实模型 adapter 和 Swagger/OpenAPI 路由。`backend/app/` 只负责 v29 工作台适配和同源静态入口。用户确认的 PRD 与方案会复制到本地 Idea to Launch 项目的 `projects/<产品>/docs/PRD/`，并生成阶段 0 任务。

## 目录和 API 边界

审查快照和视觉探索页保存在 `docs/review/`，它们是历史验收证据，不是生产入口。生产静态目录 `dist/` 只保留工作台运行所需的 `index.html`、`app.js` 和 `app.css`；本地回滚副本放在被 Git 忽略的 `backups/`。

本地 API 的 canonical 路径（省略 `/api/v1/projects/{project_id}` 前缀）是 `/answers`、`/confirm-intent`、`/confirm-plan`、`/modify-plan`、`/iterations`、`/acceptance` 和 `/trial`。`/discovery-answers`、`/plan/modify`、`/new-requirement`、`/build`、`/trial/start` 仅作为历史客户端兼容别名保留，当前前端不调用，也不出现在 OpenAPI 正式契约中；在确认无外部调用后再删除。

## 验证

PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests
node --check dist/app.js

python3 -m compileall -q .local/teacher-engine/blueprint
bash -n tools/start-local-v29.sh

未配置 MODEL_API_KEY 时，真实需求澄清和独立审稿会被后端门禁挡住。老师原有开发接口可从 `/docs` 和 `/openapi.json` 查看。`GET /api/v1/projects/{id}/handoff` 只在方案确认和交接包生成后开放。后端验收、预览验证、试用反馈和 V2 仍保留原项目的门禁。
