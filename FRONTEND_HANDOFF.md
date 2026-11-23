# AI 产品工作台前端交接

## 目标

请完全重新设计前端视觉和交互。当前 `dist/` 只作为接口接入参考，不要求沿用当前视觉、布局或组件样式。

正式前端入口只有：

```text
/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview/dist/index.html
/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview/dist/app.js
/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview/dist/app.css
```

不要把 `docs/review/`、ZIP 内 `preview/` 或老师源码静态页面当正式入口。

## 运行

```bash
cd "/Users/mima1234/Documents/个人项目-复盘/个人项目-aigc/个人项目-game/ai产品工厂/online-preview"
./tools/start-local-v29.sh
```

默认地址：`http://127.0.0.1:8770/`

所有请求使用同源相对地址 `/api/v1/...`。不要写死测试端口、外部域名或模型密钥。

## 不可改变的边界

- 模型 Key 只从后端环境读取，不能进入前端源码、HTML、localStorage 或构建包。
- 已配置时不要显示“AI 服务已配置”。只有后端未配置或不可达时显示门禁。
- 不新增前端配置写入接口。
- 保留 API 路径、请求字段、响应字段、项目状态值和 localStorage 迁移逻辑。
- 不清空现有 localStorage。
- 真实模式和 mock 要明确区分，不能用 mock 成功冒充真实模型或真实开发完成。
- 需求澄清继续使用老师 Agent 动态事件，不改回固定三题卡片。
- 可以完全换视觉，但不能把真实 API 改回 mock 或绕过阶段门禁。

## API 契约

失败响应统一读取：

```json
{
  "error": {
    "code": "invalid_transition",
    "message": "当前还不能确认方案"
  }
}
```

保留 `code` 和 `message`，显示错误时保留用户未提交的输入。

### 模型状态

```http
GET /api/v1/model/status
```

关键字段：`configured`、`required`、`teacher_workflow`、`can_build`、`model`、`key_masked`。只显示脱敏状态，不读取完整 Key。

### 项目

```http
GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/{project_id}
```

创建请求：

```json
{ "idea": "做一个销售机器人" }
```

### 需求澄清

```http
POST /api/v1/projects/{project_id}/workshop-resume
POST /api/v1/projects/{project_id}/workshop-chat
```

聊天请求：

```json
{
  "stage": "intake",
  "messages": [
    { "role": "user", "text": "用户消息" },
    { "role": "assistant", "text": "助手消息" }
  ]
}
```

`stage` 取 `intake` 或 `answers`。返回事件类型：

```json
{ "type": "text", "delta": "问题或说明" }
{ "type": "suggestions", "items": ["推荐回答", "不确定，先跳过"] }
{ "type": "tool", "name": "confirm_product", "args": { "name": "产品名", "idea": "PRD 草稿" } }
```

前端要支持推荐选项、自定义输入、跳过和整理草稿。不要把问题编号或问题数量写死。

### 方案问答

```http
POST /api/v1/projects/{project_id}/workshop-chat/save
```

```json
{
  "answers": [
    { "question": "原问题文本", "answer": "用户回答" }
  ]
}
```

问题来自 `project.workshop.answer_questions` 和 `project.plan.open_questions`，数量由后端决定。

### 需求确认和方案确认

```http
POST /api/v1/projects/{project_id}/confirm-intent
{ "confirmed": true, "note": "需求草稿确认" }
```

```http
GET /api/v1/projects/{project_id}/plan-progress
```

该只读接口返回老师工作区的需求拆解、组件选型、领域建模与架构设计、独立审稿、待确认问题和文档交接阶段，以及已经落盘的审稿分数和问题。方案推导期间前端轮询它，推导完成后以 `confirm-intent` 的项目响应为准。

```http
POST /api/v1/projects/{project_id}/confirm-plan
{ "confirmed": true, "note": "方案确认" }
```

方案确认按钮只有以下条件满足时可提交：

```text
status == needs_plan_confirmation
confirmations.intent == true
workshop.answer_questions 为空
plan.open_questions 为空
plan.review_score >= 80
plan.review_ok == true
```

方案确认后才能下载：

```http
GET /api/v1/projects/{project_id}/handoff
```

### 开发准备

```http
POST /api/v1/projects/{project_id}/build
Content-Type: application/json

{ "execution_mode": "real" }
```

真实原始工具包模式常见状态：

```text
backend.status = awaiting_external_coding
development.run_status = external_tool_required
backend.execution_mode = original_kit
```

前端展示阶段任务和交接包入口，不显示内部 Agent 已完成代码的假状态。

```http
GET  /api/v1/projects/{project_id}/development
POST /api/v1/projects/{project_id}/development/verify
POST /api/v1/projects/{project_id}/development/accept
```

开发验收请求：

```json
{
  "passed": true,
  "next_stage": "阶段1",
  "note": "开发阶段通过"
}
```

当前交接要求可以跳过开发验证，不要把它设计成唯一自动入口。

### 验收、预览和试用

```http
POST /api/v1/projects/{project_id}/acceptance
{ "passed": true, "note": "验收通过" }
```

```http
GET  /api/v1/projects/{project_id}/preview
POST /api/v1/projects/{project_id}/preview/verify
```

预览返回 `preview.url`、`preview.health_url`、`preview.action_url`、`preview.status` 和 `preview.checks`。只有 `preview.status == verified` 才能试用：

```http
POST /api/v1/projects/{project_id}/trial
POST /api/v1/projects/{project_id}/trial-feedback
```

反馈请求：

```json
{ "feedback": "非空试用反馈", "outcome": "needs_change" }
```

### V2

试用反馈后创建独立 V2：

```http
POST /api/v1/projects/{project_id}/iterations
{ "change_request": "V2 新需求" }
```

返回的新项目必须保留 `parent_id`、`root_id` 和递增的 `version`。

## 状态机

```text
needs_discovery
  -> needs_intent_confirmation
  -> needs_plan_confirmation
  -> backend_building
  -> backend_verified
  -> preview_ready
  -> trial
```

每次 API 成功后以返回的 `project.status` 重新渲染，不能只根据本地按钮跳转。

## localStorage 兼容

现有键包括：

```text
ai-workbench-project
ai-workbench-online-preview-projects
ai-workbench-online-preview-current
ai-workbench-online-preview-schema
ai-workbench-onboarding-seen-v1
```

新视觉可以完全不同，但要读取旧键并保留迁移逻辑。不要启动时清空 localStorage。

## 检查

```bash
node --check dist/app.js
python3 -m compileall -q backend/app backend/tests
git diff --check
```

检查 `1280px`、`390px`、`320px`，避免横向溢出、长问题重叠、按钮裁切和错误提示被遮挡。完成前递增静态资源缓存版本，避免浏览器继续读取旧资源。

## 联调补充契约

### 开发验证跳过路径

“跳过开发验证”只表示不调用：

```http
POST /api/v1/projects/{project_id}/development/verify
```

当前原始工具包门禁仍要求：

1. `POST /build` 创建原始 kit 阶段任务
2. 外部编码工具完成当前阶段任务
3. 运行 `kit.sh 自检`，使 `backend.kit_status == "passed"`
4. 调用 `POST /development/accept` 推进原始 kit 阶段
5. 原始 kit 进入阶段 3 或完成后，项目变为 `backend_verified`
6. 调用 `POST /acceptance` 才能进入 `preview_ready`

因此不能在前端直接把 `awaiting_external_coding` 画成 `backend_verified`。没有自检通过，`development/accept` 会被后端拒绝。前端只需展示等待外部编码和当前阶段任务。

状态、按钮和接口关系如下：

| project.status | backend.status / kit_status | 可用动作 | 成功后的状态 |
|---|---|---|---|
| `needs_plan_confirmation` | 无 | 方案确认 | `backend_building` |
| `backend_building` | `awaiting_external_coding` | 查看开发状态、等待外部编码 | 不自动变化 |
| `backend_building` | `kit_self_check_passed` | `development/accept` | 阶段推进，或 `backend_verified` |
| `backend_verified` | `backend_verified` | `acceptance` | `preview_ready` |
| `preview_ready` | 预览 `unverified` | `preview/verify` | 预览 `verified` |
| `preview_ready` | 预览 `verified` | `trial` | `trial` |
| `trial` | 试用中 | `trial-feedback` | 仍为 `trial` |

### 事件传输和恢复

`workshop-chat` 当前是一次 HTTP JSON 响应，返回完整 `events` 数组，不是 SSE，也不是逐行 JSON。`text.delta` 只是事件数组里的分段文本。

- `workshop-resume` 使用空请求体 `{}`。
- `workshop-chat` 每次传全量 `messages`，不是增量消息。
- 请求失败或断线时保留浏览器内未提交消息，重新 GET 项目后再用完整消息重发。
- 收到 `confirm_product` 只表示老师 Agent 交出了草稿。前端展示可编辑草稿，只有用户点击需求确认后才调用 `confirm-intent`。
- 收到 `confirm_answers` 或 `confirm_product` 事件不能直接当成用户确认。
- 保存方案回答成功后，以返回的 `project` 为准。没有返回项目对象的响应，重新调用 `GET /projects/{id}`。

### 响应解析

不要对所有成功响应都直接读取 `payload.project.status`。

- `projects` 列表返回 `projects`。
- `model/status` 返回模型状态，不含项目。
- `workshop-chat` 返回 `project` 和 `events`。
- `preview` 返回 `project_id`、`preview` 等预览信息，不返回完整项目。
- `preview/verify` 返回 `project` 和 `preview`。
- 运行时 `/runtime/{id}/run` 返回 `result`。
- 下载 handoff 返回文件流。

响应有 `project` 时使用它更新状态。响应没有 `project` 但会改变项目时，重新 GET 项目详情。

### 配置门禁

`GET /api/v1/model/status` 的字段含义：

- `configured` 表示后端 Key 是否存在
- `required` 表示当前启动是否要求模型配置
- `can_build` 表示创建项目和进入真实流程是否具备模型条件
- `teacher_workflow` 表示老师流程适配已启用

前端表现：

- `configured=true` 且 `can_build=true`：正常显示新建、需求澄清和方案流程
- `configured=false` 或 `can_build=false`：显示配置门禁，禁止新建真实项目
- 历史项目列表和已保存项目详情仍可查看
- 配置状态接口临时不可达时显示网络错误，不把它直接判断成“未配置”
- 前端禁用按钮只改善体验，后端状态门禁仍是最终依据

### 重复提交、超时和刷新

- `confirm-intent`、`confirm-plan`、`build`、`acceptance`、`trial`、`iterations` 提交期间禁用按钮，避免双击。
- 请求超时后先 `GET /projects/{id}` 和对应状态接口确认结果，再决定是否重试。
- 不要因为客户端没有收到响应就盲目重发创建项目、创建 V2 或 build。
- `GET /development` 是等待外部编码时的恢复入口，刷新后继续读取它。
- 预览使用 `GET /preview` 恢复，运行时使用 `health_url` 查询健康状态。
- 浏览器刷新后以服务端项目状态为准，未提交草稿才从 localStorage 恢复。
- 旧缓存不能覆盖服务器最新阶段。加载项目时先 GET 服务端，再合并未提交草稿。

## 功能回归用例

重设计完成后至少覆盖：

- 动态问题数量变化、跳过、自定义回答、断线后全量消息恢复
- `confirm-intent`、`confirm-plan` 的每个阻塞条件
- 分数低于 80、存在 high、存在未回答问题时不能确认方案
- 分数达到 80、无 high、问题清空后可以确认方案
- `awaiting_external_coding` 不显示成自动开发完成
- 跳过 `development/verify` 时仍不能绕过 `kit.sh` 自检和 `development/accept`
- 未验证预览不能开始试用
- 预览验证失败时保留用户输入和当前项目状态
- 试用反馈为空时拒绝提交，非空反馈可创建 V2
- V2 保留 `parent_id`、`root_id` 并递增 `version`
- 旧 localStorage 迁移、损坏数据提示、刷新恢复、多项目切换

## 视觉和任务交接

目标用户是不会写代码的产品提出者。主任务是把一句自然语言想法聊清楚，确认 PRD 和方案，等待开发准备，查看预览并记录试用反馈。

每个阶段只保留一个主操作：

1. 新建并发送想法
2. 回答老师动态问题
3. 编辑并确认需求草稿
4. 逐条回答方案待确认问题
5. 确认方案
6. 查看开发阶段任务和交接状态
7. 确认后端验收
8. 打开并验证预览
9. 开始试用并提交非空反馈
10. 创建独立 V2

可以使用全新的视觉语言。需要让用户始终看清当前阶段、下一步主按钮、阻塞原因和真实状态。避免把所有阶段堆成卡片，也不要把等待外部编码画成“AI 正在自动写代码”。

## 交付前检查

```bash
node --check dist/app.js
python3 -m compileall -q backend/app backend/tests
git diff --check
```

检查 `1280px`、`390px`、`320px`，避免横向溢出、长问题重叠、按钮裁切和错误提示被遮挡。完成前递增静态资源缓存版本，避免浏览器继续读取旧资源。

## 最后五项契约对齐

### 1. 自检字段和值

前端统一使用以下字段：

```text
project.status
project.backend.status
project.backend.kit_status
development.run_status
```

当前实际值：

```text
project.status = backend_building
project.backend.status = awaiting_external_coding
project.backend.kit_status = 做中 | 待验收 | passed | failed | completed

development.run_status = external_tool_required
```

调用 `development/verify` 后：

```text
project.backend.status = kit_self_check_passed
project.backend.kit_status = passed
```

自检失败：

```text
project.backend.status = kit_self_check_failed
project.backend.kit_status = failed
```

只有 `project.backend.kit_status == "passed"` 才能调用 `development/accept`。阶段推进完成后，若原始 kit 到达阶段 3 或 `完成`：

```text
project.status = backend_verified
project.backend.status = backend_verified
```

不要使用不存在的 `kit_self_check_passed` 作为 `kit_status` 值。它只可能出现在 `backend.status`。

### 2. `/build` 的触发方

`confirm-plan` 只负责确认方案、生成 handoff，并把项目置为：

```text
project.status = backend_building
```

正式前端收到 `stage_task_ready` 后会立即单次调用 `/build`，把确认后的 PRD 交给原始 idea-to-launch-kit。这个调用属于确认后的开发准备动作，刷新、重新渲染和回读状态都不能再次触发。

前端在方案确认成功后展示“开始开发准备”按钮。用户点击后调用一次：

```http
POST /api/v1/projects/{project_id}/build
{ "execution_mode": "real" }
```

请求超时先 `GET /projects/{id}` 和 `GET /development` 查询结果。只有项目仍处于 `stage_task_ready` 时，用户再次点击开发准备才允许重试。

### 3. `high` 的来源

前端不自行计算 high。后端在写入 `project.plan` 时把审稿结果转换为：

```text
plan.review_score
plan.review_ok
plan.review_issues
```

当前放行条件由 `plan.review_score >= 80` 且 `plan.review_ok == true` 决定。`review_ok` 已由后端根据没有 `severity == "high"` 计算。前端只展示 `review_issues`，不要从文案猜严重度。

### 4. 聊天超时和重复提交

请求断开不代表 Agent 没执行，也不代表没有写入。处理顺序：

1. 保留当前输入和全量 `messages` 草稿
2. 先 `GET /api/v1/projects/{project_id}` 检查 transcript、draft、answer_draft 和 status
3. 如果服务端已经追加本次回答，使用服务器状态，不重发
4. 如果无法确认，提示用户选择“重新查询”或“确认重试”
5. 只有用户明确选择重试才再次发送

全量 `messages` 本身不提供幂等键，不能把网络重试当成安全重试。确认、build、验收、创建 V2 也遵守同一规则。

### 5. 配置、能力和网络错误

这三类状态分开处理：

| 状态 | 前端含义 | 页面动作 |
|---|---|---|
| `configured=false`、`required=true` | 后端没有模型配置 | 禁止真实新建和真实开发，显示配置提示，历史项目仍可查看 |
| `configured=true`、`can_build=false` | Key 存在但当前后端能力不可用 | 不显示“未配置 Key”，显示“模型或后端暂不可用”，允许查看历史，禁止进入真实构建 |
| `required=false`、`can_build=true` | 当前服务允许离线或 mock 能力 | 只按接口实际返回决定是否显示离线新建，明确标注 mock，不冒充真实流程 |
| `/model/status` 请求失败 | 网络或后端不可达 | 显示“无法连接本地后端”，不要判断成 Key 缺失 |

后端仍然执行最终门禁。前端按钮禁用只是用户体验层。
