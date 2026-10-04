# [2026-10-03 22:30 +0800] | 任务：修复归档与桥接验收问题（F1/F2）

### 执行上下文

- **Agent ID**：ZCode
- **Base Model**：zai-api/GLM-5.3
- **Runtime**：ZCode 桌面会话（macOS darwin 25.6.0 arm64）
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：仓库尚无提交（部分文件已暂存、部分未跟踪；`git log` 为空）
- **关联计划**：无（缺陷修复）；关联验收
  [docs/acceptance/20261003-archive-codex-bridge.md](../../acceptance/20261003-archive-codex-bridge.md)、
  [任务归档计划](../../exec-plans/completed/task-archiving.md)

### 用户诉求

> 20261003-archive-codex-bridge.md 验收问题修复。

对应验收报告「后续动作」第 1 条：修复 F1（归档区 Enter 恢复误开详情）并补
键盘回归；修复 F2（已确认投递被迟到超时回执降级）并补顺序测试。

### 变更概览

**影响范围**：`ui/src/components/`、`packages/core/src/`、
`packages/core/test/`、`docs/acceptance/`、`plugins/`（构建产物）。

**主要操作**：

- **F1**：`ArchivedView.tsx` 与 `TaskCard.tsx` 的卡片容器 `onKeyDown`
  增加 `e.target !== e.currentTarget` 守卫——子元素（恢复/指派/归档按钮）
  的 Enter 冒泡不再触发卡片「打开详情」；卡片自身聚焦的 Enter 行为不变。
  `TaskCard` 与 `ArchivedCard` 同型隐患一并修复。
- **F2**：`native-execution.ts` 的 `delivery()` 增加投递回执优先级守卫：
  认领前 `delivered → uncertain` 为无副作用幂等（不降级、不写
  `deliveryError`、不追加事件）；`uncertain → delivered` 升级路径保持。
- **回归测试**：`native-execution.test.ts` 新增
  「已确认 delivered 不被认领前的迟到超时 uncertain 降级（F2 回归）」，
  覆盖降级窗口、快照不变、重复迟到幂等与反向升级。
- **验收报告**：F1/F2 状态更新为已修复，结论表同步，追加「修复记录」
  章节记录修复位置、回归方式与验证命令。
- 插件 bundle 经 `pnpm build:plugin` 重建，包含两处修复。

### 设计动机

- F1 根因是容器处理了所有冒泡的 Enter：按钮的键盘激活在浏览器中最终表现为
  click（各按钮已 stopPropagation），而冒泡 keydown 先行打开详情并卸载按钮。
  守卫「仅卡片自身聚焦时响应」保留无障碍的卡片键盘访问，又不劫持子控件。
- F2 根因是投递回执无优先级：`delivered` 是消息通道的确认结果，迟到的
  超时错误只描述「结果未知」，不能推翻确认；认领后已有保护，本次补齐
  认领前窗口。无副作用幂等返回与既有 no-op 路径一致。

### 验证结果

- 命令与结果（修复后全部通过）：
  `pnpm test`（119/119，含新增 F2 回归）；`node --test
  ui/test/native-execution.test.mjs`（7/7）；`pnpm smoke`；
  `pnpm verify:twoproc`；`pnpm --filter @tasklane/ui typecheck`；
  `pnpm build:ui`；`pnpm build:plugin`；`pnpm verify:plugin`
  （plugin smoke: ALL PASS）。后台验证均在 60 秒硬超时内。
- F1 真实键盘回归（bridge 7462 + 临时 TASKLANE_HOME，内置浏览器，窄栏
  420px）：1）聚焦「恢复到 Done」按钮派发冒泡 Enter——详情未打开、归档
  视图保持（原缺陷路径不再复现）；2）激活该按钮（原生 Enter 的激活语义
  = click）——任务恢复到 Done、归档徽标清零、无详情打开；3）卡片自身聚焦
  Enter——详情正常打开且恢复后的任务可编辑（容器处理器未被守卫误伤）。
  说明：本环境 Playwright 面的 `press()` 不合成按钮激活 click，故按
  「冒泡 keydown + 激活 click」分解验证，二者合并即为真实 Enter 行为。
- 未覆盖场景：验收报告中 Codex 原生验收阻塞项（插件 0.2.12 未加载 0.3.0、
  创建顺序适配、接收聊天实证）不在本次修复范围，保持原文登记。

### 变更统计

- **统计口径**：仓库无提交基线，且与其他会话改动在 `TaskCard.tsx` 等文件
  交错、部分文件处于未跟踪状态，无法按 `git diff` 精确拆分本次归属；
  按实际编辑内容统计（历史记录自身不计入）。

- **修改文件数**：4（+验收报告更新）
- **新增行数**：约 +115（F2 回归测试 27、键盘守卫与注释 15、投递优先级
  守卫 3、验收报告修复记录约 50、插件产物重建）

| 文件 | 变更 |
| --- | --- |
| `ui/src/components/ArchivedView.tsx` | onKeyDown 守卫（F1） |
| `ui/src/components/TaskCard.tsx` | onKeyDown 守卫（F1 同型隐患） |
| `packages/core/src/native-execution.ts` | delivery 优先级守卫（F2） |
| `packages/core/test/native-execution.test.ts` | F2 回归测试 |
| `docs/acceptance/20261003-archive-codex-bridge.md` | 状态更新 + 修复记录 |

### 修改文件

- `ui/src/components/ArchivedView.tsx`
- `ui/src/components/TaskCard.tsx`
- `packages/core/src/native-execution.ts`
- `packages/core/test/native-execution.test.ts`
- `docs/acceptance/20261003-archive-codex-bridge.md`
- `plugins/tasklane/`（`pnpm build:plugin` 产物）

### 后续事项

- 验收报告「后续动作」第 2、3 条（原生验收准备与顺序适配）保留原状，
  涉及插件升级与真实宿主验收，需用户授权后另行推进。
