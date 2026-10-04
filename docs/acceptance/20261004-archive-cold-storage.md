# 归档冷存储 UI 回归验收

- 日期：2026-10-04（Asia/Shanghai）
- 运行模式：内置 Chrome + 独立 bridge；不是 Codex 原生宿主面板。
- 地址：`http://127.0.0.1:17433/`。
- 数据隔离：`TASKLANE_HOME=/tmp/tasklane-cold-ui.b0EtDk`、`TASKLANE_GIT=off`、空 `TASKLANE_REPO`；未使用真实看板数据。
- 构建：UI 类型检查与 Vite 构建均通过，每个命令设置 60 秒硬超时。
- 核心构建：存储负责人确认实现构建通过后启动 bridge，实际落盘版本验证为 v5。

## 已验证

1. 宽屏看板正常打开；通过 UI 创建 `TASK-101`「冷存储验收任务」。
2. 详情状态选择器依次执行 Ready → Doing → Review，通过 Mark done 完成至 Done；计数、列与时间线同步更新。
3. 详情归档成功，活跃计数变为 0、归档计数变为 1；归档详情只读，时间线保留创建与各次状态流转，并新增归档事件。
4. 直接只读核验临时数据：主文件 `version=5`，`tasks` / `sessions` 均为空，`archivedCounts.default=1`；`archive/default.json` 保存 `TASK-101` 及其时间线。
5. 归档视图搜索「不存在」呈现无匹配空态，搜索「冷存储」命中任务。
6. 420×900 窄栏显示状态 Tabs 和设置入口；归档弹窗、搜索框、任务卡与恢复按钮可见。
7. 从窄栏设置入口导出三个范围的 Markdown 报告，UI 返回临时目录内路径；读取报告核验默认 all 与 archived 均含 `TASK-101`，active 报告总数为 0。
8. 归档列表点击 Restore to Done 成功，UI 提示 `task_restore(TASK-101) OK`，Done 计数为 1，归档列表为空。
9. 恢复后只读核验主文件重新包含 `TASK-101` 和时间线，`archivedCounts.default=0`；冷文件 `tasks` / `sessions` 均为空。
10. 1280×900 宽屏恢复后 Done 列显示任务，归档计数为 0；已保存截图并重置临时 viewport。
11. 终止仅本次启动的 bridge 后，页面提示 MCP 断连与只读缓存；新建、归档、导出、添加仓库及批量归档均禁用，Done 任务缓存仍显示。

## 证据

- 窄栏归档截图：`/tmp/tasklane-cold-ui.b0EtDk/narrow-archive.png`。
- 宽屏恢复截图：`/tmp/tasklane-cold-ui.b0EtDk/wide-restored.png`。
- 断连态截图：`/tmp/tasklane-cold-ui.b0EtDk/disconnected.png`。
- 默认 all 报告：`/tmp/tasklane-cold-ui.b0EtDk/exports/Default-Board-2026-09-04_2026-10-04-20261004-223913.md`。
- archived 报告：`/tmp/tasklane-cold-ui.b0EtDk/exports/Default-Board-2026-09-04_2026-10-04-20261004-223919.md`。
- active 报告：`/tmp/tasklane-cold-ui.b0EtDk/exports/Default-Board-2026-09-04_2026-10-04-20261004-223925.md`。

## 限制与未覆盖

- 宽屏截图操作曾遇自动审批服务 HTTP 502；一次有限重试成功，未绕过审批检查。该瞬时服务故障不影响最终结果。
- 未完成拖拽与归档读取失败错误态回归；本次任务流转通过详情状态控件验证。
- 未验证 Codex 原生宿主面板、聊天创建或执行；本报告不能用来证明原生宿主执行链路可用。
- 多任务混合导出、跨进程、迁移与崩溃边界由核心/MCP 自动化验收承担，本文仅记录单任务 UI 往返及三种导出范围。
