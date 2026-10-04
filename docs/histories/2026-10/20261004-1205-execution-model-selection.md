## [2026-10-04 12:05 +0800] | 任务：创建会话前指定模型

### 执行上下文

- **Agent ID**：codex
- **Base Model**：未知
- **Runtime**：Codex Desktop，macOS，Node.js 22
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：无；本次是现有原生执行契约的可选参数扩展。

### 用户诉求

> 在当前 TaskLane 面板合适的位置增加创建会话前的模型设置。

### 变更概览

- 任务详情的工作区选项下、执行按钮上增加默认模型或指定模型 ID；提供中英文说明与输入校验。
- 模型随 start 请求保存、参与幂等比较并传入宿主消息；原生执行技能要求创建时使用该模型，不静默替换。
- 发送中及待确认请求锁定设置，刷新后使用持久化请求；已绑定时显示创建选择，续接动作不覆盖模型。
- 核心、存储、MCP 和 UI 测试覆盖边界、重复请求、重启读取、非法输入和后续动作。

### 设计动机

模型必须在 create_thread 前确定。当前没有宿主模型目录接口，因此提供模型 ID 输入，不硬编码可用型号。
model 为 v4 请求的可选字段，旧记录无需迁移，省略时保持宿主默认行为；不改实际工作区或已绑定会话。
模型记录只说明创建请求，不作为实际运行模型的证明。修改前保存逐文件快照，保留全部已有未提交内容。

### 验证结果

- `timeout 60s pnpm build`：通过。
- `timeout 60s pnpm test`：123 项通过。
- `timeout 60s node --test ui/test/native-execution.test.mjs`：15 项通过。
- `timeout 60s pnpm --filter @tasklane/ui typecheck`、`timeout 60s pnpm build:ui`：通过。
- `timeout 60s pnpm smoke`、`timeout 60s pnpm verify:twoproc`：通过，均使用临时数据/仓库。
- `git diff --check`：通过；仓库未配置 ESLint/Prettier。
- 内置 Chrome 连续连接超时，改用 ego-browser 独立浏览器及临时 bridge，看板数据保存在临时目录。
  验证 1280×900 宽视图、420×900 窄栏的默认/指定模型，窄栏无横向溢出；空模型错误提示、
  有效输入恢复、任务流转与断连禁用均通过。测试服务与验证页面已关闭。
- 未覆盖：Codex 原生宿主实际模型可用性及指定模型创建会话；未重新打包或安装发布插件。

### 变更统计

- **统计口径**：对每个文件执行 `git diff --no-index --shortstat` 与 `--numstat`，
  比较任务开始前逐文件快照和完成内容，排除已有修改、构建产物与本历史记录。
- **变更文件数**：14
- **新增行数**：+282
- **删除行数**：-15

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `docs/native-execution-contract.md` | 6 | 2 |
| `extension/plugin-src/skills/tasklane-native-execution/SKILL.md` | 5 | 1 |
| `mcp/src/register.ts` | 4 | 1 |
| `mcp/test/native-execution.test.ts` | 25 | 0 |
| `packages/core/src/board-store.ts` | 4 | 1 |
| `packages/core/src/native-execution.ts` | 12 | 1 |
| `packages/core/src/work-item.ts` | 5 | 0 |
| `packages/core/test/native-execution.test.ts` | 42 | 1 |
| `packages/core/test/store.test.ts` | 20 | 0 |
| `ui/src/components/TaskDetail.tsx` | 54 | 4 |
| `ui/src/i18n/nativeMessages.ts` | 20 | 0 |
| `ui/src/state/nativeExecution.ts` | 29 | 1 |
| `ui/src/state/useTaskActions.ts` | 3 | 3 |
| `ui/test/native-execution.test.mjs` | 53 | 0 |

### 修改文件

见上表；另新增本历史记录。未执行暂存、提交或推送。

### 后续事项

原生宿主验收仍遵循现有原生执行桥计划的边界；已安装插件需要更新构建后才能显示本次改动。
