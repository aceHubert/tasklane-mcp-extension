## [2026-10-08 12:23 +0800] | 任务：验收受阻时禁止继续修改

### 执行上下文

- **Agent ID**：`codex`，通过 collab 并行完成 UI 修改和独立代码审查。
- **Base Model**：`GPT-6`。
- **Runtime**：Codex Desktop，本地 Bash、Node.js、pnpm。
- **Git User**：`hubert <hubert@lejian.com>`。
- **Branch**：`main`。
- **关联计划**：无；本次为已有执行入口的局部守卫修复。

### 用户诉求

> 先修改继续修改的逻辑，验收受阻时不能继续执行。

### 变更概览

**影响范围**：核心执行准入、MCP 契约测试、UI 守卫与文案、执行契约文档。

- 当前验收执行状态或按验收 runId 匹配的请求为 blocked 时，核心拒绝所有实现请求，
  包括 start/reply/continue/retry 和相同请求重放；认领时也按磁盘最新数据重新检查。
- UI 的普通实现入口和「继续修改」入口使用相同判断，禁用操作并解释应先恢复验收、
  形成结论并结束本轮验收执行。打开验收聊天入口保留。
- 新增测试覆盖无结论、已结论、待复查、两套状态不一致、请求后出现阻塞、
  不同历史 runId 的 blocked 请求，以及当前验收完成后的正常返工。

### 设计动机

验收受阻不构成返工结论。此前继续修改仅检查实现聊天，可能在验收仍 blocked 时
发起实现执行。本次以当前验收代次为准，在请求和认领事务内拒绝操作，不修改负责人、
执行代次或时间线，也不自动结束验收或取消请求。历史请求和历史 blocked 回执不会误拦
当前已完成的验收。输入输出参数和持久化结构保持现有契约，无需迁移。

### 验证结果

- 先添加核心回归测试，确认原实现未返回预期验收受阻错误；新增守卫后通过。
- `pnpm build`：通过。
- `pnpm test`：最终 300 项全部通过。
- `pnpm smoke`：通过，使用临时数据目录和临时 Git 仓库。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
- `node --test ui/test/*.test.mjs`：93 项全部通过。
- 上述自动化检查使用 60 秒硬超时，超时后终止对应命令。
- 独立代码审查指出测试覆盖缺口，补齐后再次复核，无遗留问题；`git diff --check` 通过。
- 浏览器独立模式：使用真实 TaskDetail、host 守卫、中文文案及样式，配合临时模拟数据，
  不连接真实 MCP 或用户看板。420×900 窄栏、1280×900 宽抽屉均确认修改按钮禁用并显示说明。
  当前请求 blocked 而执行快照 completed 时仍禁用；本轮 completed 且保留历史 blocked 时
  修改按钮恢复，点击只记录一次模拟修改；受阻时打开验收聊天的模拟动作仍可用。
- 内置 Chrome 两次因请求头策略加载失败未能初始化，改用 ego-browser 技能完成浏览器验证。
- 未覆盖场景：Codex 原生面板独立验收、已安装插件重新加载；本次未发布插件，未写真实任务数据。

### 变更统计

- **统计口径**：项目原有大量暂存和未暂存修改；逐文件与本次修改前临时快照执行
  `git diff --no-index --shortstat` 和 `git diff --no-index --numstat`，排除既有改动、
  构建产物、临时浏览器模拟页及本历史记录。
- **变更文件数**：9。
- **新增行数**：+291。
- **删除行数**：-1。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | 11 | 0 |
| `packages/core/test/review-flow.test.ts` | 130 | 0 |
| `mcp/test/review-contract.test.ts` | 33 | 0 |
| `docs/native-execution-contract.md` | 5 | 0 |
| `ui/src/host.ts` | 8 | 1 |
| `ui/src/i18n/nativeMessages.ts` | 2 | 0 |
| `ui/test/review-controls.test.mjs` | 33 | 0 |
| `ui/test/native-execution.test.mjs` | 39 | 0 |
| `ui/test/review-linked-continuation.test.mjs` | 30 | 0 |

### 修改文件

见上表，另新增本历史记录。未执行 git add、commit 或 push。

### 后续事项

验收结论与执行终态的原子收尾，以及其他非 blocked 状态的结论准入规则，另行设计。
本次完成用户要求的 blocked 场景守卫。
