# AI 产品工作台本地 API

这是当前浅色纸张工作台使用的本地 FastAPI 后端。它与 dist/ 同源提供静态页面，负责多轮需求发现、需求与方案确认、后端验收、重启恢复和 V2 版本迭代。默认不调用真实模型，也不自动发布。

## 启动

在仓库根目录运行：

backend/start.sh

打开 http://127.0.0.1:8766/?mode=local。此模式默认要求 `backend/.env` 配置 `MODEL_API_KEY`；没有 Key 时，创建项目、确认方案和开启 V2 都会被后端拒绝。数据默认写入 `backend/data/workbench.json`，只保存在本机。

离线示例入口是 `/?mode=offline-demo`，它不经过这个 API，也不会创建后端项目。

## 验证

PYTHONPATH=backend backend/.venv/bin/pytest -q backend/tests
node --check dist/app.js

真实模型只从 backend/.env 或进程环境读取 MODEL_API_KEY；未配置时，前端会禁用真实模型按钮。
