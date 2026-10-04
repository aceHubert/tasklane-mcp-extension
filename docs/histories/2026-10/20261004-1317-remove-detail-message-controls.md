## [2026-10-04 13:17 +0800] | 任务：移除详情下方消息控制区

### 执行上下文

- **Agent ID**：`ZCode`
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；React + TypeScript + Vite
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，不能使用 HEAD 作为差异基线
- **关联计划**：无，本次为明确限定的 UI 删除，不改原生执行契约

### 用户诉求

> 去掉下面消息这块，打开 Codex 会话先不管。

### 变更概览

**影响范围**：任务详情组件、UI 回归测试、UI 说明及现有插件版本同步。

- 删除完整回复输入框、回复／重试／停止按钮，以及“宿主尚无可靠中断接口”提示。
- 删除仅为此区域使用的 replyText 状态、任务切换重置和 reply/retry 禁用条件。
- 保留工作方式、模型选择、执行状态、请求错误、时间线和任务编辑；现有“打开会话”入口及处理逻辑不改。
- 保留底层消息 MCP 契约与操作层，不扩展此次删除范围。新增渲染回归覆盖宽抽屉和窄栏详情。
- 现有 TaskLane 插件身份与市场保持不变，源码版本同步为 0.3.4，并通过现有流程重建自包含插件包；未安装、更新或重启用户宿主。

### 设计动机

看板无需长期展示一套重复的聊天控制面板，用户可以在原生聊天中补充需求和操作执行。
本次只删除指定界面，不处理真实会话打开能力，不修改执行状态机、持久数据或既有绑定。

### 验证结果

- `pnpm --filter @tasklane/ui typecheck`：通过。
- `node --test ui/test/task-detail-controls.test.mjs ui/test/native-execution.test.mjs`：最终 **24/24 通过**。
  新增 2 个渲染测试遍历执行状态、是否绑定、连接状态和窄／宽详情，确认无消息控制区、仅保留任务描述 textarea，且会话入口、模型和工作方式仍在。
- `pnpm build:ui`：通过。
- `pnpm build:plugin`、`pnpm verify:plugin`：通过，源 manifest、市场和构建 manifest 的 0.3.4 一致。
- 浏览器独立模式：内置浏览器 **360×800 窄栏**和 **1280×800 宽抽屉**，使用临时数据目录中的“消息区移除验收”任务。
  已实际打开详情，确认回复文本域、三个按钮和停止说明消失，打开会话按钮保留；模型／工作区选择和描述编辑仍显示。未点击真实会话打开，不投递或启动 Agent。
- 本次新增渲染测试初轮因测试桩遗漏 translate 导出、SSR bundle 缺少 Node require 兼容失败，修正后重跑通过；应用类型检查与构建未因这些测试桩问题失败。
- 自动化验证分别设置 60 秒硬超时，本次无超时。`git diff --check` 通过。
- 未执行 core/MCP 全量测试：未改业务实现或契约；插件验证覆盖构建集成。真实 Codex 插件安装后显示与深链接能力未验收，按用户要求不处理。

### 变更统计

- **统计口径**：使用本次任务开始前文件快照，以 `git diff --no-index --shortstat` 与 `--numstat` 逐文件比较；新增测试与 `/dev/null` 比较，返回 1 表示差异。
  版本测试的一行旧值通过本次实际修改前的 0.3.3 断言恢复为基线。
- **排除范围**：历史记录自身、自动生成的插件 bundle，以及其它会话并发写入 appsClient 的未知路由缓存清除逻辑不计入；appsClient 仅计本次 APP_VERSION 的一行替换。
  保留所有任务前已有模型、归档、主题、国际化和会话打开改动。
- **变更文件数（源码／配置／说明）**：8
- **新增行数**：+74
- **删除行数**：−28

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 0 | 22 |
| `ui/README.md` | 1 | 1 |
| `ui/src/mcp/appsClient.ts`（仅版本） | 1 | 1 |
| `ui/test/native-execution.test.mjs`（仅版本断言） | 1 | 1 |
| `ui/test/task-detail-controls.test.mjs` | 68 | 0 |
| `extension/plugin-src/plugin.json` | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 1 | 1 |
| `.claude-plugin/marketplace.json` | 1 | 1 |

### 修改文件

上表八个文件，以及现有构建流程生成的 `plugins/tasklane/kanban-widget.html`、`server.mjs`
和两份 manifest；产物未手改。未 git add、commit 或 push。

### 后续事项

“打开 Codex 会话”逻辑保持不变，本次不处理。构建包已更新，用户已安装插件是否刷新尚未确认。
