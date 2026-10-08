## [2026-10-07 21:15 +0800] | 任务：补齐首次 Review 提示词编辑

### 执行上下文

- **Agent ID**：codex
- **Base Model**：未知
- **Runtime**：Codex Desktop，本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：`docs/exec-plans/completed/review-binding-and-external-execution.md`

### 用户诉求

> 确认 Review 是否也没有展示可修改的提示词。

### 变更概览

**影响范围**：UI 详情、国际化文案、Review 交互回归及生成插件。

- 已有继续修改和继续验收提示词编辑器；遗漏的是首次 Review。
- 首次 Review 的模型选择下方新增预填业务提示词编辑框，最多 20,000 字符。
- startReview 同时接收模型和编辑后的完整 message，复用现有请求保存链路。
- 草稿按任务及阶段隔离，切换任务重置，系统绑定与回执协议仍不可编辑。
- 通过构建更新插件产物，不手改生成文件。

### 设计动机

补齐首次验收的“生成 → 编辑 → 发送”流程。首轮 start 使用独立业务草稿，
fix 和 recheck 继续按 Review 状态生成；不修改会话绑定、工作区或模型守卫。

### 验证结果

- 60 秒硬超时下执行 Review 联动、Review 控件、原生派发、详情控件四组测试：74 项通过。
- UI 类型检查、`pnpm build:ui`：通过。
- `pnpm build:plugin`：通过，包含 core/MCP 构建。
- `timeout 60s pnpm verify:plugin`：ALL PASS，使用临时数据与仓库。
- 交互回归核验首次提示词编辑、所选模型与完整正文传递、阶段切换隐藏及任务切换草稿重置。
- `git diff --check`：通过。
- 浏览器及 Codex 原生面板展示未验收，用户将手动验收。
- 用户要求编译更新后，重新执行 UI 类型检查、插件构建与 60 秒插件校验，全部通过。
- `codex plugin add tasklane@tasklane --json`：已更新本地插件缓存，版本 0.3.18；
  缓存与构建包的界面 SHA-256 一致。未重启 Codex。

### 变更统计

- **统计口径**：任务前工作树快照，通过 `git diff --no-index --shortstat`
  与 `--numstat` 比较本次三个源文件；排除任务前已有改动、历史记录自身及
  生成插件包。退出码 1 代表有差异。
- **变更文件数**：3（源文件口径）
- **新增行数**：+41
- **删除行数**：-6

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 13 | 5 |
| `ui/src/i18n/nativeMessages.ts` | 4 | 0 |
| `ui/test/review-linked-continuation.test.mjs` | 24 | 1 |

### 修改文件

- `ui/src/components/TaskDetail.tsx`
- `ui/src/i18n/nativeMessages.ts`
- `ui/test/review-linked-continuation.test.mjs`
- `plugins/tasklane/` 构建生成产物（完整当前工作树构建，不计入源码统计）。

### 后续事项

- 更新后的插件在宿主加载后补验首次 Review 编辑界面。
- 未执行 Git 提交。
