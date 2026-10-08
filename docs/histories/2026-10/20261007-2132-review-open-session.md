## [2026-10-07 21:32 +0800] | 任务：增加 Review 打开会话按钮

### 执行上下文

- **Agent ID**：codex
- **Base Model**：未知
- **Runtime**：Codex Desktop，本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：`docs/exec-plans/completed/review-binding-and-external-execution.md`

### 用户诉求

> Review 中只要有真实 threadId，也需要打开会话按钮。

### 变更概览

**影响范围**：UI 详情、宿主打开守卫、动作路由及测试。

- Review 区新增打开会话按钮，选择 reviewBinding 或本轮验收请求的真实 created 结果。
- 打开目标与守卫增加 purpose 参数；默认仍选择实现会话，Review 明确选择验收会话。
- 缺少验收目标不回退实现聊天，内部 sessionId/clientThreadId 不作为真实线程。
- 保留宿主身份、连接、看板范围及 openLinks 能力守卫，拒绝时沿用错误提示。
- 打开为只读操作，已通过或归档的 Review 会话仍可打开。
- 构建并更新本地插件缓存，交由用户手动验收。

### 设计动机

实现和 Review 的真实聊天分离；复用已有 SDK openLink 和错误处理，
按 purpose 解析目标，避免 Review 按钮打开实现聊天。

### 验证结果

- 60 秒硬超时执行 Review 联动、Review 控件、原生派发、详情控件测试：76 项通过。
- UI 类型检查、`pnpm build:plugin`：通过。
- `timeout 60s pnpm verify:plugin`：ALL PASS，临时数据与仓库验证。
- 回归覆盖 Review 各阶段与归档按钮、独立验收目标、created 结果、
  缺绑定不回退、内部标识拒绝、断连及缺 openLinks 能力。
- `git diff --check`：通过。
- `codex plugin add tasklane@tasklane --json`：更新成功，版本 0.3.18；
  本地缓存与构建包界面 SHA-256 一致。
- 浏览器及原生 Codex 界面点击未验收，用户将手动验收。

### 变更统计

- **统计口径**：任务前工作树快照，使用 `git diff --no-index --shortstat`
  和 `--numstat` 比较；排除已有修改、历史记录及构建生成插件包。
- **变更文件数**：4（源文件口径）
- **新增行数**：+52
- **删除行数**：-10

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/host.ts` | 6 | 5 |
| `ui/src/state/useTaskActions.ts` | 5 | 4 |
| `ui/src/components/TaskDetail.tsx` | 8 | 0 |
| `ui/test/review-linked-continuation.test.mjs` | 33 | 1 |

### 修改文件

- `ui/src/host.ts`
- `ui/src/state/useTaskActions.ts`
- `ui/src/components/TaskDetail.tsx`
- `ui/test/review-linked-continuation.test.mjs`
- `plugins/tasklane/` 构建生成产物。

### 后续事项

- 关闭旧面板，在新聊天中打开更新的插件，手动确认打开验收聊天。
- 未执行 Git 提交。
