## [2026-10-04 19:52 +0800] | 任务：按任务 ID 直接执行并等待 worktree 就绪

### 执行上下文

- **Agent ID**：Codex 主代理及并行测试代理
- **Base Model**：未知
- **Runtime**：Codex Desktop 本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[直接执行计划](../../exec-plans/completed/task-id-direct-execution.md)

### 用户诉求

> 不等待会话回传或打印准备结果。中间会话只创建一次，等异步 worktree 创建完成、读取真实会话 ID 后移到 Doing。目标按任务 ID 自取步骤，执行后直接用 MCP 更新状态。

### 变更与决策

- 初始 prompt 只携 task/board/request/run/claim 与执行要求，不复制任务正文；目标 task_get 读取步骤和本轮附加消息。
- 删除准备 JSON、反向回传和绑定后补发正文的协议。目标核验自身原生身份与 Git，沿原 claim 自行 created→bound 后执行并 report；审批拒绝的回传不重试。
- CODEX_THREAD_ID 只作为候选线索，必须 read_thread 核对 id/host/cwd/关联，不能当作认证凭证。
- 中间会话循环读取原生结果或 MCP result/binding，每次最多 50 秒，总计最多 5 分钟。真实 ID 与独立 Git worktree 都就绪才将 Ready 移到 Doing，目标已推进的阶段不回退；只有 clientThreadId 不能调用等待/读取工具或猜 ID。
- 循环耗尽前重读当前 run 和目标进展，未就绪才持久阻塞原因，不重复创建。Doing 不代替真实 running；任务会话直接回写执行结果。
- 版本、资源 URI 升至 0.3.11；取消并归档回传计划，保留原聊天和工作区。

### 验证与安装

- UI 47 项测试、类型检查、build:plugin、verify:plugin 通过，命令硬超时 60 秒。
- 提示词测试覆盖仅任务 ID、目标自行读步骤与绑定、异步就绪判定、循环超时、禁止旧 run 覆盖、禁回传与重复创建。
- 按用户既有明确授权，使用 Codex 官方 CLI 安装 tasklane@tasklane 0.3.11；核对两个清单、服务、面板及技能缓存与构建包逐字节一致。
- 未提交，未创建或恢复真实任务。重启 Codex 加载后仍须真实宿主验收；单元测试不证明异步工具返回真实 ID 的时序。

### 变更统计

- **口径**：生产文件相对本轮开始快照；UI 测试相对最终分工确认后的实际快照（不计已被替换的中间等待方案测试）。使用 git diff --no-index --shortstat/--numstat，新增计划相对 /dev/null。计划移动计一个文件，排除构建产物、安装缓存及本记录。
- **文件数**：17
- **新增/删除**：+116 / -119

| 范围 | 文件数 | 新增 | 删除 |
| --- | ---: | ---: | ---: |
| UI 提示与测试 | 2 | 39 | 28 |
| 执行技能 | 1 | 22 | 69 |
| 版本、资源与插件验证 | 8 | 12 | 12 |
| 契约、计划、技术债及历史链接 | 6 | 43 | 10 |

### 后续事项

使用实际任务验收目标自绑定/执行、中间会话核验 worktree 就绪与移列；若原生 ID 始终不可核验则保留 blocked，不绕过宿主限制。
