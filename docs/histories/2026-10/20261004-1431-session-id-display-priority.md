## [2026-10-04 14:31 +0800] | 任务：仅调整会话 ID 显示优先级

### 执行上下文

- **Agent ID**：`ZCode`
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；TypeScript/React/Vite
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，不能使用 HEAD 作为本次统计基线
- **关联计划**：[会话显示优先级](../../exec-plans/completed/internal-session-chat-binding.md)

### 用户诉求

> 内部 session ID 与绑定 session ID 是分开的字段，只需处理 UI 显示优先级，不需要修改生成规则。

### 变更概览

**影响范围**：TaskDetail 会话行、组件渲染测试、UI 说明及插件版本。

- 有效真实聊天绑定优先显示 executionBinding.threadId；没有真实绑定时回退已有 execution.sessionId。
- 内部 ID 显示未绑定标记，pending/uncertain 时同时保留请求进度；空 ID 不在 UI 生成或写回。
- 创建中占位绑定不优先于内部 ID。绑定后界面仅显示真实 ID，不覆盖或删除内部字段。
- 会话打开仍只用原有真实绑定逻辑；本次不改变打开入口、路径或权限。
- 新增窄详情与宽抽屉渲染回归；版本同步 0.3.6，通过既有构建生成插件包，未安装/更新用户插件。

### 设计动机与范围收敛

实施初期曾按“默认生成本地会话 ID”的理解改动核心创建与有效请求补齐；用户随后明确
只调整 UI。已按精确字符串撤回本次核心生成规则、类型注释、core/MCP 测试和 smoke/
twoproc/Git 脚本调整，不使用全文件或 Git reset，以保留同期其它会话正在实施的删除功能。
最终不会改变内部 ID 的来源和生命周期，也不会改变真实聊天 created→bound 绑定规则。
存储版本、已有数据、模型选择、执行回执和工作区均不处理。

### 验证结果

| 检查 | 实际结果 |
| --- | --- |
| `pnpm --filter @tasklane/ui typecheck` | 通过，最新共享 UI 再次复验通过 |
| `node --test ui/test/*.test.mjs` | **29/29 通过**，0 失败 |
| `pnpm build:ui` | 通过 |
| `pnpm build:plugin` | 通过，包含 core/MCP 构建与 widget 打包 |
| `pnpm verify:plugin` | 通过 |
| `git diff --check` | 通过 |
| 核心撤回检查 | 本次生成/补齐逻辑和配套断言不再有差异；保留同文件其它改动 |
| 会话打开比较 | 入口与原处理逻辑未改 |
| manifest/市场/App/服务版本 | 统一 0.3.6 |

每项自动化命令 60 秒硬超时，本次无超时。组件回归覆盖未绑定、bound/running/waiting/
completed、pending/uncertain、创建中占位绑定及两个字段都缺失；确认显示不修改任务副本。
不继续模拟浏览器验收，也未创建真实聊天、点击用户真实 Run 或打开 Codex 深链接。
协议/静态渲染不能作为原生宿主试用证明。本次无最终 core/MCP 行为改动，不执行全库业务
测试；构建与插件验证按最终共享状态通过。

### 变更统计

- **统计口径**：使用任务前文件快照，以 `git diff --no-index --shortstat` 和 `--numstat`
  比较；TaskDetail 同期包含其它会话删除入口改动，用最终文件只撤回本次显示片段得到
  临时基线，从而只统计本次会话行与 import 变更。临时基线没有写回源文件。
- **排除范围**：已撤回的 core/MCP/scripts 变更、同期删除/模型改动、历史记录自身、执行
  计划及自动生成插件 bundle 不纳入数字汇总。原计划留档用户范围变化后归档。
- **变更文件数（源码/配置/测试/说明）**：9
- **新增行数**：+62
- **删除行数**：−13

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 7 | 5 |
| `ui/test/task-detail-controls.test.mjs` | 48 | 1 |
| `ui/README.md` | 1 | 1 |
| `ui/src/mcp/appsClient.ts`（仅版本） | 1 | 1 |
| `ui/test/native-execution.test.mjs`（仅版本断言） | 1 | 1 |
| `extension/src/plugin-server.mjs`（仅版本） | 1 | 1 |
| `extension/plugin-src/plugin.json`（仅版本） | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json`（仅版本） | 1 | 1 |
| `.claude-plugin/marketplace.json`（仅版本） | 1 | 1 |

### 修改文件

上述九个文件、`docs/exec-plans/completed/internal-session-chat-binding.md` 和本历史记录，
以及通过构建生成的 `plugins/tasklane/` server、widget 和两份 manifest；产物未手改。
未 git add/commit/push，没有读写用户真实看板。

### 后续事项

现有内外会话字段保持原样；仅在真实绑定存在时改变 UI 优先级。用户已安装的插件及
运行中面板是否加载 0.3.6 未确认，真实深链接打开仍非本次范围。
