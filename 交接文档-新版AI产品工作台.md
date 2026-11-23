# AI 产品工作台本地改造交接文档

## 1. 当前唯一目标

把两个老师开源项目完整串成一个本地 AI 产品工厂，并保留已经确认的 v29 前端视觉。

- `agent-workshop` 负责需求访谈、动态追问、需求覆盖、PRD、方案和审稿。
- `idea-to-launch-kit` 负责把 PRD 交给后端开发流程，保留 Swagger/OpenAPI、权限、任务、测试和验收约束。
- 用户只要一个产品入口，需求澄清产出的 PRD 必须进入后端开发链路。
- 本轮只改本地工程，不提交、推送、合并、部署 GitHub、腾讯云或生产环境。

## 2. 目标工程

```text
/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview
```

正式前端入口是根目录的三个文件：

```text
dist/index.html
dist/app.js
dist/app.css
```

不能把 `docs/review/` 或 ZIP 内 `preview/` 当生产入口。ZIP 内 preview 只用于离线查看，强制 mock，不能代替正式流程。

## 3. 用户已经明确的产品要求

这些要求已经确认，不要再次询问，也不要重新设计：

1. 旧版固定三/四个问题不能作为正式需求澄清流程。
2. 需求澄清必须沿用老师源码的动态 Agent 流程。问题数量由需求覆盖情况决定，不能硬编码成 3 个。
3. 问题要支持选项直接点击，也支持自定义输入。推荐选项可以一键采用。
4. 必须完成需求澄清、PRD、方案确认、方案审稿、后端开发、验收、产品预览、预览验证、试用、非空反馈、创建独立 V2 的完整链路。
5. 待确认问题没有处理完、审稿没有达到 80 分、用户没有明确验收，都不能进入后端 MVP。
6. 真实 API 使用同源相对地址 `/api/v1/...`，不能写死测试端口、外部环境域名或前端模型密钥。
7. 模型密钥只使用后端既有 `.env` 配置，不进入前端、localStorage 或源码包。
8. 已配置的 API 不要继续向用户展示“AI 服务已配置”之类的提醒。配置门禁只在未配置或不可用时显示。
9. 不覆盖后端、数据库、用户数据、`.env`，不清空 localStorage。保留现有 DOM 事件、API 契约、localStorage 键和迁移逻辑。
10. 只修改本地，不动 GitHub 和腾讯云。

## 4. 关键根因

当前反复出现“三个问题”的根因已经定位：

- `backend/teacher_source/blueprint/intake_agent.py` 是动态 Agent 流程，`MAX_ROUNDS = 6`，按 `goal / users / core_loop / deliverable / boundaries / constraints` 检查覆盖率。
- `backend/teacher_source/blueprint/chat.py` 保留老师独立运行时的固定流程兼容代码。正式本地产品适配器不调用 `intake_events()`，只调用 `run_intake_agent`，因此真实 Agent 失败会保留错误并停在当前阶段。
- 本地适配器之前错误地调用了 `chat.intake_events()`，所以真实 Agent 发生异常时，用户看到的是“三个问题”，而不是原始动态流程。
- 旧的三轮回退和四维提前收尾都不能作为正式本地产品的成功路径。

当前适配器已改为直接调用 `blueprint.intake_agent.run_intake_agent`。真实 Agent 失败时应抛出明确错误，不能再静默退回固定三轮。

## 5. 已完成的本地代码改造

已处理后端文件：

```text
backend/app/services/workbench.py
backend/app/services/store.py
backend/app/services/teacher_engine.py
backend/app/main.py
backend/app/routes.py
backend/tests/test_teacher_workflow.py
tools/start-local-v29.sh
```

已删除旧测试和旧模型规划器相关文件：

```text
backend/app/services/model_client.py
backend/tests/test_app.py
backend/tests/test_workbench.py
backend/tests/test_preview_health.py
backend/tests/test_model_adapter.py
```

当前后端方向：新建项目后进入老师工作流恢复入口，`workshop-resume` 创建 workshop 并调用老师 Agent 需求澄清，回答和方案均使用老师流程，方案确认必须经过 80 分审稿门禁且不能有高严重度问题，handoff 交给开发链路。创建 V2 保留 V1、`parent_id` 和 `affected_area` 首问逻辑。旧项目迁移会清理旧的固定 `questions`，保留已有 idea、answers、intent、plan。

当前 v29 前端资源版本：

```text
20261119-29
```

## 6. 尚未完成的明确修复

用户刚刚再次指出：API 已经配置过，页面为什么还展示“AI 服务已配置”。

对应代码在 `dist/app.js` 的 `renderStartGate()`。当前配置正常时仍然写入配置提醒。必须改成配置正常时直接隐藏 `#setupGate` 并清空内容，只有未配置、后端不可达或模型不可用时才显示门禁提示。同时检查 `renderWelcomeGuide()`，已配置状态下不要重复出现 API 配置文案。

修改后把 `dist/index.html` 和 `dist/app.js` 的缓存版本从 `cache=20261120-40` 递增到新版本，例如 `cache=20261120-41`，避免浏览器继续读旧缓存。

## 7. 本地启动与验证

```bash
cd "/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview"
./tools/start-local-v29.sh
```

默认地址：`http://127.0.0.1:8770/`

基础检查：

```bash
node --check dist/app.js
python3 -m compileall -q backend/app backend/tests
pytest -q backend/tests/test_teacher_workflow.py
git diff --check
```

已有一次测试结果是 `8 passed`。这只代表当前新增 teacher workflow 测试通过，不能宣称真实模型完整链路已经通过。

## 8. 必须继续做的验收

1. `GET /api/v1/model/status` 返回 configured true。
2. 新建项目后进入 workshop resume，不显示旧固定问题。
3. 真实 Agent 产生动态澄清问题，检查问题数不是固定三题。
4. 选项可以直接点击，自定义输入仍可提交。
5. 待确认项未处理完时，不能进入方案和后端开发。
6. 方案审稿分数低于 80 或有高严重度问题时，不能继续。
7. 用户明确验收后才能进入后端开发。
8. 后端开发、验收、预览验证、试用、非空反馈、创建 V2 完整走通。
9. V2 是独立项目，V1 仍保留，检查 `parent_id` 和 `affected_area`。
10. 桌面 1280px、手机 390px、320px 检查无横向溢出、文字重叠、按钮裁切。

## 9. 运行和数据注意事项

- 本地服务曾运行在 `127.0.0.1:8770`，重新操作前先用 `curl` 确认服务状态。
- 之前真实 smoke 曾创建过项目 `p_f6978ca330`，因为 resume 失败而没有 workshop，页面应允许重新进入 resume 或新建项目。
- 不要把线上或 GitHub 旧版本当作依据。
- 不要用 mock 成功结果冒充真实模型成功。
- 如果真实 Agent 报错，保留完整错误并修复真实原因，不能吞错后回到固定三轮。

## 10. 新会话第一步

```bash
cd "/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview"
rg -n -C 5 "AI 服务已配置|renderStartGate|renderWelcomeGuide|20261120-40|run_intake_agent|intake_events" dist/app.js dist/index.html backend/app/services/teacher_engine.py
curl -sS http://127.0.0.1:8770/api/v1/model/status
```

然后先修配置提示隐藏和 cache 版本，再启动服务做真实 Agent 流程验收。不要重新设计界面，不要把旧问题列表加回来，不要修改 GitHub 或腾讯云。
