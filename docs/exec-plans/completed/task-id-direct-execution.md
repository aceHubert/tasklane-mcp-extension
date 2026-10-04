# 分发任务 ID，绑定与回执交给执行会话

- 状态：已完成（原生验收通过）
- 创建日期：2026-10-04
- 最后更新：2026-10-04
- 负责人：Codex 主代理；并行代理负责提示词回归
- 关联历史记录：[变更记录](../../histories/2026-10/20261004-1952-task-id-direct-execution.md)、[执行会话自绑定变更](../../histories/2026-10/20261004-2131-native-execution-target-self-bind.md)

## 目标与范围

按用户最终决定取消准备 JSON、反向回传和二次发送正文，并把绑定与执行回执全部交给最终执行会话。当前会话认领、创建一次并把任务 ID 与执行要求分发后即结束；执行会话凭任务 ID 自行核验真实身份与工作区、完成 created→bound 绑定、执行并通过 MCP 直接更新状态，不依赖会话间通讯。

## 协议

- 创建 prompt 只传任务 ID（id/boardId）和执行要求：执行任务并用 TaskLane 工具把执行状态和结果更新到看板；不复制标题描述，不含会话角色或先后关系说明。
- 当前会话认领后调用一次 create_thread 把提示词原样分发，随即结束：不等待创建结果、不调用 wait_threads/read_thread 获取目标身份、不保存绑定、不移动看板列。clientThreadId 是异步创建的正常返回，不得当作真实 threadId 或写入绑定，也不重建。
- 执行会话用 task_get 读取任务与本轮 requestId/runId/claimId，用 CODEX_THREAD_ID 作候选并 read_thread 核验自身 id/hostId/cwd 与看板仓库一致，然后携本轮关联调用 task_execution_bind phase=created→phase=bound（workspacePath 用实际 cwd，worktree/existing 提供实际分支）。
- 执行会话自行执行并回报实际状态；只有实际执行的目标能报 running/completed。Ready 到 Doing 的移列由核心在首个有效 running 回执时同一事务完成；并发目标已 Doing/Review/Done 不回退。绑定前阻塞携原 claimId 写 delivery blocked，绑定后由目标 report blocked。
- 不调用反向 send_message_to_thread，不使用 handoff/CLI 执行器兜底，不执行旧审批拒绝的回传。

## 验证与交付

- UI 协议回归与类型检查、插件构建/验证，每命令硬超时 60 秒。
- 按此前明确授权由 Agent 安装本地新包并校验缓存；不让用户自行安装。
- 不创建新的真实任务或操作现有失败任务，真实端到端另行验收。

## 进度

- [x] 固定用户最新分工并完成提示词和技能。
- [x] UI 47 项测试、类型检查、插件构建与验证通过；0.3.11 已安装并逐文件核对缓存与产物一致。
- [x] 记录取消回传方案与本轮历史；没有创建或恢复真实任务。
- [x] 按用户确认改为当前会话确认 threadId/worktree 后直接绑定；create_thread 提示词最小化为任务 ID 与执行回执要求，技能、UI 提示词回归测试同步更新。
- [x] 版本升至 0.3.12（含 widget 资源 URI v0312 缓存键），`pnpm build:plugin` 重建后 `verify:plugin` 全过，安装至 `~/.codex/plugins/cache/tasklane/tasklane/0.3.12/` 并逐文件核对一致；待用户重启 Codex 后原生验收。
- [x] 技能更名为 native-execution 并全英文化，调用点统一「tasklane native-execution」写法；版本升至 0.3.13 并安装至缓存核对一致；待重启后验收新技能名触发。
- [x] 按用户确认把绑定与执行回执全部交给执行会话：当前会话创建即结束，移除 wait_threads/read_thread 目标身份获取与 5 分钟 blocked 兜底；版本升至 0.3.14 并安装核对。
- [x] 原生异步创建到目标独立执行的实际验收通过（TASK-117/TASK-118，详见[验收记录](../../acceptance/20261004-native-self-bind-worktree-e2e.md)）：
  用户在原生面板任务详情选择「独立 worktree」并点击「执行」，派发聊天仅一次 create_thread 分发任务 ID 后即结束；
  目标聊天自行核验真实身份与独立 worktree，以同一真实结果完成 created→bound（provider=codex-desktop），
  真实 running 回执自动驱动 Ready→Doing，只读检查通过后自行报告 completed 并流转 review。
  TASK-117 五项验收全过；TASK-118（真实联网查询任务）以同协议二次跑通，请求均 completed，无重复创建。
