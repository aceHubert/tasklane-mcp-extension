## [2026-10-03 13:21 +0800] | 任务：建立仓库协作规范与记录模板

### 执行上下文

- **Agent ID**：`codex`（主代理与只读调查子代理）
- **Base Model**：`GPT-6`（主代理）；只读调查子代理为 `gpt-6-luna`
- **Runtime**：Codex 桌面应用，本地 bash 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`
- **关联计划**：无；本次为短周期规范与模板生成任务。

### 用户诉求

> 根据 LocalQuotaBar 项目的 AGENTS.md，为本项目生成 AGENTS.md、Execution Plans & Histories 规范及模板文件；计划指南和目录说明不列具体待执行计划，并同步修正记录。

### 变更概览

**影响范围**：`AGENTS.md`、`docs/`。

**主要操作**：

- 建立项目结构、开发命令、编码风格、验证和协作规范，适配 TypeScript、MCP、React 与本地 bridge。
- 建立执行计划与历史记录指南、两类模板、技术债空表及 active/completed 目录占位文件。
- 执行计划指南与目录说明只保留通用规则，不列具体待执行计划。

### 设计动机

沿用参考项目的计划与历史记录目录约定，替换其 Swift 与菜单栏应用内容。只读项目调查与参考规范收集并行进行，文件由主代理统一写入，避免写冲突。不复制参考项目的业务技术债，不覆盖任务开始前已有的未跟踪文件。

### 验证结果

- 文档静态检查：修正后重新检查，7 份规范与模板的 17 个本地链接全部可解析，无行尾空白或末尾换行缺失；生成阶段已核对 12 个 npm 脚本存在，无参考项目技术栈残留。
- 配置核对：通过源码确认 `CODEX_KANBAN_GIT=off` 关闭 Git 能力；核对根构建不包含 UI，UI 类型检查与构建分别执行。
- 目录检查：`active/.gitkeep` 与 `completed/.gitkeep` 均存在。
- 变更统计：逐文件运行 `git diff --no-index --shortstat /dev/null <文件>` 与 `git diff --no-index --numstat /dev/null <文件>`。
- 未覆盖场景：本次仅新增规范与模板，未执行应用构建、单元测试、集成验证或浏览器验收。

### 变更统计

- **统计口径**：按修正后的当前内容，将本次生成的 7 份文档逐一与 `/dev/null` 对比，汇总行数；另计 2 个空 `.gitkeep`。排除本历史记录、用户另行进行的计划迁移及任务开始前已有的全部未跟踪文件；用户手动更新的 AGENTS.md 引用保留，包含在当前文件行数中。
- **变更文件数**：9
- **新增行数**：+290
- **删除行数**：-0

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `AGENTS.md` | 61 | 0 |
| `docs/PLANS_GUIDE.md` | 33 | 0 |
| `docs/HISTORY_GUIDE.md` | 60 | 0 |
| `docs/exec-plans/README.md` | 8 | 0 |
| `docs/exec-plans/active/.gitkeep` | 0 | 0 |
| `docs/exec-plans/completed/.gitkeep` | 0 | 0 |
| `docs/exec-plans/templates/execution-plan.md` | 64 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | 8 | 0 |
| `docs/histories/template.md` | 56 | 0 |

### 修改文件

本次生成文件见上表；另生成本历史记录。后续修正仅移除计划指南与目录说明中的具体计划引用并更新本记录，保留用户其他手动更新。未执行暂存、提交或推送。

### 后续事项

- 无；后续长期任务按新规范建立计划，实际仓库改动按历史模板留档。
