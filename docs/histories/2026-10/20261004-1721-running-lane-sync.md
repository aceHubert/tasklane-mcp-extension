## [2026-10-04 17:21 +0800] | 任务：真实开始执行时同步看板列

### 执行上下文

- **Agent ID**：Codex 主代理及并行回归测试代理
- **Base Model**：未知
- **Runtime**：Codex Desktop 本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[执行计划](../../exec-plans/completed/running-lane-sync.md)

### 用户诉求

> 任务绑定后真正开始执行时，看板状态同步移到执行中，直接修改代码。

### 变更概览与设计动机

- 本轮首次有效 running 且任务在 Ready 时，同一文件锁事务内更新为 Doing，并原子保存 started/moved 时间线。
- 不在点击执行、创建、绑定或 blocked 时移动；同轮后续 running 不覆盖用户手动流转，其它业务列保持原样。错误身份、旧 run 和重复回执沿用现有守卫。
- MCP 描述、执行技能与契约同步；不增加存储字段，不调用第二个 task_move，不操作用户真实任务或工作区，不回填旧任务。
- 新增独立单元回归及双进程重复回执测试，调整两处原有测试的手动 Doing 前提。
- 整合时 smoke 的恢复核对场景存在独立错误前提：把已报告 busy 的检查当成 pending 合并。调整测试顺序与绑定保留断言，不修改恢复业务实现。

### 验证结果

- pnpm build、pnpm test：239 项全部通过。
- pnpm smoke、pnpm verify:twoproc：通过；双进程重复 running 只生成一次 Ready→Doing，保留并发标题编辑。
- pnpm build:plugin、pnpm verify:plugin：通过。
- 自动化命令均设置 60 秒硬超时；数据和 Git fixture 使用临时目录，不操作真实任务。
- git diff --check 通过。未修改 UI；未重新进行实际原生宿主运行验收。
- 已重新生成仓库插件包，未修改已安装插件缓存，未提交代码。

### 变更统计

- **统计口径**：相对本轮修改前快照执行 git diff --no-index --shortstat/--numstat；新测试与计划相对 /dev/null。排除此前 blocked 等改动、插件构建产物和本历史记录。
- **变更文件数**：9
- **新增行数**：+274
- **删除行数**：-16

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| packages/core/src/native-execution.ts | 15 | 4 |
| packages/core/test/native-execution.test.ts | 2 | 2 |
| packages/core/test/running-lane.test.ts | 204 | 0 |
| mcp/src/register.ts | 1 | 1 |
| scripts/two-process-verify.mjs | 7 | 2 |
| scripts/smoke.mjs | 8 | 5 |
| extension/plugin-src/skills/tasklane-native-execution/SKILL.md | 1 | 1 |
| docs/native-execution-contract.md | 2 | 1 |
| docs/exec-plans/completed/running-lane-sync.md | 34 | 0 |

### 后续事项

加载新版插件后生效；不会自动重放历史 running 回执或移动此前已完成的任务。
