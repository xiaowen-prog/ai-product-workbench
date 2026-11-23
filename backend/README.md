# AI 产品工作台本地 API

这是当前浅色纸张工作台使用的融合本地 FastAPI 后端。老师第二个项目的任务、Job、AgentRun、权限、错误格式和 Swagger/OpenAPI 路由保留在 `teacher_backend/`。v29 工作台把老师第一个项目的需求澄清、PRD、方案审稿和交接包接到同一入口。完成需求确认、真实独立审稿和用户确认后，交接包进入本地 Idea to Launch 项目的阶段 0 PRD 体检。

运行时依赖位于 `backend/requirements.txt`。本地测试和 TestClient 依赖位于 `backend/requirements-dev.txt`。

工作区 JSON 会从 schema v1 自动迁移到 schema v2。旧状态名、旧字段名和旧事件字段会在第一次读取时规范化并原子回写。

## 启动

在仓库根目录运行：

backend/start.sh

打开 http://127.0.0.1:8770/。正式入口要求后端运行时配置 `MODEL_API_KEY`。需求澄清和独立审稿使用真实模型，Key 只在后端环境变量读取。工作台状态写入 `data/workbench.json`，老师开发项目状态写入 `data/agent_workbench.sqlite3`。

部署到支持 Python 容器的公网平台时，启动入口会读取平台注入的 `PORT`，默认监听 `0.0.0.0`；本地需要限制为回环地址时可设置 `AI_WORKBENCH_HOST=127.0.0.1`。仓库根目录的 `Dockerfile` 可直接构建 FastAPI 运行时。公网部署前必须在平台 Secret 中配置 `MODEL_API_KEY`，不要把 Key 写进仓库或镜像；`AI_WORKBENCH_DATA_DIR` 默认仍是容器内 JSON 文件，若平台会重启或扩容，需要另接持久化存储后再把重启恢复当成生产能力。

仓库也提供 Vercel 的 Python 入口。`api/index.py` 暴露同一个 FastAPI app，`vercel.json` 将公开路径转发到该入口。Vercel 环境变量仍需在平台后台配置，真实 Key 不进入仓库。

离线示例入口是 `/?mode=offline-demo`，它不经过这个 API，也不会创建后端项目。

## 验证

PYTHONPATH=backend backend/.venv/bin/pytest -q backend/tests
node --check dist/app.js

真实模型只从 backend/.env 或进程环境读取 `MODEL_API_KEY`。老师原有开发接口可从 `/docs` 和 `/openapi.json` 查看。`GET /api/v1/projects/{id}/handoff` 只在方案确认和交接包生成后开放。后端验收、预览验证、试用反馈和 V2 仍保留原项目的门禁。
