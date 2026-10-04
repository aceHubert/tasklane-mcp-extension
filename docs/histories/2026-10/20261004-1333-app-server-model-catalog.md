# [2026-10-04 13:33 +0800] | 任务：经 codex app-server 只读获取宿主模型目录（model_list）

## 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3（account:zai-individual-coding-plan/GLM-5.3）`
- **Runtime**：`ZCode 桌面 CLI，macOS arm64`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（unborn，尚无提交，HEAD 不可作差异基线）`
- **关联计划**：`docs/exec-plans/completed/app-server-model-catalog.md`

## 用户诉求

> 在确认 `codex debug models` 与 app-server `model/list` 两条可行路径后，用户选定
> app-server 方式：TaskLane 需要在创建会话前的「指定模型」输入中提供宿主可选模型列表。

## 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`scripts/`、`plugins/tasklane/`（产物重建）、文档

**主要操作**：

- **core 目录服务**：新增 `packages/core/src/model-catalog.ts`（`ModelCatalogService`），
  每次查询独立 spawn `codex app-server`，stdio JSON-RPC `initialize` 握手后分页聚合
  `model/list`（页数上限 20），字段宽松映射（camelCase 为主、兼容 snake_case），
  单响应超时默认 15s 后 SIGKILL；新增错误码 `MODEL_CATALOG`。
- **MCP 工具**：注册 `model_list`（无参数，返回 `models` 与 `defaultModelId`）；
  `createServer` 新增 `catalog` 注入项，独立模式与插件模式共用同一注册入口。
- **UI**：TaskDetail 模型选择合并为**单一只读下拉**（用户验收反馈：不要两个控件、不允许输入）：
  默认项「继承宿主默认模型」，候选项即 `model_list` 目录（`显示名 (id)` 格式），无任何手输路径；
  待确认请求中的模型不在当前目录时补同名选项如实展示。加载中/失败/成功各有中英文提示，
  失败时仅保留继承宿主默认。目录拉取用 ref 一次性守卫的事件驱动（详见验证结果的竞态修复）。
- **验证脚本**：`smoke.mjs`（12→13 业务工具、17→18 总数）、`verify-plugin.mjs`
  （19→20）、`build-plugin.mjs` 头注释同步；插件 bundle 重建。
- **文档**：AGENTS.md 工具树新增条目并修订「不提供 CLI/App Server 兜底」条款
  （显式登记 model_list 只读例外）；README 工具契约表新增行；
  native-execution-contract.md 补充模型候选来源说明。

## 设计动机

上一任务（20261004-1205）因「当前没有宿主模型目录接口」只提供模型 ID 手填。本机实测
两条获取路径后选定 app-server `model/list`：这是 Codex Desktop 与后端通信的正式协议
（initialize → model/list，支持分页与 includeHidden），返回与宿主选择器同源的目录
（本机 47 个模型、含 40 个网关路由模型），字段比 `codex debug models` 的 debug 输出规范。

关键取舍：
- 每次查询独立 spawn 进程并在结束后 SIGKILL，不连接宿主已运行的 daemon，避免干扰
  用户会话；UI 仅在展开「指定模型」时查询一次，控制进程开销。
- UI 用原生 datalist 而非自绘下拉：天然保留手填回退，零新增样式与交互面。
- AGENTS.md「不提供 CLI/App Server 兜底」针对执行兜底；本次显式登记只读目录查询例外，
  执行、投递与续接链路不变，防止边界被误读为放开。
- 兼容与回滚：MCP 契约纯新增，v4 存储与既有工具零改动；回滚还原相关文件即可，
  无数据迁移与工作区副作用。

## 验证结果

- 命令与结果（均通过，60s 硬超时内）：
  - `pnpm build`：通过。
  - `pnpm test`：140 项通过（新增 core stub 全链路 4 项：分页聚合/字段映射、通知行与
    非 JSON 忽略、RPC error/超时/提前退出/命令缺失统一 MODEL_CATALOG；mcp 契约 1 项）。
  - `pnpm smoke`：通过（18 工具断言更新）。
  - `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
  - `node --test ui/test/native-execution.test.mjs`：23 项通过（新增 toModelOptions 1 项）。
  - `pnpm build:plugin` + `pnpm verify:plugin`：bundle 重建，20 工具断言通过。
- 真实环境验证：以编译产物直连本机 codex app-server（codex-cli 0.155.0）返回 47 个模型
  （`defaultModelId: gpt-6-astra`，含 `cliproxy/*`、`zcode-*` 等网关模型），
  未操作用户真实看板数据。
- **Web 验收（14:0x 追加）**：`pnpm sidebar`（端口 7433，真实看板数据）+ Chrome DevTools
  驱动验证。验收中发现并修复一个问题：初版用 effect cleanup 取消在途目录请求，
  BoardContext 轮询持续替换 task 对象使 cleanup 误判过期、丢弃响应并永久停留 loading；
  改为 ref 一次性守卫的事件驱动拉取，不再随轮询取消。
  另：验收时段 codex 动态目录一度回落为内置集（约 5 个可见模型、约 5s 延迟），
  `codex debug models` 同步呈现 9 个/0 网关——属宿主目录状态，TaskLane 如实镜像。
- **合并单一模型下拉后的复验（14:3x）**：Chrome 驱动验证单一 select（无输入框、无
  datalist），默认项「继承宿主默认模型」，网关目录恢复后加载 47 个模型
  （cliproxy/*、zcode-*、codebuddy-intl/* 等全部在列），选择/切回默认生效，
  状态行「已获取宿主可用模型 47 个」。截图：
  `docs/acceptance/20261004-model-select-merged-web.png`（前一版 datalist 验收截图
  `20261004-model-catalog-web.png` 保留存档）。`node --test ui/test/native-execution.test.mjs
  ui/test/task-detail-controls.test.mjs` 27 项全部通过（并行任务已同步其版本断言）。
- 未覆盖场景：Codex 原生宿主（Desktop 面板）内的下拉交互仍待原生验收。

## 变更统计

> 仓库尚无提交（unborn main）且工作区含其他任务的未提交改动：修改文件按
> 「任务前内容重建对比」统计（本次会话每处编辑的精确前后内容反向重建，逐一断言命中）；
> 新增文件对 `/dev/null` 比较；`plugins/tasklane/` 为重建产物，其 diff 含其他任务
> 未提交源码的产物化内容，不归属本任务。历史记录自身不计入。

- **统计口径**：编辑前后重建 diff + 新增文件 `--no-index`；基线为当日 1205 任务
  （模型 ID 输入版）完成后的工作区状态，故含对该版双控件 UI 的移除；排除 bundle
  产物与本记录。
- **变更文件数**：18（14 修改 + 4 新增；另有 bundle 产物重建与验收截图）
- **新增行数**：+620（修改文件 +127、新增文件 +493）
- **删除行数**：-47

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/model-catalog.ts` | +198 | -0（新增） |
| `packages/core/test/model-catalog.test.ts` | +117 | -0（新增） |
| `mcp/test/model-catalog.test.ts` | +77 | -0（新增） |
| `docs/exec-plans/completed/app-server-model-catalog.md` | +101 | -0（新增） |
| `ui/src/components/TaskDetail.tsx` | +21 | -30 |
| `mcp/src/register.ts` | +27 | -2 |
| `ui/src/state/nativeExecution.ts` | +22 | -0 |
| `ui/test/native-execution.test.mjs` | +22 | -0 |
| `mcp/src/handlers.ts` | +6 | -0 |
| `ui/src/i18n/nativeMessages.ts` | +10 | -6 |
| `mcp/src/server.ts` | +5 | -3 |
| `AGENTS.md` | +3 | -0 |
| `scripts/smoke.mjs` | +3 | -3 |
| `README.md` | +2 | -1 |
| `docs/native-execution-contract.md` | +2 | -0 |
| `packages/core/src/errors.ts` | +1 | -0 |
| `packages/core/src/index.ts` | +1 | -0 |
| `scripts/verify-plugin.mjs` | +1 | -1 |
| `scripts/build-plugin.mjs` | +1 | -1 |
| `plugins/tasklane/`（bundle 重建） | — | —（含其他任务产物化差异，不计入） |

## 修改文件

- `packages/core/src/model-catalog.ts`、`packages/core/src/errors.ts`、`packages/core/src/index.ts`
- `packages/core/test/model-catalog.test.ts`
- `mcp/src/server.ts`、`mcp/src/handlers.ts`、`mcp/src/register.ts`、`mcp/test/model-catalog.test.ts`
- `ui/src/components/TaskDetail.tsx`、`ui/src/state/nativeExecution.ts`、`ui/src/i18n/nativeMessages.ts`
- `ui/test/native-execution.test.mjs`
- `scripts/smoke.mjs`、`scripts/verify-plugin.mjs`、`scripts/build-plugin.mjs`
- `AGENTS.md`、`README.md`、`docs/native-execution-contract.md`
- `docs/exec-plans/completed/app-server-model-catalog.md`
- `docs/acceptance/20261004-model-select-merged-web.png`、`docs/acceptance/20261004-model-catalog-web.png`（web 验收截图）
- `plugins/tasklane/`（`pnpm build:plugin` 重建产物；含并行任务 APP_VERSION 0.3.5 的产物化内容）

## 后续事项

- 无阻塞性事项。可选跟进：原生宿主内下拉交互验收（与既有未验收 UI 项合并取证）；
  目录结果短 TTL 缓存与 reasoning level 透传按范围排除，未登记技术债。
