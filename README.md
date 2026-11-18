# AI 产品工作台本地与公网预览

当前界面是浅色纸张工作台：一个当前任务、一处主操作、一个明确的示例入口。直接打开 dist/index.html 时走浏览器本地 mock；启动 FastAPI 后加 ?mode=local 才会使用本地 JSON 后端。验收后的 `trial` 阶段记录一次 outcome 与文字 feedback，反馈写入后才能开启 V2。

## 启动本地后端

uv venv backend/.venv
uv pip install --python backend/.venv/bin/python -r backend/requirements-dev.txt
backend/start.sh

打开 http://127.0.0.1:8766/?mode=local。此模式默认要求 `backend/.env` 配置 `MODEL_API_KEY`，没有 Key 不能创建真实项目；数据默认写到 `backend/data/workbench.json`，只保存在本机。真实模型 Key 只从 `backend/.env` 或进程环境读取。

没有 Key 时可打开 `http://127.0.0.1:8766/?mode=offline-demo` 查看独立离线示例。离线示例使用浏览器 `localStorage`，不会创建本地 API 项目。

审查快照和视觉探索页保存在 `docs/review/`，生产静态目录只保留工作台运行所需的 `index.html`、`app.js` 和 `app.css`。本地 API 的 canonical 路径是 `/answers`、`/confirm-intent`、`/confirm-plan`、`/modify-plan`、`/iterations`、`/acceptance` 和 `/trial`，旧别名暂时保留给外部客户端。

## 验证

PYTHONPATH=backend backend/.venv/bin/pytest -q backend/tests
node --check dist/app.js

未配置 MODEL_API_KEY 时，真实模型按钮会保持禁用；本地结构化方案和 mock 示例仍可完整走通。本地 API 的验收页会生成 `/runtime/{project_id}/` 运行时地址，必须通过页面、健康检查和核心动作验证后才显示为可运行预览。`trial` 反馈只代表本地记录，不代表真实用户试用或质量验收。

## 腾讯云公网实例

同一套 FastAPI 同源服务已按部署手册发布到腾讯云 CloudBase Run。公网入口为 <https://ai-product-workbench-api-341888-6-1525683482.sh.run.tcloudbase.com>，服务名为 `ai-product-workbench-api`，环境为 `xhs-title-d1gvrs9jt6d0f7b03`。公网回归已验证健康检查、API Key 门禁、真实模型方案生成、后端搭建、预览验证和运行时核心动作。

公网容器使用 `/tmp/data` 保存 JSON 状态，实例重启后数据可能丢失。运行时产品页使用当前项目的规则引擎执行核心动作，真实模型用于方案生成，不应把规则运行时结果描述成模型实时生成。
