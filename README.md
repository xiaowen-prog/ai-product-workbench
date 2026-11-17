# AI 产品工作台本地预览

当前界面是浅色纸张工作台：一个当前任务、一处主操作、一个明确的示例入口。直接打开 dist/index.html 时走浏览器本地 mock；启动 FastAPI 后加 ?mode=local 才会使用本地 JSON 后端。验收后的 `trial` 阶段记录一次 outcome 与文字 feedback，反馈写入后才能开启 V2。

## 启动本地后端

uv venv backend/.venv
uv pip install --python backend/.venv/bin/python -r backend/requirements.txt
backend/start.sh

打开 http://127.0.0.1:8766/?mode=local。此模式默认要求 `backend/.env` 配置 `MODEL_API_KEY`，没有 Key 不能创建真实项目；数据默认写到 `backend/data/workbench.json`，只保存在本机。真实模型 Key 只从 `backend/.env` 或进程环境读取。

没有 Key 时可打开 `http://127.0.0.1:8766/?mode=offline-demo` 查看独立离线示例。离线示例使用浏览器 `localStorage`，不会创建本地 API 项目。

## 验证

PYTHONPATH=backend backend/.venv/bin/pytest -q backend/tests
node --check dist/app.js

未配置 MODEL_API_KEY 时，真实模型按钮会保持禁用；本地结构化方案和 mock 示例仍可完整走通。后端预览返回的是结构化示例内容，不代表已部署的公开地址；`trial` 反馈也只代表本地记录，不代表真实用户试用或质量验收。
