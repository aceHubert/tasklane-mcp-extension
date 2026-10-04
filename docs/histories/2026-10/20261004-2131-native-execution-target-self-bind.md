## [2026-10-04 21:31 +0800] | 任务：Run Codex 绑定与回执改由执行会话自行完成

### 执行上下文

- **Agent ID**：`claude`（Claude Code）
- **Base Model**：`claude-fable-5-1`
- **Runtime**：`Claude Code（macOS darwin 25.6.0 arm64）`
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`（unborn HEAD，仓库尚无任何提交，全部改动位于工作区）
- **关联计划**：[docs/exec-plans/completed/task-id-direct-execution.md](../../exec-plans/completed/task-id-direct-execution.md)

### 用户诉求

> 中间会话更新状态不靠谱,也以要更新Run Codex 的流转方式, 更新task 都交给最后执行的thread 去更新,就不存在wait_threads 和read_thread 了,中间会话只创建会话以及把执行task和更新状态的流程分发就好了,因为mcp工具是所有会话都共享通用的,这样就不存在会话通讯异常而block的问题

### 变更概览

**影响范围**：`ui/src/`、`ui/test/`、`extension/plugin-src/skills/`、`extension/`、`scripts/`、`README.md`、`WORKFLOW.md`、`AGENTS.md`、`docs/`。

**主要操作**：

- **dispatchNativeExecution start 分支重写**：删除「wait_threads/read_thread 确认 → created→bound 绑定 → task_move doing → 5 分钟 blocked 兜底」四条指令，改为「create_thread 一次 + 原样分发提示词，创建发起后即结束」；新增「clientThreadId 是异步创建的正常返回，不是异常：不得当作真实 threadId、不得写入绑定、也不重建」。
- **技能 native-execution 同步**：创建章节改为「创建即结束」（不等待创建结果、不获取目标身份、不保存绑定、不移动看板列）；执行指定任务章节新增执行会话自绑定步骤（task_get 读取 requestId/runId/claimId → CODEX_THREAD_ID 候选 + read_thread 自核验 → task_execution_bind created→bound → 执行 → running/completed 回执；绑定前阻塞携原 claimId 写 delivery blocked）。
- **文档同步**：WORKFLOW.md 第 4 节流程图/分工、4.2 表格、第 5 节闭环；AGENTS.md 关键设计决策；原生执行契约「握手与实际任务」；README 与 extension/README 流程描述。
- **测试同步**：native-execution.test.mjs 起始流程断言改为「创建即结束」形态（消息不含 wait_threads/task_execution_bind/task_move/5 分钟，含 clientThreadId 正常返回与新会话自行核验绑定要求）；提示词最小化断言保持不变。
- **版本升级与安装**：0.3.13→0.3.14（marketplace、两份 plugin.json、serverInfo、widget 资源 URI 缓存键 v0314、APP_VERSION、verify-plugin 校验、extension/README、UI 测试期望）；`pnpm build:plugin` 重建、`verify:plugin` ALL PASS，安装至 `~/.codex/plugins/cache/tasklane/tasklane/0.3.14/` 并逐文件 SHA-256 核对一致。

### 设计动机

真实验收（TASK-110～TASK-116）证明：worktree 异步创建仅返回 clientThreadId，接收会话无法通过 list_threads/wait_threads/read_thread 取得真实 threadId，也不存在创建状态查询接口；目标会话回传被自动审批拒绝（TASK-115，即使有用户明确授权）。而执行会话天然持有自身真实 ID（CODEX_THREAD_ID + read_thread 自核验），且 TaskLane MCP 工具对所有会话通用——由执行会话自行完成 created→bound 绑定与执行回执（TASK-110 已验证该机制可行），中间会话创建即结束，可完全消除会话通讯阻塞。核心校验（claimId/hostId 匹配、绑定不可替换、终态不回退）零改动。

### 验证结果

- 命令与结果：
  - `node --test ui/test/native-execution.test.mjs`：32/32 通过。
  - `node --test ui/test/*.mjs`：47 项中 43 通过；4 项 task-detail-controls 失败为并行会话 TaskDetail「会话核对按钮」进行中改动，与本任务无关。
  - `pnpm --filter @tasklane/ui typecheck`：通过。
  - `pnpm build:plugin`：成功（server 836KB、widget 717KB）；`node scripts/verify-plugin.mjs`：ALL PASS（含「面板和技能按任务 ID 直接执行，绑定与回执交给执行会话」新断言）。
  - 安装核对：`~/.codex/plugins/cache/tasklane/tasklane/0.3.14/` 与 `plugins/tasklane/` 全部文件 SHA-256 一致；产物内新流程文本、0.3.14 版本与 v0314 资源 URI 核对通过。
- 手工验证及环境：未执行；原生端到端（真实 create_thread → 执行会话自绑定 → running/completed）按计划另行验收。
- 未覆盖场景：执行会话在绑定落库前调用 task_execution_report 的重读行为、worktree 就绪前执行会话首轮与绑定的先后顺序，均需重启 Codex 后的原生验收确认。

### 变更统计

> unborn HEAD，无提交基线；按本任务替换段落统计（不含并行任务改动）。

- **变更文件数**：16（源）+ 构建产物
- **新增行数**：+179
- **删除行数**：−181

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/state/nativeExecution.ts` | +5 | −7 |
| `ui/test/native-execution.test.mjs` | +28 | −34 |
| `extension/plugin-src/skills/native-execution/SKILL.md` | +27 | −26 |
| `WORKFLOW.md` | +17 | −19 |
| `AGENTS.md` | +5 | −4 |
| `docs/native-execution-contract.md` | +6 | −6 |
| `docs/exec-plans/active/task-id-direct-execution.md` | +75 | −71 |
| `scripts/verify-plugin.mjs` | +4 | −3 |
| `extension/README.md` | +5 | −4 |
| `README.md` | +1 | −1 |
| 版本引用（6 个文件各 1 行） | +6 | −6 |

### 修改文件

- `ui/src/state/nativeExecution.ts`、`ui/test/native-execution.test.mjs`
- `extension/plugin-src/skills/native-execution/SKILL.md`
- `WORKFLOW.md`、`AGENTS.md`、`README.md`、`docs/native-execution-contract.md`
- `docs/exec-plans/active/task-id-direct-execution.md`
- `scripts/verify-plugin.mjs`
- `extension/README.md`、`extension/src/plugin-server.mjs`、`extension/src/widget.mjs`
- `extension/plugin-src/plugin.json`、`extension/plugin-src/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json`
- `ui/src/mcp/appsClient.ts`
- `plugins/tasklane/`（重建产物）

### 后续事项

- 待用户重启 Codex 加载 0.3.14；重启后按新流程做一次真实 Run Codex 验收（当前会话创建即结束，执行会话自行绑定并回执）。
- TASK-116 的现场可用已知真实聊天 ID `01a106f3-580f-7052-b20b-b4a2d9e7fc49` 手工恢复，或直接留给新流程验收。
- read_thread 仅保留在认领方自证身份与「核对会话状态」恢复流程；Run Codex 创建段不再调用 wait_threads/read_thread。
- 并行会话的 4 个 task-detail 测试失败（会话核对按钮）随 0.3.14 一并打包，归属并行任务收尾。
