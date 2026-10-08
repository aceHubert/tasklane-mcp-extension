## [2026-10-06 18:23 +0800] | 任务：调整首次 Review 提示词与无项目执行方式

### 执行上下文

- **Agent ID**：codex
- **Base Model**：未知
- **Runtime**：Codex Desktop
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：无（局部提示词与执行控件修正）

### 用户诉求

> Review 沿用已验证的执行流程，仅首次提示实际审查目录，复查不再重复目录提示；projectless 不允许选择 worktree，下拉框不要有可选择项。

### 变更概览

**影响范围**：UI 原生请求提示词、任务详情、原生执行技能与插件分发包。

- 首次 Review 在看板主项目的 local 环境创建独立聊天，提示词指定实现工作区；允许命令以该路径为工作目录，核验仓库身份、分支与变更，不创建 worktree 或切换分支。
- 后续 Review 继续使用原验收聊天，目标提示词不再重复目录说明。
- Review 分发提示词及新增技能说明统一英文；用户原始消息保持原文。
- Projectless 工作方式固定为只读文字，优先于残留 worktreePath，不再渲染工作方式下拉框。
- 撤回非 Git 项目的能力说明，恢复原说明，仅通过选项隐藏 worktree；删除无用的中英文提示键。
- 同步技能源文件；通过构建生成插件技能及界面产物，保留现有执行契约和服务端守卫。

### 设计动机

聊天归属主项目与实际审查工作区可不同。首次提示词明确实际审查对象，避免要求宿主指定现有 worktree 目录；后续沿用既有绑定。服务端已拒绝 projectless 的 worktree/existing 请求，本次补齐 UI 固定方式及旧字段边界。

### 验证结果

- UI 类型检查、`pnpm build:ui`、`pnpm build:plugin`：通过。
- `node --test ui/test/native-execution.test.mjs ui/test/task-detail-controls.test.mjs ui/test/review-controls.test.mjs`：64 项通过，最终执行配置 60 秒硬超时。
- `pnpm verify:plugin`：ALL PASS，配置 60 秒硬超时。
- 渲染回归覆盖窄详情与宽抽屉，无项目任务带/不带旧 worktreePath 均无工作方式选项；提示词回归覆盖首次 Review 与继续验收。
- 未覆盖场景：未重新执行真机宿主/内置 Chrome 界面验收，本会话此前电脑工具拒绝访问 Codex 主窗口。没有安装到宿主缓存或重启 Codex。

### 变更统计

- **统计口径**：使用任务前工作树快照，通过 `git diff --no-index --shortstat` 与 `--numstat` 对比六个源文件，逐 hunk 排除执行期间其他任务新增的普通继续执行草稿及相关测试改动；排除任务前已有改动、历史记录自身与生成的插件包。插件构建使用完整当前工作树，不能将其他既有修改计作本任务。
- **变更文件数**：6（源文件口径）
- **新增行数**：+116
- **删除行数**：-37

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/state/nativeExecution.ts` | 25 | 23 |
| `ui/src/components/TaskDetail.tsx` | 10 | 9 |
| `extension/plugin-src/skills/native-execution/SKILL.md` | 9 | 2 |
| `ui/test/native-execution.test.mjs` | 46 | 0 |
| `ui/test/task-detail-controls.test.mjs` | 26 | 1 |
| `ui/src/i18n/nativeMessages.ts` | 0 | 2 |

### 修改文件

- 上述六个源文件。
- 构建更新：`plugins/tasklane/skills/native-execution/SKILL.md`、`plugins/tasklane/kanban-widget.html`、`plugins/tasklane/server.mjs`。

### 后续事项

- 安装更新后的插件包并在真机宿主复查首次 Review 工作区提示与 projectless 执行控件。
- 当前聊天工具面未暴露 task_review_update 的现象独立于本次提示词修正，未在本次更改工具注册。
