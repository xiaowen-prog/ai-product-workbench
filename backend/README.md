# AI 产品工作台本地 API

这是当前浅色纸张工作台使用的本地 FastAPI 后端。它与 dist/ 同源提供静态页面，负责多轮需求发现、需求与方案确认、后端验收、试用反馈、重启恢复和 V2 版本迭代。验收后的版本必须先进入 `trial` 并记录一次 feedback，才允许创建 V2。默认不调用真实模型，也不自动发布。

## 启动

在仓库根目录运行：

backend/start.sh

打开 http://127.0.0.1:8766/?mode=local。此模式默认要求 `backend/.env` 配置 `MODEL_API_KEY`；没有 Key 时，创建项目、确认方案和开启 V2 都会被后端拒绝。数据默认写入 `backend/data/workbench.json`，只保存在本机。

部署到支持 Python 容器的公网平台时，启动入口会读取平台注入的 `PORT`，默认监听 `0.0.0.0`；本地需要限制为回环地址时可设置 `AI_WORKBENCH_HOST=127.0.0.1`。仓库根目录的 `Dockerfile` 可直接构建 FastAPI 运行时。公网部署前必须在平台 Secret 中配置 `MODEL_API_KEY`，不要把 Key 写进仓库或镜像；`AI_WORKBENCH_DATA_DIR` 默认仍是容器内 JSON 文件，若平台会重启或扩容，需要另接持久化存储后再把重启恢复当成生产能力。

仓库也提供 Vercel 的 Python 入口。`api/index.py` 暴露同一个 FastAPI app，`vercel.json` 将公开路径转发到该入口。Vercel 环境变量仍需在平台后台配置，真实 Key 不进入仓库。

离线示例入口是 `/?mode=offline-demo`，它不经过这个 API，也不会创建后端项目。

## 验证

PYTHONPATH=backend backend/.venv/bin/pytest -q backend/tests
node --check dist/app.js

真实模型只从 backend/.env 或进程环境读取 MODEL_API_KEY；未配置时，前端会禁用真实模型按钮。验收后，`GET /api/v1/projects/{id}/preview` 返回同源 `/runtime/{id}/` 地址；`POST /api/v1/projects/{id}/preview/verify` 会检查运行时页面、健康检查和核心动作，验证通过后才能开始试用。运行时页面的输入动作由本地规则引擎执行，不代表公网部署或真实模型调用。
