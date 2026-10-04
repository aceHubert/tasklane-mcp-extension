## [YYYY-MM-DD HH:mm +0800] | 任务：<简短的任务动词>

### 执行上下文

- **Agent ID**：`如实填写，例如 codex / claude-code / cursor`
- **Base Model**：`如实填写；无法确认时写未知`
- **Runtime**：`如实填写运行环境；无法确认时写未知`
- **Git User**：`姓名 <邮箱>`，分别取自 `git config user.name` 和 `git config user.email`
- **Branch**：`当前分支名；分离 HEAD 时注明状态与提交；未配置时如实说明`
- **关联计划**：`docs/exec-plans/active/<task-slug>.md` 或“无”；归档后更新链接。

### 用户诉求

> 用户请求原文，或压缩后的脱敏版本。

### 变更概览

**影响范围**：例如 `packages/core/`、`mcp/`、`ui/`、`scripts/` 或 `docs/`。

**主要操作**：

- **操作一**：简洁说明改动点。
- **操作二**：简洁说明改动点。

### 设计动机

简洁说明为什么这么改，以及关键取舍。涉及持久化、MCP 契约或 Git 工作区时，补充兼容、备份及回滚方式。

### 验证结果

- 命令与结果：记录实际运行的命令、通过 / 失败 / 超时；未运行写“未执行”。
- 手工验证及环境：UI 说明视口与独立浏览器 / 原生宿主；Git/存储说明临时环境。
- 未覆盖场景：

### 变更统计

> 使用 `git diff --shortstat <base>..HEAD` 与 `git diff --numstat <base>..HEAD`，仅统计本次任务。未提交、新增文件或无有效 HEAD 的统计方法见 `docs/HISTORY_GUIDE.md`。

- **统计口径**：填写基线、任务文件范围及汇总方式；默认排除历史记录自身。
- **变更文件数**：N（包含空的新增占位文件）
- **新增行数**：+X
- **删除行数**：-Y

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/board-store.ts` | 待填 | 待填 |
| `mcp/test/tools.test.ts` | 待填 | 待填 |

### 修改文件

- `packages/core/src/board-store.ts`
- `mcp/test/tools.test.ts`

### 后续事项

- 无 / 明确推迟的事项及 `docs/exec-plans/tech-debt-tracker.md` 对应条目。
