## [2026-10-08 14:19 +0800] | 任务：已绑定续接消息明确拒绝后恢复可操作状态

### 执行上下文

- **Agent ID**：`codex`，collab 并行完成契约调研、提示与技能修改、独立代码审查。
- **Base Model**：`GPT-6`。
- **Runtime**：Codex Desktop，本地 Bash、Node.js、pnpm。
- **Git User**：`hubert <hubert@lejian.com>`。
- **Branch**：`main`。
- **关联计划**：[已完成执行计划](../../exec-plans/completed/bound-message-rejection-recovery.md)。

### 用户诉求

> 中间会话的 send_message 因审核被拒绝时应恢复状态，不应一直保持启动等待而无法操作。

### 变更概览

**影响范围**：core 投递回执和存储校验、MCP 契约、UI 续接指令、原生执行技能镜像及测试。

- 允许原认领者对已 bound、仍 starting 的 continue/reply/retry 写入明确投递拒绝，
  须匹配 claimId，且本轮没有 startedAt 或任何目标 reports，结果与原真实绑定完全一致。
- 拒绝后请求终态 rejected，实现执行复位 assigned/idle，验收执行复位 idle；
  保留本轮 runId、真实 result/binding、负责人和业务阶段，用户新请求复用原聊天。
- 存储严格校验允许受限的 rejected+result 续接记录，其他损坏组合仍拒绝。
- 中间会话的指令和技能明确审核拒绝使用 delivery rejected 并回读确认；
  不使用 delivery blocked 或目标 failed/completed 代替未投递，不自动重试。

### 设计动机

续接会先复用已有聊天完成 created→bound，然后发送用户消息。已有 result 只证明绑定，
不证明本轮正文已经投递。原来 delivery blocked 忽略 bound，delivery rejected 又一律拒绝
已有 result，导致明确未发送的续接一直停在 bound/starting。此次限定恢复资格，保留真实
聊天和工作区；任何目标回执、真实开始、首次 start 已有结果、仅 created 或绑定不一致时
均不能回退。消息结果未知继续保持等待，不把超时当作明确未发送。

输入字段、输出结构及存储枚举不变，但旧版严格存储读取器不支持 rejected+result。
部署时须同步升级读写服务；已产生新组合后不单独回滚旧读取器，保留部署前数据备份。
本次没有部署、没有修改用户真实任务或自动重发消息。

### 验证结果

- 新增核心回归用例先确认 continue/reply/retry 已 bound 后的拒绝被旧实现阻止，再修复。
- `pnpm build`：通过。
- `pnpm test`：最终 318 项全部通过。
- `pnpm smoke`：通过，临时数据目录和临时 Git 仓库。
- `pnpm verify:twoproc`：通过，临时数据目录下双进程一致性验证。
- `node --test ui/test/*.test.mjs`：95 项全部通过。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
- 自动化命令使用 60 秒硬超时；本轮均未超时。
- 核心测试覆盖错误/缺少 claimId、拒绝幂等、存储重开、畸形拒绝记录、用户新请求、
  首次创建保护、任意目标回执保护、未知发送结果，以及复查业务状态和绑定完整保留。
- 独立审查无阻塞问题；按建议补充两存储实例的拒绝与真实 running 竞态，
  验证两种提交顺序下仅一个事务结果生效，状态、回执与开始时间一致。
- 两份原生执行技能内容一致；`git diff --check` 通过。
- 未覆盖场景：在原生宿主重新触发自动审批拒绝、重新加载已安装插件。
  本次无界面结构或样式修改，未重复浏览器外观验收。

### 变更统计

- **统计口径**：逐文件与本任务修改前临时快照执行 `git diff --no-index --shortstat`
  和 `git diff --no-index --numstat`；新计划与 `/dev/null` 对比。排除任务前全部既存
  暂存及未暂存改动、构建产物和本历史记录。
- **变更文件数**：12。
- **新增行数**：+436。
- **删除行数**：-12。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | 12 | 3 |
| `packages/core/src/board-store.ts` | 11 | 2 |
| `packages/core/test/native-execution.test.ts` | 133 | 0 |
| `packages/core/test/review-flow.test.ts` | 41 | 0 |
| `mcp/test/review-contract.test.ts` | 38 | 0 |
| `mcp/src/register.ts` | 7 | 1 |
| `ui/src/state/nativeExecution.ts` | 3 | 0 |
| `ui/test/native-execution.test.mjs` | 64 | 0 |
| `extension/plugin-src/skills/native-execution/SKILL.md` | 22 | 2 |
| `plugins/tasklane/skills/native-execution/SKILL.md` | 22 | 2 |
| `docs/native-execution-contract.md` | 12 | 2 |
| `docs/exec-plans/completed/bound-message-rejection-recovery.md` | 71 | 0 |

### 修改文件

见上表，另新增本历史记录。未执行 git add、commit 或 push。

### 后续事项

部署时同步升级读写服务及重新加载插件，再验收原生宿主的明确拒绝场景。
