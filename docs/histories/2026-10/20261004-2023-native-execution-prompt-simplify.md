## [2026-10-04 20:23 +0800] | 任务：简化原生执行提示词为当前会话确认绑定

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`account:zai-individual-coding-plan/GLM-5.3`
- **Runtime**：`ZCode Desktop（macOS darwin 25.6.0 arm64）`
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`（ unborn HEAD，仓库尚无任何提交，全部改动位于工作区）
- **关联计划**：[docs/exec-plans/completed/task-id-direct-execution.md](../../exec-plans/completed/task-id-direct-execution.md)

### 用户诉求

> 修改 nativeExecution 中的提示词。现在的流程是：run codex 中当前会话组织如何创建会话，然后使用 wait_threads 确认 threadId 和 worktree（worktree 是异步创建的）；如果不是以 worktree 创建就可以直接更新 threadId。create_thread 就是告诉会话：根据 task_id 执行任务以及把执行结果使用 tool 更新到看板。提示词简洁明了，不要把中间会话、会话角色、先后关系等与执行任务无关的内容放进去。

### 变更概览

**影响范围**：`ui/src/state/`、`ui/test/`、`extension/plugin-src/skills/`、`plugins/tasklane/skills/`、`docs/`。

**主要操作**：

- **dispatchNativeExecution start 分支重写**：投递消息改为「当前会话调用一次 create_thread → wait_threads/read_thread 确认真实 threadId/hostId（非 worktree 确认后直接绑定；worktree 异步创建须等 cwd 为就绪独立工作区）→ 携本轮 requestId/runId/claimId 完成 task_execution_bind created→bound」；ready 移 doing 与 5 分钟 blocked 兜底保留。
- **create_thread 提示词最小化**：「独立执行请求」从约 700 字协议文本缩减为一句话：执行 TaskLane 任务 `{"id","boardId"}` 并用 TaskLane 工具把执行状态和结果更新到看板；删除身份核验、绑定、回执枚举、CODEX_THREAD_ID、SESSION_READY 等全部协议细节，以及会话角色 / 先后关系 / 等待其它消息的说明。
- **删除失效子句**：移除「初始 prompt 和后续任务消息均须包含异常回执要求」（提示词已最小化，回执要求由 MCP 工具描述与技能承载）。
- **技能与文档同步**：两份 tasklane-native-execution SKILL.md 的 Start 章节改为「创建任务会话（当前会话确认后绑定）+ 执行指定任务（最小 prompt）」；AGENTS.md 关键设计决策、活动执行计划协议段同步更新。
- **WORKFLOW.md 更新 Run Codex 流转**：第 4 节流程图改为「当前会话 create_thread 分发任务 ID → wait_threads 确认 threadId/worktree → 确认后 created→bound 绑定 → 目标聊天凭任务 ID 执行回执」并补充分工说明；4.2 表格 Run Codex 行与第 5 节原生闭环链路同步改写。
- **测试同步**：native-execution.test.mjs 提示词形态断言改为验证最小执行指令（不含 create_thread/task_move/task_get/task_execution_/claimId/CODEX_THREAD_ID、不含角色与先后关系词）与当前会话确认绑定流程。
- **版本升级与安装**：全仓版本引用 0.3.11→0.3.12（marketplace、两份 plugin.json、serverInfo、widget 资源 URI 缓存键 v0312、APP_VERSION、verify-plugin 校验、extension/README）；`pnpm build:plugin` 重建产物并重写 verify-plugin「按任务 ID 直接执行」断言为新设计标记；安装 0.3.12 至 Codex 插件缓存并逐文件 cmp 核对一致。

### 设计动机

按用户确认的新分工：绑定责任从新会话移回当前会话。当前会话通过 wait_threads/read_thread 已能核验新会话真实身份与 cwd（worktree 异步就绪后），由它直接完成 created→bound 更直接；新会话只凭任务 ID 自行读取执行并回执，初始 prompt 不再携带与执行无关的协议、角色或顺序说明。task_execution_bind/report 的核心校验（认领匹配、host 一致、绑定不可替换、终态不可回退）未改动，MCP 契约与存储层零变更，无兼容或回滚风险；回滚仅需还原上述文件。目标回报所需的 requestId/runId/threadId 可经 task_get 读取（executionRequests 与 executionBinding 均在任务数据中）。

### 验证结果

- 命令与结果：
  - `node --test ui/test/native-execution.test.mjs`：32 项中 31 通过；版本断言失配在本任务将 APP_VERSION 升至 0.3.12 后转绿。
  - `pnpm build:plugin`：成功（server 836KB、widget 717KB），产物含新提示词、新技能与 v0312 资源 URI。
  - `node scripts/verify-plugin.mjs`：ALL PASS（「按任务 ID 直接执行」断言已按新设计改写）。
  - 安装核对：`~/.codex/plugins/cache/tasklane/tasklane/0.3.12/` 与 `plugins/tasklane/` 全部 13 个文件 cmp 一致；旧协议文本（SESSION_READY、中间会话职责）零残留。
  - `node --test ui/test/*.mjs`：47 项中 42 通过；除上述版本失配外，另有 4 项 task-detail-controls 失败源于并行会话正在修改 `TaskDetail.tsx`（mtime 20:13，本任务未触碰），测试本身已整体桩掉 nativeExecution 模块。
  - `pnpm --filter @tasklane/ui typecheck`：通过。
- 手工验证及环境：未执行；原生端到端（真实 create_thread → wait_threads → 绑定 → 目标回报）按计划另行验收。
- 未覆盖场景：worktree 异步就绪前 wait_threads 的实际返回形态、目标在绑定落库前调用 task_execution_report 的重读行为，均需原生验收确认。

### 变更统计

> 仓库无任何提交（unborn HEAD），按 HISTORY_GUIDE 采用任务前快照对比；AGENTS.md 的 git 未暂存差异含并行任务改动，仅统计本任务段落替换。

- **统计口径**：任务前文件快照 vs 任务后文件；WORKFLOW.md 与 AGENTS.md 因未暂存差异含并行任务改动，按本任务替换段落精确统计；排除历史记录自身。
- **变更文件数**：7
- **新增行数**：+98
- **删除行数**：−88

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/state/nativeExecution.ts` | +6 | −5 |
| `ui/test/native-execution.test.mjs` | +33 | −32 |
| `extension/plugin-src/skills/tasklane-native-execution/SKILL.md` | +10 | −16 |
| `plugins/tasklane/skills/tasklane-native-execution/SKILL.md`（构建产物同步） | +16 | −20 |
| `docs/exec-plans/active/task-id-direct-execution.md` | +7 | −5 |
| `AGENTS.md`（关键设计决策条目） | +8 | −4 |
| `WORKFLOW.md`（第 4 节流转、4.2 表格、第 5 节闭环） | +18 | −6 |

### 修改文件

- `ui/src/state/nativeExecution.ts`
- `ui/test/native-execution.test.mjs`
- `extension/plugin-src/skills/tasklane-native-execution/SKILL.md`
- `plugins/tasklane/skills/tasklane-native-execution/SKILL.md`
- `docs/exec-plans/active/task-id-direct-execution.md`
- `AGENTS.md`
- `WORKFLOW.md`

### 后续事项

- 并行会话遗留：appsClient `APP_VERSION`（0.3.11）与测试期望（0.3.12）失配、TaskDetail 会话核对按钮 4 项测试失败，归属并行任务处理，本任务未触碰。
- `plugins/tasklane` 为构建产物手工同步；下次 `pnpm build:plugin` 会以 extension 源重新生成，行为一致。
- 待用户重启 Codex 加载 0.3.12；原生异步创建到独立执行的实际验收仍在[活动计划](../../exec-plans/completed/task-id-direct-execution.md)中待办。
- 并行会话的 4 个 task-detail 测试失败（会话核对按钮）随 0.3.12 一并打包，归属并行任务收尾。
