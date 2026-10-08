## [2026-10-06 00:13 +0800] | 任务：验收缺陷修复（probeRepo locale 依赖、UI 过时测试、记录计数）

### 执行上下文

- **Agent ID**：`claude-code（Fable 5.1）`
- **Base Model**：`claude-fable-5-1`
- **Runtime**：`Claude Code CLI（macOS darwin 25.6.0 arm64，Node 22.22，pnpm workspace）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（未提交；前三任务已暂存，第四任务与本次修复在工作区）`
- **关联计划**：[无项目执行计划](../../exec-plans/completed/fix-default-board-projectless-execution.md)（验收修复轮，现已归档）

### 用户诉求

> 验收（review）发现 `pnpm verify:git` 在本机默认中文 locale 失败、UI 测试 17 项过时失败、
> 记录计数不一致后，用户要求“执行修复”，并在完成后提供手动验证清单。

### 变更概览

**影响范围**：`packages/core/`（探针与测试）、`ui/test/`、执行计划与技术债表、插件构建产物。

- **locale 修复**：`GitService.probeRepo` 的探测 exec 强制 `LC_ALL=C`/`LANG=C`；非 Git 目录
  判定不再依赖用户环境的本地化 git 消息（中文“致命错误：不是 git 仓库”曾使英文正则失配，
  落入 identifyRepo 抛 `VALIDATION`，非 Git 注册与 `verify:git` 因此失败）。
- **回归用例**：`packages/core/test/git.test.ts` 新增 probeRepo 分类用例——进程内模拟
  `zh_CN.UTF-8` 环境断言非 Git 目录返回 null、Git 仓库返回身份、裸仓库与坏路径仍拒绝
  （保留 stderr 英文匹配用于区分裸仓库与需报告的真实错误，不静默降级）。
- **UI 测试更新**：`ui/test/native-execution.test.mjs` 12 项执行守卫用例改传看板能力对象，
  并补 projectless（仅接受 projectless 方式）与 gitUnavailable（非 Git 项目禁 worktree）断言；
  `ui/test/review-controls.test.mjs` 夹具补 `board` 能力字段，pending 无工作区改为整区隐藏
  断言，补无项目看板详情渲染用例（整区隐藏、标记完成直接可用）与 `reviewUnsupported` 守卫断言。
- **记录修正**：技术债表补 projectless / 非 Git 宿主验收行；fix 计划修正计数
  （`pnpm test` 328→325、projectless-execution 6→5 项）并追加「验收修复」段与进度；
  历史 `20261005-2256` 为时间点记录保持原文，结论以修复段为准。
- **产物重建**：`pnpm build:plugin` 重新生成 `plugins/tasklane/`（server 879KB / widget 741KB），
  使 0.3.16 包内含 locale 修复。

### 设计动机

分类正确性不应依赖环境 locale：在探测调用处强制 C locale 比改写判定逻辑改动更小、可验证性
更强；stderr 英文匹配保留，避免把权限问题或损坏仓库静默降级为普通非 Git 目录。UI 侧 17 项
失败均为过时夹具与旧签名（运行时接线正确，`useTaskActions`/`dispatchNativeExecution` 已传
看板能力对象），按新契约更新断言而非回退行为；验收区隐藏为既定产品行为（无工作区无法区别
worktree 目录，用户已确认）。

### 验证结果

- `pnpm test`（含 build）：**326/326** 通过（325 + 新增 probeRepo 回归 1 项），exit 0。
- `node --test ui/test/*.test.mjs`：**64/64** 通过（63 + 新增无项目看板用例 1 项）。
- `pnpm verify:git`：本机默认中文 locale 下 **PASSED**（修复前同环境失败，`LC_ALL=C` 下通过）。
- `pnpm smoke`、`pnpm build:plugin` + `pnpm verify:plugin`、`pnpm --filter @tasklane/ui typecheck`：通过。
- 未覆盖：Codex 原生宿主与独立浏览器端到端（按计划推迟，见技术债表与手动验证清单）。

### 变更统计

> 口径：工作区相对索引的 `git diff --numstat`；`git.ts`、`native-execution.test.mjs` 等文件
> 同时包含第四任务（projectless）的未暂存增量，下表数值为其与本次修复的合计。

- **变更文件数**：6（源码/测试/文档；另 `plugins/tasklane/` 产物随 build:plugin 重建）
- **新增行数**：约 +128
- **删除行数**：约 −30

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/git.ts`（含第四任务增量，本轮约 +3/−1） | 42 | 0 |
| `packages/core/test/git.test.ts`（本轮新增） | 30 | 0 |
| `ui/test/native-execution.test.mjs`（含第四任务版本行） | 37 | 26 |
| `ui/test/review-controls.test.mjs`（本轮） | 18 | 4 |
| `docs/exec-plans/tech-debt-tracker.md`（本轮） | 1 | 0 |
| `docs/exec-plans/active/fix-default-board-projectless-execution.md`（本轮，未跟踪无法 numstat） | 约 +14 | 约 −2 |

### 修改文件

- `packages/core/src/git.ts`、`packages/core/test/git.test.ts`
- `ui/test/native-execution.test.mjs`、`ui/test/review-controls.test.mjs`
- `docs/exec-plans/tech-debt-tracker.md`、`docs/exec-plans/active/fix-default-board-projectless-execution.md`
- `plugins/tasklane/*`（`pnpm build:plugin` 再生成）

### 附：宿主工具面确认与 Review 工作区方向（2026-10-06）

- **工具确认**：用户反馈 Reviewer 聊天工具面未见 `task_review_update`。核对结论：该工具已在
  0.3.16 加载副本中正常注册——`codex plugin list` 显示 `tasklane@tasklane installed, enabled 0.3.16`；
  `~/.codex/.tmp/marketplaces/tasklane/plugins/tasklane/`、`~/.codex/plugins/cache/tasklane/tasklane/0.3.16/`
  与仓库产物 `plugins/tasklane/` 的 server.mjs、kanban-widget.html、plugin.json、mcp.json
  SHA-256 完全一致；直接驱动安装副本执行 initialize + tools/list 返回 26 个工具，包含
  `task_review_update`（无 `_meta` 可见性限制）与 `task_execution_external_bind`。
- **未见工具的合理原因**：相关会话早于 0.3.16 安装/重载（安装时间 2026-10-06 14:59），
  会话建立时固化的工具清单不随重载更新；重载后的新会话即可见，建议与此前手动创建的聊天对比复测。
- **Review 工作区方向（用户确认）**：Review 不需要宿主支持 `create_thread` 指定目录；验收会话
  以主分支项目创建，由提示词描述被验收 workspace（worktree/分支），Reviewer 自行分析。
  现行「验收工作区必须等于实现工作区」的绑定校验需相应放开，已登记技术债表
  2026-10-06「Review 工作区语义」行。

### 后续事项

- 手动验证清单（本地命令复核 + 真机宿主 0.3.16 验收）已随修复交付用户。
- 宿主验收通过后归档 fix 计划；验收项见技术债表 2026-10-06 行。
