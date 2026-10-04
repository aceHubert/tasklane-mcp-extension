# 归档任务按看板拆分冷存储（board.json 热路径瘦身）

- 状态：已完成（原生宿主及部分 UI 回归未覆盖，详见验收记录）
- 创建日期：2026-10-04
- 最后更新：2026-10-04
- 负责人：Codex；存储与引擎由同一子代理负责，测试、验证脚本独立并行
- 关联历史记录：[实施记录](../../histories/2026-10/20261004-2250-archive-cold-storage.md)

## 目标

把已归档任务及其时间线从热文件 `board.json` 拆出，按看板写入独立冷存储文件，
使存储读写成本只随「活跃任务数」增长，不再随历史归档总量增长；`board_list`
不再为统计归档数量而全量读取归档任务。可观察的完成条件：

- 活跃任务量不变时，归档总量从 0 增至数千，`board_list` / `task_list` /
  单任务读写耗时保持在同一量级。
- 归档视图、恢复、导出的行为与现有契约一致；导出把活跃与归档合并为候选
  池后，按用户选择的任务范围（scope：all 含归档 / active 仅未归档 /
  archived 仅已归档，默认 all）筛选；MCP 工具名、参数、返回结构不变；
  UI 无需改动。
- v4 数据自动迁移到 v5：迁移前备份、可重入、可回滚。

## 范围

- 包含：
  - 存储层（`packages/core/src/board-store.ts`）：按看板归档文件读写与校验、
    v4→v5 迁移、每看板 `archivedCount` 计数器、`getTask`/`getSession` 未命中
    回退扫描归档文件、归档/恢复两文件移动的崩溃安全顺序、跨文件操作原语
    （moveToArchive / restoreFromArchive，不复用只作用于主文件的
    `mutateTask*`，目标不在主文件）。
  - 引擎层（`packages/core/src/engine.ts`、`packages/core/src/native-execution.ts`）：
    `boardList` 改用计数器；`listTasks(archive: archived/all)` 读归档文件；
    `archiveTask` / `archiveDoneTasks` / `restoreTask` 改为跨文件移动；
    `exportTasks` 合并读取；执行链入口保持 `TASK_ARCHIVED` 错误码契约。
  - 测试：core 单测（迁移、崩溃中间态、幂等、计数、回退、导出合并）、
    `scripts/two-process-verify.mjs` 归档场景、性能基准复测。
  - 文档：README 存储与升级说明、技术债表、历史记录。
- 不包含：
  - 不换 SQLite（另行评估，见技术债表触发条件）。
  - 不给 `executionRequests` 加保留上限（单独登记技术债）。
  - 不改 MCP 契约与 UI 行为；归档文件暂不按年分片（先单看板单文件）。
  - 不改导出契约（任务范围选择 all/active/archived 的语义、区间口径、落盘
    与返回结构均不变）。
  - 不碰 Git/worktree 生命周期与执行链状态机语义。

## 背景

- 相关文档：[任务归档实施记录](../../histories/2026-10/20261003-2157-task-archiving.md)（现有
  归档语义；其遗留项「归档只减少日常展示，不缩小 JSON 文件；存储体积优化
  本期明确不做」由本计划承接）、[执行计划规范](../../PLANS_GUIDE.md)、
  [README](../../../README.md)。
- 相关代码：`packages/core/src/board-store.ts`（单文件存储、`transaction()`、
  `reload()`、`normalizeV4`、`MAX_EVENTS_PER_TASK`）、`packages/core/src/engine.ts`
  （`boardList` / `listTasks` / `archiveTask` / `archiveDoneTasks` /
  `restoreTask` / `exportTasks`）、`packages/core/src/session.ts`、
  `mcp/src/handlers.ts`、`ui/src/state/BoardContext.tsx`（`POLL_MS = 4000`）、
  `ui/src/components/ExportDialog.tsx`（任务范围选择 scope: all/active/archived）。
- 当前行为与问题：
  - 归档仅是 `archivedAt` 标记，任务与时间线仍在同一 `board.json`；
    「不参与看板操作」只在业务过滤层成立（引擎默认 `archive: 'active'`），
    存储层每次读写仍全量解析、校验（`normalizeV4`）、重写归档任务。
  - `engine.boardList()` 调无过滤 `store.listTasks()` 并 `structuredClone`
    全部任务（含归档）只为算 `counts` / `archivedCount`；UI 每 4 秒轮询
    `board_list`，等于每 4 秒把全部归档任务读出来克隆一遍。
  - 每次写入 = 文件锁 + 整文件重读校验 + 整份 pretty-print 序列化 +
    原子重命名；`createTask` 一次触发 3 次全量写（`nextId` + `putTask` +
    `appendEvent`）。
- 实测（2026-10-04，合成数据每任务约 2.7KB、1/3 带执行请求、每任务 10 条
  事件；真实数据约 6KB/任务，曲线更陡）：

  | 任务数 | 文件大小 | 单条读取 | 全列表读取 | 单条写入 | nextId 落盘 |
  | --- | --- | --- | --- | --- | --- |
  | 100 | 0.27MB | 1.6ms | 3ms | 4ms | 4.6ms |
  | 1000 | 2.7MB | 18ms | 24ms | 136ms | 46ms |
  | 10000 | 27MB | 218ms | 334ms | 637ms | 500ms |

- 已知约束：
  - 归档任务事实上只读：所有写入口（`update` / `move` / `assign` / 执行回执）
    已被 `assertNotArchived` / `guard()` 拒绝，只有恢复、导出与归档视图读
    它们，这是拆分安全的前提。
  - 多进程共享同一 board.json（Claude Code MCP server、bridge 子进程、
    扩展 plugin-server 各自实例），一致性依赖「每次操作重读 + 文件锁」，
    拆分后必须维持同等的崩溃安全。
  - 查询不跨看板（归档视图带 boardId、恢复为单任务、导出强制单看板、批量
    归档 boardId 必填），按 boardId 分文件成立；唯一例外是 `task_get` 按
    全局 ID 查询（UI `refreshDetail` 只传 `id`），需回退扫描兜底。
  - `boardId` 形如 `board-<hex>` 或 `default`；用作文件名前按 identifier
    规则校验，防路径穿越。
  - 现有语义不可变：仅 done 可归档、恢复回 Done、重复操作幂等
    （`changed=false`）、归档/恢复事件与任务变更同事务提交、
    `board_list.archivedCount`、`task_list.archive` 默认 active、
    导出任务范围由用户选择（默认 all 含归档）。

## 设计（已固定）

1. 文件布局：`<数据目录>/archive/<boardId>.json`（`TASKLANE_HOME` 生效）。
   内容 `{ version, boardId, tasks, sessions }`；校验：任务 `boardId` 必须
   等于文件所属看板、任务 id 与键一致、事件 kind 沿用 `SESSION_EVENT_KINDS`、
   时间戳与字段规则沿用 `normalizeV4` 的同款校验（自包含，不交叉读主文件
   boards 列表）。首次归档惰性创建；全部恢复后保留空文件（无害）。
2. 主文件 v5：`StoreData` 增加每看板计数器 `archivedCounts:
   Record<boardId, number>`（缺失视为 0）；`tasks` / `sessions` 仅存活跃任务。
3. 崩溃安全（两文件无法单事务，用固定顺序 + 合并规则）：
   - 归档 = 先写归档文件（任务 + 其 session 含 `archived` 事件，按 taskId
     覆盖式 upsert）→ 再重写主文件（移除任务与 session、递增计数器）。
   - 恢复 = 先写主文件（加回任务与 session 含 `restored` 事件、递减计数器）
     → 再从归档文件删。
   - 读取规则：主文件优先；归档读取过滤掉主文件中存在的 ID（重复对用户
     不可见）。
   - 任何时刻崩溃不丢任务，最多留一条被隐藏的重复；重跑幂等（覆盖式写入，
     幂等语义沿用现有 `changed=false` 口径）。
4. 锁：复用现有全局文件锁（`board.json.lock`），不为归档文件引入第二把锁，
   避免锁顺序与死锁；归档为低频操作，持锁时长可接受（归档文件整份重写
   是已知成本，见「风险」）。
5. 读路径：
   - `getTask(id)`：主文件命中直接返回；未命中扫描各看板归档文件（看板数
     少、冷路径）。`engine.getTask` 与 `task_get` 契约不变，UI 零改动。
   - `getSession(taskId)`：同上（归档任务的时间线从归档文件读）。
   - `listTasks(archive: 'archived')`：只读该 boardId 的归档文件；
     `'all'` 合并主文件 + 归档文件。实现时明确 `archive` 缺省语义
     （建议 undefined = active，与引擎缺省一致）并核对全部调用点。
   - `boardList`：`counts` / `total` 由主文件活跃任务计算，`archivedCount`
     读计数器，不再全量读归档。
   - `exportTasks`：候选池 = 主文件活跃任务 ∪ 该看板归档文件（两处数据源
     合并）；按用户选择的任务范围筛选（UI「任务范围」：all 默认含归档 /
     active 仅未归档 / archived 仅已归档），再按现有口径（创建/更新/归档
     时间任一命中区间）筛选、统计与渲染，输出与拆分前一致。等价实现：
     `scope=active` 只读主文件、`'archived'` 只读归档文件、`'all'` 合并
     两处，结果与「合并后按选择筛选」全等。
6. 写路径：`archiveTask` / `archiveDoneTasks` / `restoreTask` 走新增的跨文件
   原语，按上述顺序执行；其余写入口只碰主文件。两个契约细节：
   - 归档幂等检查需同时看两处（主文件中未归档 = 可归档；归档文件中已存在
     `archivedAt` = 已归档，返回 `changed=false`）。
   - 写入口与执行链入口在任务位于归档文件时，必须继续抛 `TASK_ARCHIVED`
     （先按 ID 读取含归档回退），不得因主文件未命中退化为 `TASK_NOT_FOUND`
     （`native-execution.transaction` 等入口目前直连 `mutateTaskWithEvent`，
     需补前置读取）。
   - `nextId` / 序号仍在主文件；任务 ID 不因归档/恢复改变。

## 兼容、迁移与回滚

- 主文件 v4→v5，迁移在锁内执行：`backupBeforeMigrate` 备份（`.v4.bak`）
  → 按 `archivedAt` 分组写各看板归档文件 → 重写主文件（活跃任务 + 计数器）。
- 可重入：中途失败重跑安全（归档文件按 taskId 覆盖，主文件未改完仍是 v4，
  重新分组迁移）。
- 旧二进制遇到 v5 主文件按现有「未知存储文件版本」拒绝启动，与历次迁移
  一致；升级需同时更新所有实例（README「升级前停旧写进程」要求沿用并
  补充归档目录说明）。
- 回滚：保留 `.v4.bak` 与归档文件；回滚 = 停写 → 用备份恢复 board.json →
  删除 `archive/` 目录。
- 并发：迁移在锁内完成；其他进程只会读到 v4 或 v5（原子重命名），不会
  读到中间态。

## 风险

- 两文件一致性：靠「固定顺序 + 主文件优先 + 覆盖式重写」兜底；测试注入
  两种崩溃中间态（归档文件已写、主文件未改；主文件已改、归档未删）验证
  读取与重跑收敛。
- 计数器漂移：仅在锁内与任务移动同一次主文件写入更新；测试覆盖单条/批量
  归档与恢复后的计数；不做自动修复（如未来需要可加「按归档文件重算」命令）。
- 错误码退化：归档任务的写入尝试必须保持 `TASK_ARCHIVED`；测试覆盖
  update / move / assign / 执行回执对归档任务的拒绝码。
- 回退扫描成本：`getTask` 未命中时扫描 N 个归档文件；看板数少且归档查询
  低频，可接受；如未来看板数大再加主文件内 id→board 索引（暂不做）。
- 归档文件无限增长：单看板多年历史会让归档视图/导出变慢，且每次归档操作
  整份重写归档文件；触发后按年分片或并入 SQLite，登记技术债。
- 校验衔接：归档文件自校验（任务 boardId = 文件 boardId），不交叉读主文件。

## 里程碑与并行边界

1. 存储层（单一负责人，`board-store.ts`）：归档文件模块、v5 迁移、计数器、
   回退扫描、跨文件原语与崩溃安全顺序。
2. 引擎层（同负责人）：`boardList` / `listTasks` / `archive` / `restore` /
   `export`（合并为验收重点）改造；执行链入口补 `TASK_ARCHIVED` 前置检查。
3. 测试与验证（用例可与实现并行编写，执行串行）：core 单测、双进程脚本
   归档场景、基准复测。
4. 文档与收尾：README/AGENTS.md（如需）、历史记录、技术债表、计划归档。

- 可并行：测试用例与文档；UI 无需改动，不占用 UI 负责人。
- 必须串行：存储层 → 引擎层 → 全量验证；`board-store.ts` 同一时间只允许
  一个修改者。

## 验证方式与验收标准

- 自动化命令（各 60 秒硬超时）：`pnpm build`、`pnpm test`、`pnpm smoke`、
  `pnpm verify:twoproc`（新增场景：A 进程归档同时 B 进程
  `board_list` / `task_list` / `task_get` / 导出，无覆盖、计数正确、无重复
  或丢失）、`pnpm verify:git`（确认不受影响）、`pnpm --filter @tasklane/ui
  typecheck` 与 `pnpm build:ui`（契约未变，验证未被误伤）。
- 新增 core 测试：
  - v4→v5 迁移：含归档旧文件正确拆分、计数器正确、`.v4.bak` 存在；重跑幂等。
  - 崩溃中间态注入两种 + 重跑收敛 + 重复 ID 主文件优先。
  - 计数：单条归档 / 批量归档 / 恢复后 `board_list.archivedCount` 与归档
    文件一致。
  - 回退：`task_get` / `task_restore` / 时间线对归档任务可用；不存在 ID
    快速失败；归档任务写入尝试返回 `TASK_ARCHIVED`。
  - 导出：合并活跃+归档为候选池后按任务范围选择筛选 —— `scope=all` 含两处、
    `active` 排除归档、`archived` 只含归档；区间筛选与拆分前结果一致
    （实现前用 v4 存储生成 golden 导出快照，拆分后同一数据断言全等）；
    `scope: active` / `archived` 只读对应单一数据源。
- 性能验收：构造「活跃 100 + 归档 5000」与「活跃 100 + 归档 0」两组数据，
  `board_list`、`task_list`、单任务写入耗时差异在小常数内（热路径不再随
  归档量线性增长）。复测并纳入基准脚本（2026-10-04 会话基准的合成参数：
  每任务约 2.7KB、1/3 带一条执行请求、每任务 10 条事件；建议落为
  `scripts/bench-store.mjs`）。
- 可观察验收条件：全部自动化通过；现有 UI 全流程（打开、拖动、归档、
  归档视图搜索/恢复、导出）无行为变化。
- 实际结果：构建、287 项 core/MCP 测试、stdio 冒烟、双进程、临时 Git 验证、UI 类型检查与构建通过，所有自动化设置 60 秒硬超时。
- 新增 15 项冷存储测试；三种导出 scope 与改造前 v4 golden 完整全等。额外覆盖冷文件缺失时明确报错、已有迁移备份不符时中止、恢复残留副本后删除任务不复活。
- 性能（9 样本中位数，100 活跃 + 0/5000 归档，单位 ms）：boardList 1.345/1.899，listTasks 2.839/2.078，updateTask 4.217/5.086，createTask 8.443/8.417；热文件 313862/313886 字节。v4 同条件前三项为 5.241/121.823、2.867/108.897、4.300/165.501。计时排除构造、迁移及预热，机器负载会影响绝对耗时。
- UI 独立 Chrome + bridge 已验证宽屏创建与状态控件流转、归档、420px 搜索、三种范围导出、恢复、断连禁用与实际 v5 落盘；拖拽、冷读失败错误态及 Codex 原生宿主未覆盖，已登记技术债，详见 [UI 验收记录](../../acceptance/20261004-archive-cold-storage.md)。

- 2026-10-04 独立复验（另一会话）：重跑 `pnpm build`、`pnpm test`（287/287）、`pnpm smoke`、`pnpm verify:twoproc`、`pnpm verify:git`、UI typecheck 与 `build:ui` 全部通过；独立探针 37 项（归档-恢复-导出端到端、两种崩溃中间态、缺档显式报错、v4→v5 迁移备份与幂等）全过；基准复测四项比值 0.68–0.99、热文件 313862/313886 字节。复验发现 `plugins/tasklane` 打包产物仍内嵌旧核心（v4，拒绝 v5 数据），已执行 `pnpm build:plugin` 重建并 `pnpm verify:plugin` 复验通过；插件包对 v4 数据实测迁移到 v5（主文件 v5、冷文件生成）。

## 进度记录

- [x] 确认范围、约束和工作区已有改动；保留已有暂存、未暂存和未跟踪文件，以任务前快照统计本次差异。
- [x] 存储层：归档文件模块 + v5 迁移 + 计数器 + 回退扫描 + 跨文件原语。
- [x] 引擎层：boardList / listTasks / archive / restore / export（合并）改造。
- [x] 测试、双进程验证与基准复测。
- [x] 文档更新与历史记录。
- [x] 将明确推迟的事项登记到技术债表（SQLite 迁移、executionRequests
      上限、归档文件分片）。
- [x] 完成后移至 completed/ 并更新链接。

## 决策记录

- 2026-10-04：不换 SQLite，先做「按看板拆分冷文件」：成本更低、
  `BoardStore` 接口不变上层无感，可把 SQLite 必要性大幅推迟；热文件回到
  百级活跃即毫秒级。
- 2026-10-04：按 boardId 分文件而非单一归档文件：现有查询不跨看板，归档/
  恢复只重写单看板文件，校验可自包含。
- 2026-10-04：复用全局单锁，不引入归档文件锁：低频操作、避免锁顺序与死锁。
- 2026-10-04：`archivedCount` 用主文件计数器，不读归档文件：否则 UI 每
  4 秒轮询会把冷文件拉回热路径。
- 2026-10-04：`task_get` 全局 ID 查询用「主文件未命中 → 扫描归档文件」
  兜底，MCP 契约与 UI 零改动。
- 2026-10-04：导出把活跃与归档合并为候选池后，按用户选择的任务范围
  （UI「任务范围」：全部含归档/仅未归档/仅已归档，默认 all）筛选，再按
    区间筛选渲染；输出与拆分前保持一致（golden 快照断言）。

## 阻塞点与下一步

- 当前阻塞：无。
- 下一步：在重载后的 Codex 原生面板补充宿主验收；存储规模达到技术债触发条件后再评估分片或 SQLite。
