## [2026-10-03 18:44 +0800] | 任务：允许未提交仓库打开项目看板

### 执行上下文

- **Agent ID**：Codex 主代理、核心、契约/UI、文档与审查子代理
- **Base Model**：未知
- **Runtime**：Codex desktop，本地 macOS 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（尚无有效 HEAD）
- **关联计划**：../../exec-plans/completed/unborn-repository-board.md

### 用户诉求

> TaskLane 因当前仓库没有任何提交而拒绝打开项目看板，需要修复。

### 变更概览

**影响范围**：核心 Git 条件、任务指派降级、MCP 描述和目录检测、UI 说明、
英文技能、插件构建与协议验证。

- 身份识别不要求 HEAD 提交；空仓库只允许当前待首次提交的分支作为基线。
- 有提交仓库沿用有效本地基线规则；缺省仍为 main，空 master/trunk 仓库须显式传参。
- 创建或复用任务 worktree 前校验提交、基线与路径，条件不满足时不创建工作区。
- 指派保持 assigned，execution.activity 明确说明 Git 工作区未创建及具体原因；
  只在仍为 agent/assigned 时写入说明，避免覆盖其他进程已经推进的执行状态。
- 目录选择器支持识别空仓库的当前分支；只读 Git 查询剔除继承环境中的 Git 上下文，
  防止查询被路由到其他仓库。
- UI 和英文技能明确：看板与任务管理无需提交，worktree 需首次提交。
- 更新插件协议测试，从“空仓库拒绝”改为“注册/锁定/任务流转成功且不创建提交”。
- 重新构建自包含插件；当前清单版本为 0.2.7，版本变更由并行任务提供，
  本任务没有安装插件或修改安装目录。
- 修正文档对更新“立即生效”的绝对保证，记录运行中 MCP 服务需要单独刷新。

### 设计动机

原 identifyRepo 同时承担仓库身份和 HEAD 可执行性校验，导致尚未提交的项目连任务
管理都不可用。现在将执行前置条件放在 worktree 操作处，不增加持久化就绪字段或
存储迁移；用户首次提交后重新指派即可恢复执行，沿用原看板、任务和 sessionId。

不自动提交用户仓库，不绕开项目归属，不改开全局看板或浏览器。

### 验证结果

- `pnpm test`：通过，52 项测试，包含核心/MCP 构建。
- 新真实临时 Git 用例：空仓库识别、main/trunk 基线、无效基线、refs/worktree 不变、
  人工任务流转、首次提交后同一看板/session 恢复 worktree、仓库路径失效的降级提示。
- `pnpm verify:git`：通过，验证已有分支复用、Git 摘要、多仓库归属与并发工作区。
- `pnpm verify:twoproc`：通过，ID、session、注册及写入隔离均正确。
- `pnpm smoke`：通过。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`：通过。
- `pnpm build:plugin`、`pnpm verify:plugin`：通过，末次核心提示修复后重建与协议复验通过。
- 语法、技能源/打包文件一致性及 `git diff --check`：通过。
- 独立只读审查发现的路径失效提示与 README 检测说明遗漏均已修复并留档。
- 自动化命令设置 60 秒进程组硬超时；使用临时数据目录和临时 Git 仓库。
- UI 仅调整说明文字，未执行浏览器交互验收。
- 真实当前项目 `open_tasklane` 调用：失败，运行服务仍返回旧“没有任何提交”错误。
  已安装 0.2.7 文件已经含新空仓库逻辑，但当前会话工具说明和结果仍为旧行为；
  宿主需刷新 MCP 服务，必要时重启 Codex 后再验收。未将该调用记为打开成功。
- 没有对真实项目执行首次提交或修改真实任务数据。

### 变更统计

- **统计口径**：与任务前快照逐文件执行 `git diff --no-index --shortstat`、
  `--numstat`；新增计划与 `/dev/null` 对比。排除历史自身、已有图标和设计资产、
  dist 缓存及并行任务的版本号修改。
- `extension/README.md` 基线补入并行任务新增的更新流程，排除其原始新增，
  仅统计本任务对基线规则及服务刷新说明的修订。
- 打包文件列为本次构建输出，其内联内容按构建时工作区现状生成，没有手改产物。
- **变更文件数**：20
- **新增行数**：+432
- **删除行数**：-86

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/git.ts` | 41 | 8 |
| `packages/core/src/engine.ts` | 11 | 4 |
| `packages/core/test/git.test.ts` | 149 | 2 |
| `mcp/src/handlers.ts` | 19 | 3 |
| `mcp/src/register.ts` | 3 | 2 |
| `mcp/test/tools.test.ts` | 28 | 1 |
| `extension/src/widget.mjs` | 5 | 3 |
| `scripts/verify-plugin.mjs` | 20 | 5 |
| `README.md` | 10 | 4 |
| `WORKFLOW.md` | 16 | 7 |
| `extension/README.md` | 12 | 5 |
| `extension/plugin-src/skills/open-tasklane/SKILL.md` | 2 | 1 |
| `ui/src/components/TaskList.tsx` | 1 | 1 |
| `ui/src/components/BoardWide.tsx` | 1 | 1 |
| `ui/src/components/AddBoardForm.tsx` | 4 | 4 |
| `ui/src/components/RepoPicker.tsx` | 1 | 1 |
| `plugins/tasklane/server.mjs` | 31 | 31 |
| `plugins/tasklane/kanban-widget.html` | 2 | 2 |
| `plugins/tasklane/skills/open-tasklane/SKILL.md` | 2 | 1 |
| `docs/exec-plans/completed/unborn-repository-board.md` | 74 | 0 |

### 修改文件

见上述逐文件统计；版本号与插件清单的并行改动未计入本任务源码统计。

### 后续事项

- 重新加载 TaskLane MCP 服务，必要时重启 Codex，再通过工具打开当前项目；
  原生面板实际显示仍需宿主验收。
- 当前已安装包与最后构建输出摘要有差异；空仓库逻辑已经存在于已安装文件，
  路径失效提示的末次补丁仍应随最新构建输出更新后验收。
