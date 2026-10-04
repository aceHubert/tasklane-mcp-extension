## [2026-10-03 21:20 +0800] | 任务：实施 Codex 原生执行桥与默认关闭门控

### 执行上下文

- **Agent ID**：`ZCode`（主代理整合，子代理按文件责任范围协作）
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；pnpm workspace、TypeScript、React、MCP Apps
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，没有有效 HEAD 差异基线
- **关联计划**：[codex-native-execution-bridge](../../exec-plans/completed/codex-native-execution-bridge.md)；真实宿主验收阻塞，保留 active

### 用户诉求

> 实施 codex-native-execution-bridge.md，采用 Codex 原生宿主路线，非 Codex 默认不执行，不使用备用执行器。

### 变更概览

**影响范围**：`packages/core/`、`mcp/`、`ui/`、`extension/`、`scripts/`、使用说明与执行计划。

- **请求与回执**：新增独立真实聊天绑定和持久请求数组、runId、唯一 claimId、created→bound 两阶段结果、reportId 幂等回执。五个执行工具显式指定 boardId，拒绝归档、旧代次、错误聊天/宿主及认领冲突，锁内合并保留并发编辑。
- **真实性修复**：普通 assign 不生成 sess-*、不创建工作区、不启停 Agent；Doing/Review 不伪造 running/completed。无关联 task_update.execution 拒绝并无部分编辑副作用。旧内部标识和 Git 绑定保留。
- **存储 v4**：兼容 v1/v2/v3，文件锁内重读、完整校验、备份 .vN.bak 后原子升级；新增损坏字段守卫及事务内迁移防嵌套锁回归。未迁移用户真实看板。
- **UI**：MCP Apps 实时身份与本次原生能力声明合取；声明最长 10 分钟、context/断连/重载失效，window.name 只缓存看板范围。工作方式明确选择，完整回复保存、超时待确认、不自动重复发送。真实绑定打开、旧状态未核实、Stop 常禁用。卡片和详情复用操作层，保留已有归档和中英文/设置改动。
- **插件与技能**：更新现有 Codex 源版本为 0.3.0，不另建 ZCode 插件；新增 tasklane-native-execution 技能并纳入构建验证。先空闲创建/绑定再发送任务，需实际 createThread 和 sendToThread 路由。无 CLI/App Server/后台/私有注入兜底。生成包通过构建流程更新，未安装或更新用户插件。
- **说明和记录**：新增最终契约，替换旧注入与假执行说明，登记真实宿主验收和停止接口债务。

### 设计动机

SDK 1.7.4 有 sendMessage/openLink，但标准能力没有原生创建、目标线程或可靠中断能力。
消息接口无 threadId 路由参数，必须交由接收 Agent 调用真实原生工具。只有成功握手的
明确 Codex 身份与当前验证声明一致才开放执行；声明是功能记录，不是认证。requestId、
hostId、claimId 均不提供身份认证。

工作区所有权属于原生宿主；TaskLane 只读核验 Git 根、所属仓库、分支及模式。旧工作区
不可静默切换或另建。请求落盘、认领与结果保存保护消息投递和宿主工具非原子边界；
结果未知保留待确认，不因超时创建第二个聊天。回滚不删除真实聊天或 worktree；已有新
写入时不能直接旧备份覆盖。升级实际用户数据前需先停用同目录旧写进程。

### 验证结果

所有自动化命令分别设置 **60 秒硬超时**，超时杀对应进程组；以下最终运行均无超时。

| 命令 | 最终结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm test` | **118/118 通过**，0 失败 |
| `node --test ui/test/native-execution.test.mjs` | **7/7 通过**，0 失败 |
| `pnpm smoke` | 通过；stdio 模拟新协议，不代表真实宿主 |
| `pnpm verify:twoproc` | 通过；临时数据双进程请求合并、认领竞争、绑定恢复、回执幂等与并发编辑 |
| `pnpm verify:git` | 通过；临时 Git 仓库，普通 assign 不创建、旧分支不重置、正确根/仓库/工作区模式核验 |
| `pnpm verify:bridge` | 通过；临时数据、Host/Origin/畸形消息/token 场景 |
| `pnpm --filter @tasklane/ui typecheck` | 通过 |
| `pnpm build:ui` | 通过 |
| `pnpm build:plugin` / `pnpm verify:plugin` | 通过；18 tools、项目/全局契约、双技能、声明缺省/过期/占位拒绝 |
| `git diff --check` | 通过；未声称 ESLint/Prettier 检查 |

初轮存在旧测试语义、返回值 undefined 与 JSON 落盘差异，以及迁移事务嵌套文件锁失败；
已分别修正并补回归。最终测试已重新通过，不能将初轮失败记成一次通过。

**独立浏览器**：内置浏览器 1280×720 宽视图和 360×800 窄栏，使用临时 home。
创建 Native bridge QA 并普通指派；人工 Ready→Doing 成功，落盘仍 assigned、无
sessionId/startedAt/请求/真实绑定/工作区。详情工作方式默认未选，Run/Reply/Retry/Open/Stop
禁用，文案为 Agent。可视检查窄栏卡片与详情排版；断连写入口全部禁用并有横幅，重连
任务保留、执行不自动开放。浏览器定位点击部分超时，按实际截图/可见节点改为真实
坐标点击或键盘操作完成，不把超时当作 UI 成功。测试服务均已停止。

**真实 Codex 宿主**：未验收、未创建聊天、未启动 Agent。仅核对公开桌面元数据
26.930.31730/build12947；当前会话没有原生聊天创建、目标线程发送或导航工具。
安装应用、scheme 注册、SDK 方法或插件冒烟不证明 project/global 的真实消息路由、
工作区复用或 widget 深链接可用；默认打开面板无声明，执行保持关闭。

### 变更统计

- **统计口径**：仓库无有效 HEAD 且任务前已有大量暂存/未暂存改动，使用任务开始前
  文件快照，通过 `git diff --no-index --shortstat` 与 `--numstat` 逐文件统计。新增文件
  对比 `/dev/null`，返回 1 表示差异而非失败；不包含历史记录自身。
- **排除范围**：已有设计资产、生成插件 bundle、其它会话的分支前缀、归档/UI 国际化及
  设置改动均不算作本次行数。共享文件同时存在其它任务的后续落盘，未能完全分离，
  因而将 TaskCard、TaskDetail、NewTaskForm、BoardContext、useTaskActions、types、styles、
  既有 messages、ui/README、core/git.test 和 marketplace 版本同步单列，不纳入数字汇总。
  下表是可明确隔离的 **35 个源码/协议/测试/说明文件统计**，不是全仓库 diff 总数。
- **变更文件数（可隔离范围）**：35
- **新增行数（可隔离范围）**：+3367
- **删除行数（可隔离范围）**：−881

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `README.md` | 57 | 82 |
| `WORKFLOW.md` | 49 | 103 |
| `docs/native-execution-contract.md` | 82 | 0 |
| `docs/exec-plans/active/codex-native-execution-bridge.md` | 45 | 25 |
| `docs/exec-plans/tech-debt-tracker.md` | 3 | 1 |
| `extension/README.md` | 62 | 89 |
| `extension/src/plugin-server.mjs` | 6 | 1 |
| `extension/src/widget.mjs` | 39 | 2 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 4 | 4 |
| `extension/plugin-src/plugin.json` | 4 | 4 |
| `extension/plugin-src/skills/open-tasklane/SKILL.md` | 1 | 1 |
| `extension/plugin-src/skills/tasklane-native-execution/SKILL.md` | 94 | 0 |
| `mcp/src/handlers.ts` | 34 | 1 |
| `mcp/src/register.ts` | 121 | 7 |
| `mcp/test/tools.test.ts` | 12 | 8 |
| `mcp/test/native-execution.test.ts` | 175 | 0 |
| `packages/core/src/board-store.ts` | 271 | 125 |
| `packages/core/src/engine.ts` | 44 | 140 |
| `packages/core/src/errors.ts` | 4 | 0 |
| `packages/core/src/work-item.ts` | 90 | 0 |
| `packages/core/src/native-execution.ts` | 326 | 0 |
| `packages/core/test/engine.test.ts` | 82 | 65 |
| `packages/core/test/store.test.ts` | 40 | 3 |
| `packages/core/test/native-execution.test.ts` | 770 | 0 |
| `scripts/build-plugin.mjs` | 7 | 5 |
| `scripts/verify-plugin.mjs` | 29 | 1 |
| `scripts/smoke.mjs` | 78 | 12 |
| `scripts/two-process-verify.mjs` | 105 | 21 |
| `scripts/git-verify.mjs` | 123 | 29 |
| `scripts/qa-agent.mjs` | 23 | 6 |
| `ui/src/host.ts` | 210 | 28 |
| `ui/src/mcp/appsClient.ts` | 108 | 118 |
| `ui/src/state/nativeExecution.ts` | 66 | 0 |
| `ui/src/i18n/nativeMessages.ts` | 99 | 0 |
| `ui/test/native-execution.test.mjs` | 104 | 0 |

### 修改文件

上述统计文件，以及共享整合文件：

- `ui/src/components/TaskCard.tsx`、`TaskDetail.tsx`、`NewTaskForm.tsx`
- `ui/src/state/BoardContext.tsx`、`useTaskActions.ts`、`ui/src/mcp/types.ts`
- `ui/src/i18n/messages.ts`、`ui/src/styles.css`、`ui/README.md`
- `packages/core/test/git.test.ts`（普通指派不创建工作区的测试语义）
- `.claude-plugin/marketplace.json`（保持已有市场 identity，源版本同步 0.3.0）
- `plugins/tasklane/` 构建产物：server、widget、manifest、两份技能；按构建流程生成，未手改。

### 后续事项

真实 Codex 项目/全局路由、正确工作区执行/复用、就绪线程和 widget 深链接验收仍需在
可使用原生工具的专用测试会话中完成；可靠停止接口未验证，Stop 禁用。已记录于
[技术债追踪](../../exec-plans/tech-debt-tracker.md)。源包等待目标宿主手动更新/加载，
真实试用未确认。计划仍 active，不宣称端到端真实执行已接通。未 git add/commit/push。
