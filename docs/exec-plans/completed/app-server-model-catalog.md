# 通过 codex app-server 只读查询宿主模型目录（model_list）

- 状态：已完成
- 创建日期：2026-10-04
- 最后更新：2026-10-04
- 负责人：hubert / zcode
- 关联历史记录：`docs/histories/2026-10/20261004-1333-app-server-model-catalog.md`

## 目标

TaskLane 在创建会话前的「指定模型」输入支持从当前 Codex 宿主获取可选模型列表：
新增只读 MCP 工具 `model_list`，通过 `codex app-server` 的 JSON-RPC `model/list`
方法（initialize 握手 → 分页拉取）返回与宿主选择器一致的目录；UI 在「指定模型」
输入框附加下拉候选（datalist），获取失败时静默回退手动输入。

## 范围

- 包含：
  - `packages/core/src/model-catalog.ts`：`ModelCatalogService`，spawn `codex app-server`、
    JSON-RPC 握手、`model/list` 分页聚合、超时与错误映射（新增 `MODEL_CATALOG` 错误码）。
  - `mcp/`：注册 `model_list` 工具（`createServer` 选项注入服务，独立模式与插件模式共用）。
  - `ui/`：TaskDetail「指定模型」input + datalist 候选、获取失败提示、中英文 i18n。
  - `scripts/smoke.mjs`、`scripts/verify-plugin.mjs` 工具清单断言更新；插件 bundle 重建。
  - 文档：AGENTS.md 边界修订、README 工具说明、native-execution-contract.md 备注。
- 不包含：
  - 不改变执行链路：`model_list` 仅只读查询，不作为执行、投递或兜底执行器。
  - 不做 reasoning level 选择透传（目录字段返回，UI 仅用 id/displayName/isDefault）。
  - 不连接宿主已运行的 app-server daemon（避免干扰用户会话）；每次查询独立进程。
  - 不做结果缓存与 `TASKLANE_CODEX_BIN` 类配置面（后续按需追加）。

## 背景

- 相关文档：`docs/histories/2026-10/20261004-1205-execution-model-selection.md`（当时结论：
  「当前没有宿主模型目录接口」，因此仅提供模型 ID 手填）。
- 相关代码路径：`mcp/src/register.ts`、`mcp/src/handlers.ts`、`ui/src/components/TaskDetail.tsx`、
  `ui/src/i18n/nativeMessages.ts`。
- 当前行为与问题：模型 ID 需要用户手工输入，无法知道宿主实际可用哪些模型。
- 已知约束（本机已实测，2026-10-04，codex-cli 0.155.0）：
  - `codex app-server` stdio JSON-RPC：`initialize`（clientInfo）→ `model/list`
    （params 支持 cursor/includeHidden/limit）返回 `{data: Model[], nextCursor}`，
    Model 为 camelCase（id/displayName/isDefault/hidden/supportedReasoningEfforts）。
  - AGENTS.md 既定边界「不提供 CLI、App Server…兜底」针对执行兜底；本计划引入的是
    只读目录查询，需在 AGENTS.md 中显式区分，不构成执行兜底。
- 协议字段实测样本：`{"id":"gpt-6-astra","displayName":"GPT-6-Astra","isDefault":true,
  "hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low",...}]}`。

## 风险

- 风险：`model/list` 属 app-server 实验性协议，字段或方法名可能随 codex 版本变化。
  缓解：字段读取宽松兼容（`id ?? slug`、`displayName ?? display_name`）；错误统一映射
  `MODEL_CATALOG`，UI 失败回退手填，不影响其他工具。
- 风险：PATH 中无 `codex` 二进制或 app-server 启动失败（bridge/浏览器独立模式）。
  缓解：仅 UI「指定模型」候选受影响并明确提示；手填与宿主默认模型路径不变。
- 风险：额外进程开销（每次查询 spawn 一次）。
  缓解：UI 仅在展开「指定模型」时按需查询一次；超时默认 15s 后终止进程。
- 兼容与备份策略：MCP 契约纯新增工具，不改动既有工具与 v4 存储结构；旧客户端不受影响。
- 回滚方式：还原 `model-catalog.ts`、register/handlers、UI 与文档改动即可；
  无数据迁移、无分支或工作区副作用。

## 里程碑与并行边界

1. 调研与方案收敛：已完成（协议实测、双方案对比，用户选定 app-server 方式）。
2. 分阶段实现：core 服务 → mcp 工具 → UI 候选；文件互不重叠，可顺序提交。
3. 整合验证、交付与收尾：build/test/smoke/verify-plugin + 真实 codex 目录查询 + bundle 重建。

- 可并行任务、负责人及文件范围：core（`packages/core/src|test/model-catalog*`）与
  UI i18n（`ui/src/i18n/nativeMessages.ts`）可并行；register 与 smoke 断言串行。
- 必须串行的依赖：mcp 工具注册依赖 core 服务导出；verify-plugin 依赖 bundle 重建。

## 验证方式与验收标准

- 自动化命令：`pnpm build`、`pnpm test`、`pnpm smoke`、`pnpm verify:plugin`
  （工具契约变更须补 smoke）、`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`。
- UI 检查：datalist 候选渲染、断连/失败回退手填、中英文提示。
- 环境与边界：自动化测试最长 60 秒硬超时；core 测试用 stub app-server（node 脚本），
  不依赖真实 codex；真实目录查询单独一次性验证，不操作用户看板数据。
- 可观察的验收条件：
  1. `tools/list` 含 `model_list`，契约测试与 smoke 通过。
  2. stub 全链路（分页、通知行忽略、RPC error、超时、进程退出、命令不存在）全覆盖。
  3. 真实环境 `model_list` 返回非空模型列表（本机预期 47 个，含网关模型）。
  4. UI 指定模型出现候选下拉；获取失败时输入与提交流程不受影响。
- 实际结果与未覆盖场景：
  - 全部验收条件达成：`pnpm test` 140 项通过（含 stub 全链路与 mcp 契约测试）；
    `pnpm smoke`（18 工具断言）、`pnpm verify:plugin`（20 工具断言）、UI typecheck、
    UI 测试 23 项、`pnpm build:ui`、`pnpm build:plugin` 均通过。
  - 真实环境一次性验证：`ModelCatalogService` 直连本机 codex app-server 返回
    47 个模型（default gpt-6-astra，含 40 个网关模型），未操作用户看板数据。
  - 未覆盖：Codex 原生宿主内 UI 下拉的实际交互验收（datalist 渲染仅经类型检查、
    构建与单元测试，未做浏览器/原生面板手工截图验收）；`model/list` 协议在其他
    codex 版本上的字段差异（已做宽松映射，风险见上）。

## 进度记录

- [x] 确认范围、约束和工作区已有改动。
- [x] 完成第一个实现阶段。
- [x] 完成整合验证并记录实际结果。
- [x] 将明确推迟的事项登记到技术债表。（无明确推迟项；目录缓存与 reasoning 透传按范围排除，不构成技术债）
- [x] 补齐关联历史记录，在授权范围内完成归档并更新链接。

## 决策记录

- 2026-10-04：用户在 `codex debug models` 与 app-server `model/list` 两方案中选定
  app-server 方式（宿主官方通道、字段更规范）；每次查询独立 spawn 进程，
  不连接已运行 daemon，避免干扰用户宿主会话。
- 2026-10-04：UI 采用原生 datalist 而非自绘下拉：保留手填回退能力、零新增交互样式面；
  仅在用户选择「指定模型」时按需查询一次，避免每次打开详情都拉起 app-server 进程。
- 2026-10-04：AGENTS.md「不提供 CLI/App Server 兜底」条款保留并显式登记 model_list
  例外，明确其为只读目录查询、不在执行链路上，防止后续误读为边界放开。

## 阻塞点与下一步

- 当前阻塞：无。
- 下一步：无；原生宿主内的下拉交互验收留待下一次原生面板验收时顺带取证。
