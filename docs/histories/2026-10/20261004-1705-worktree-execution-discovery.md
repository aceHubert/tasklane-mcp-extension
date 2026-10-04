## [2026-10-04 17:05 +0800] | 任务：修复 worktree 执行中断并增加 blocked

### 执行上下文

- **Agent ID**：Codex（主代理、core/UI/MCP 并行代理及只读审查）
- **Base Model**：未知
- **Runtime**：Codex Desktop，本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[worktree 执行修复](../../exec-plans/completed/worktree-execution-discovery.md)

### 用户诉求

> 修复独立 worktree 未成功执行的问题；即使异常也写回真实会话和状态；增加 blocked，继续时先核对状态再复用执行。

### 变更概览

- 核心、存储与 MCP 增加 blocked。绑定前由正确认领者记录原因，绑定后由目标聊天回报；禁止无原因或错误关联更新。
- 正确认领者的 uncertain 不再静默丢失；created 已保存真实结果时只补错误，不丢失会话。
- blocked 仅允许已有真实结果/绑定的 continue，生成新 run 并继承同一工作区、模型、结果及 recoveryOf；不允许重复创建、替换会话或用旧回执覆盖。
- UI 展示阻塞原因和已保存的真实 created 会话，提供核对后继续；无结果先核对原创建。拒绝 client-new-thread/clientThreadId 临时标识。
- 提示词和技能要求异常写回、直接 read_thread 核验候选链接、保存 created 优先于完整准备、结束前读取确认，并区分未知结果、可恢复阻塞和失败。
- 审查后修正旧 deliveryError 掩盖当前 blocked 原因，以及继续提示词可能漏掉本轮绑定的歧义；保留并发的断连只读模型显示并更新相关断言。
- 冒烟工具列表同步两个已存在的核对工具，保留并发人工恢复功能。

### 设计动机

列表遗漏不能作为会话创建失败的证据。已有真实聊天链接可以直接核验并恢复；仅有临时创建 ID 时不猜测真实 ID，不重建。blocked 是执行状态，不改变 Ready/Doing 等业务阶段，也不是停止真实进程的证明。v4 新枚举需同数据目录的服务同步升级；回滚保留新增记录、聊天与工作区。

### 验证结果

- `pnpm test`（含 core/MCP 构建）：224 项通过。
- UI typecheck、38 项 UI 测试、build:ui、build:plugin：通过。
- smoke、verify:plugin、verify:git、verify:twoproc：通过。自动化命令均设 60 秒硬超时，集成数据为临时目录/仓库。
- 原生 TASK-110：沿用原 claim/run 和已创建聊天，created→bound→running→completed 全部持久化；running/completed 由目标本人回报。独立 worktree 干净且 detached HEAD，主仓库与旧 worktree 均未改动，卡片按约定保留 Ready。
- 第一次完成回执因目标误抄 requestId 被拒绝，目标核对后更正原请求并成功写回，未跳过关联守卫。
- 首轮构建受并发人工恢复接口尚未整合影响；整合后完整复测通过。
- 内置 Chrome 两次无法加载请求头策略，未做真实浏览器截图/交互验收。已有隔离 React fixture；实际 blocked 原生交互仍需重载新插件后验收，见技术债。
- 新插件包仅构建到仓库内，未覆盖已安装缓存，未提交。

### 变更统计

- **统计口径**：任务前文件快照与最终源码用 `git diff --no-index --shortstat/--numstat` 比较；新增文件与 `/dev/null` 比较。native-execution 按所负责常量、辅助函数和 request/delivery/claim/bind/report 方法抽取比较，排除并发 requestRecovery/recover；UI 按代理交付统计叠加本轮审查修复，排除随后并发的只读模型控件实现（保留为适配该行为调整的测试）。排除构建产物、临时 fixture 和本历史记录。
- **变更文件数**：23
- **新增行数**：+922
- **删除行数**：-74

| 范围 | 文件数 | 新增 | 删除 |
| --- | ---: | ---: | ---: |
| core 状态、存储及两份新增回归 | 5 | 480 | 32 |
| UI 类型、组件、操作、提示词与测试 | 10 | 195 | 29 |
| MCP schema 与新增契约测试 | 2 | 146 | 7 |
| 原生执行技能 | 1 | 21 | 1 |
| 原生执行契约 | 1 | 14 | 3 |
| smoke 与 verify-plugin | 2 | 4 | 2 |
| 执行计划与技术债 | 2 | 62 | 0 |

### 后续事项

- 重载新插件；实际 Chrome/原生 blocked 交互验收仍待浏览器工具恢复。
- 宿主临时创建 ID 自动解析、detached HEAD 独立建模已记入技术债，不宣称完全自动解决宿主列表遗漏。
