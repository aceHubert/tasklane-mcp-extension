## [2026-10-04 22:50 +0800] | 任务：实施归档任务冷存储

### 执行上下文

- **Agent ID**：Codex，使用 collab 分工实施、测试、脚本与只读审查。
- **Base Model**：GPT-6；会话发生模型切换，具体子型号未知。
- **Runtime**：Codex Desktop、macOS、bash、pnpm workspace。
- **Git User**：hubert <hubert@lejian.com>。
- **Branch**：main；未执行暂存、提交或推送。
- **关联计划**：[archive-cold-storage](../../exec-plans/completed/archive-cold-storage.md)。

### 用户诉求

> 实施 archive-cold-storage；按现有计划将归档任务及时间线拆出热文件，保持 MCP 与 UI 行为。

### 变更概览

- 主存储升级 v5，活跃任务及时间线留在 `board.json`，归档迁入 `archive/<boardId>.json`。
- 锁内迁移先完整校验并备份，再写冷文件，最后提交热文件；备份通过唯一临时文件原子发布，已有备份与源字节不符时明确中止。
- 归档先冷后热，恢复先热后冷；读取主文件优先，重复恢复清理隐藏冷副本。删除恢复后的热任务前清理残留副本，避免历史任务复活。
- `boardList` 使用单次热快照与归档计数；创建任务锁内分配 ID，不扫描冷文件。归档任务写入继续返回 `TASK_ARCHIVED`。
- 导出按 all/active/archived 读取对应来源，三种完整结果与实施前 v4 golden 全等。
- 新增冷存储测试、双进程场景及可复测基准；更新升级、备份、回滚文档，完成计划归档与技术债登记。

### 设计动机

归档历史应只影响低频冷读，不增加日常轮询和活跃任务写入成本。使用原有全局文件锁与固定提交顺序，避免新增锁顺序风险；主文件优先可隐藏两文件操作中断后的重复副本。

旧 v1/v2/v3/v4 自动迁移至 v5，保留 `.vN.bak`。访问真实数据前必须停旧写进程，备份需同时保存主文件和归档目录。回滚先停写并另存升级后的全量数据，再恢复旧备份及移走冷目录；旧备份不包含升级后新增变更。本次仅对临时数据验证迁移。

### 验证结果

- `timeout 60s pnpm build`、`timeout 60s pnpm test`：通过；最终 287/287，测试约 7.55 秒。
- `pnpm smoke`、`pnpm verify:twoproc`、`pnpm verify:git`：各设 60 秒硬超时，通过；使用临时数据与临时 Git 仓库。
- UI 类型检查与构建：各设 60 秒硬超时，通过。
- 新增 15 项冷存储测试：迁移字节备份与重跑、两种崩溃中间态、计数快照、时间线、幂等、删除不复活、热路径隔离、归档守卫、导出全等、缺档与备份冲突、非法冷数据与路径。另在既有存储测试增加截断临时备份重跑用例。
- 双进程新增 6 轮归档/恢复与列表、详情、导出并发，核验不丢不重、计数快照和事件次数。
- 基准 `node scripts/bench-store.mjs`：9 样本中位数，100 活跃 + 0/5000 归档，boardList 1.345/1.899ms，listTasks 2.839/2.078ms，updateTask 4.217/5.086ms，createTask 8.443/8.417ms；热文件 313862/313886 字节。构造、迁移与预热不计时；运行负载影响绝对值。
- 改造前 v4 同条件前三项：5.241/121.823ms、2.867/108.897ms、4.300/165.501ms；创建任务未采集 v4 基线。
- 内置 Chrome 独立 bridge：宽屏与 420×900 窄栏，创建与状态控件流转、归档只读、搜索、三范围导出、恢复、断连禁用通过；见 [UI 验收记录](../../acceptance/20261004-archive-cold-storage.md)。临时 bridge 已停止。
- 只读代码审查发现的缺档静默空列表、备份冲突和备份发布中断问题已修复；差异空白检查通过。
- 未覆盖：UI 拖拽、冷文件读取失败错误态、Codex 原生宿主面板；已登记技术债。未配置 ESLint/Prettier，未声称运行相关检查。

### 变更统计

- **统计口径**：未提交，按任务开始前文件快照逐文件执行 `git diff --no-index --shortstat` / `--numstat`；新增文件与 `/dev/null` 比较。历史记录自身不计入。技术债表仅计本任务三行更新和一行新增，排除会话期间其他任务删除的行；计划移动按原文件与最终文件比较一次。
- **变更文件数**：14。
- **新增行数**：+996。
- **删除行数**：-102。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `AGENTS.md` | 2 | 2 |
| `README.md` | 13 | 2 |
| `packages/core/src/board-store.ts` | 300 | 41 |
| `packages/core/src/engine.ts` | 9 | 15 |
| `packages/core/src/native-execution.ts` | 13 | 8 |
| `packages/core/test/store.test.ts` | 32 | 15 |
| `packages/core/test/blocked-execution.test.ts` | 2 | 1 |
| `packages/core/test/archive-cold-storage.test.ts` | 276 | 0 |
| `packages/core/test/fixtures/archive-export-golden.json` | 158 | 0 |
| `scripts/two-process-verify.mjs` | 44 | 0 |
| `scripts/bench-store.mjs` | 88 | 0 |
| `docs/acceptance/20261004-archive-cold-storage.md` | 38 | 0 |
| `docs/exec-plans/completed/archive-cold-storage.md` | 17 | 15 |
| `docs/exec-plans/tech-debt-tracker.md` | 4 | 3 |

### 后续事项

SQLite 迁移、执行请求保留上限、冷文件分片，以及尚未覆盖的 UI/原生宿主验收，见 [技术债追踪](../../exec-plans/tech-debt-tracker.md)。
