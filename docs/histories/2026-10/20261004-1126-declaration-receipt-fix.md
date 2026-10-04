## [2026-10-04 11:26 +0800] | 任务：修复原生声明接收与失效诊断

### 执行上下文

- **Agent ID**：Codex
- **Base Model**：未知
- **Runtime**：Codex desktop，本地 macOS 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：`docs/exec-plans/completed/codex-native-execution-bridge.md`

### 用户诉求

> 验证聊天已确认收件及项目目录，但面板仍显示原生能力声明未提供，执行保持关闭。

### 变更概览

- `McpAppsClient` 兼容实时工具结果的 `_meta.widgetData`；顶层结构优先，失败结果不授权。
- 区分 SDK 纯展示通知与执行上下文；主题、尺寸、展示模式等保留实时声明，
  `toolInfo`、未知扩展、空通知、断连及重载仍撤销权限，不缓存声明。
- 诊断区分别显示未提供、格式无效、收到后失效；实际执行仍校验身份、范围、
  10 分钟有效期、消息路线、工作区方式和绑定。
- 发布源版本与资源 URI 改为 0.3.2；更新契约、计划和验收报告。

### 设计动机

SDK 的 `host-context-changed` 还用于传递主题、尺寸等纯展示信息；原实现无条件
撤销声明，会把展示变化误认为连接失效。新实现仅对白名单展示字段保留声明，
未知通知仍保守关闭。诊断状态只用于显示，不恢复或授予权限。

真实宿主的通知形状及顺序尚未取得，因此只能确认源码存在过度失效问题，
不能声称已证明用户所见问题的唯一根因。SDK 文档规定回调参数是直接工具结果，
没有加入猜测的 `result` 或 `toolResult` 外层解析。

### 验证结果

- `node --test ui/test/native-execution.test.mjs`：12/12，通过；新增展示保留、
  上下文撤销、诊断原因、元数据优先级、失败/无效结果拒绝测试。
- `pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`、`pnpm build:plugin`：通过。
- `pnpm verify:plugin`、`pnpm smoke`：通过，使用临时数据；测试设置 60 秒硬超时。
- `git diff --check`：通过。只读并行审查未发现执行门控绕过。
- 内置 Chrome 因请求头策略加载失败无法使用，改内置 IAB 验收模拟宿主：
  声明接收后显示已提供，展示通知后仍保留，工具上下文变化后撤销并显示原因。
- 当前 0.3.2 本机缓存中的 UI/server 与构建产物逐字节一致；本轮未再次安装。
- 临时 UI 验收服务已无端口监听；本地修复阶段未修改真实任务数据、创建新聊天或发送跨聊天消息。
- 未覆盖：真实宿主声明回写、独立 worktree、旧工作区复用、深链接和真实任务执行。
  原有专用验证聊天只证明已完成的收件与项目目录检查，不延长旧声明有效期。

### 变更统计

- **统计口径**：任务前文件快照逐文件 `git diff --no-index --numstat`/`--shortstat`；
  排除既有工作区差异、生成产物、临时验收程序及历史记录自身。
  `verify-plugin.mjs` 只计资源 URI 的 1/1；另一会话修改的英文技能断言另有历史记录。
- **变更文件数**：15
- **新增行数**：+137
- **删除行数**：-19

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/mcp/appsClient.ts` | 19 | 8 |
| `ui/src/host.ts` | 2 | 0 |
| `ui/src/components/HostConnection.tsx` | 3 | 1 |
| `ui/src/i18n/nativeMessages.ts` | 4 | 0 |
| `ui/test/native-execution.test.mjs` | 67 | 0 |
| `docs/exec-plans/active/codex-native-execution-bridge.md` | 9 | 1 |
| `docs/native-execution-contract.md` | 3 | 1 |
| `.claude-plugin/marketplace.json` | 1 | 1 |
| `extension/plugin-src/plugin.json` | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 1 | 1 |
| `extension/src/plugin-server.mjs` | 1 | 1 |
| `extension/src/widget.mjs` | 1 | 1 |
| `extension/README.md` | 1 | 1 |
| `scripts/verify-plugin.mjs` | 1 | 1 |
| `docs/acceptance/20261003-archive-codex-bridge.md` | 23 | 1 |

### 后续事项

- 用户后续明确确认跨聊天继续验证后，已向原接收聊天发送恢复指令，等待其复用既有
  专用聊天完成新一轮只读核对及声明回写；禁止重复创建或执行真实看板任务。
- 本轮收件与目录已确认；尚缺当前面板握手。原聊天的 TaskLane 卡片未展开，
  面板工具列表为空且主界面不允许自动操作，已打开原聊天供用户展开后继续。
- 原生完整验收仍保留 active，不能以本地模拟验收替代真实执行证据。
