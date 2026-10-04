## [2026-10-04 17:41 +0800] | 任务：接续会话并增加会话状态核对

### 执行上下文

- **Agent ID**：Codex 主代理及 UI/测试并行代理
- **Base Model**：未知
- **Runtime**：Codex Desktop 本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[状态核对计划](../../exec-plans/completed/manual-execution-recovery.md)

### 用户诉求与接续背景

> 使用 catchup 接续指定 ZCode 会话；状态不正确时增加按钮，发送消息核对会话并更新真实回执。

通过 catchup 的明确 agent、session id 和 since-compact 读取会话；延续其最终“发送核对消息，不直接重置”的决定。原实现只支持等待恢复，本轮扩展为状态核对，保留此前 blocked、真实会话映射和首次 running 同步 Ready→Doing。

### 变更概览

- 详情按钮为“核对会话状态”：当前非归档、非 cancelled 的执行请求均可显示，包含运行中和终态；宿主不可用时禁用。
- 复用 recovery_request/recover，新增可选 purpose=status/recovery；默认值保留旧恢复语义。相同检查 ID 不可改用途，不同用途在途检查不可互相覆盖，同用途 60 秒内 pending 合并。
- status 只写核对审计，禁止 stopped，不清除请求或绑定；同 run 正常补报完成不阻止核对审计。旧 run、错误宿主、过期观测等守卫保持。
- 提示词要求直接读取已知真实聊天；可向同一目标发送仅核对补回执消息，不重发正文、不新建、不将 idle 视为完成。实际执行变化必须由目标本人按原关联回报，终态不回退。
- 发送前后校验实时上下文、用途和请求身份；结果读取确认后才报告核对成功。更新中英文文案、技能与原先过时的人工恢复计划。

### 验证结果

- pnpm test（含构建）：259 项通过；新增 core/MCP 用例覆盖状态、用途隔离、并发回执、持久校验与旧协议兼容。
- UI typecheck、45 项 UI 测试和 UI 构建：通过。
- pnpm smoke、pnpm verify:twoproc、pnpm build:plugin、pnpm verify:plugin：通过。
- 自动化使用临时数据、每条命令硬超时 60 秒；没有发送真实任务消息或修改用户看板。未提交。
- 内置 Chrome 本轮报 Unable to load browser request-header policy；未验证真实面板点击和目标补回执，已登记技术债。
- 仓库插件包已重建，未覆盖已安装缓存；需加载新版后进行原生验收。

### 变更统计

- **统计口径**：相对本轮快照执行 git diff --no-index --shortstat/--numstat，新增测试相对 /dev/null。UI 快照根据首次读取原文反向还原本轮精确修改；排除既有其它任务改动、构建产物及本历史记录。包含为保留当前 UI 行为而修正的陈旧渲染断言。
- **变更文件数**：15
- **新增行数**：+650
- **删除行数**：-87

| 范围 | 文件数 | 新增 | 删除 |
| --- | ---: | ---: | ---: |
| core 类型、存储与核对逻辑 | 3 | 24 | 5 |
| MCP schema 与描述 | 1 | 4 | 2 |
| core/MCP 新测试 | 2 | 368 | 0 |
| UI 与渲染/协议测试 | 5 | 197 | 38 |
| 原生执行技能 | 1 | 7 | 0 |
| 契约、计划、技术债 | 3 | 50 | 42 |

### 后续事项

内置浏览器恢复并加载新版插件后验收真实交互；状态核对不会绕过终态守卫，错误终态的更正不在本轮范围。
