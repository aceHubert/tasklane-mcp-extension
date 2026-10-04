## [2026-10-04 14:49 +0800] | 任务：隐藏未绑定会话按钮与未连接宿主的执行控件

### 执行上下文

- **Agent ID**：`ZCode`
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；React/TypeScript/Vite
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，不能用 HEAD 作为本次差异基线
- **关联计划**：无，本次为限定 UI 条件显示，不改变原生执行契约

### 用户诉求

> 没有绑定 threadId 时不要显示打开 Codex 会话按钮；宿主未连接时，工作区选择、模型选择和 Run Codex 面板也不显示。

### 变更概览

**影响范围**：TaskDetail、TaskCard、显示回归与现有插件版本同步。

- 卡片和详情使用既有 hasRealBinding 判断：仅有真实就绪 threadId、宿主及目录绑定才显示打开会话按钮；无绑定、空 threadId、sess-*、创建中占位值或仅 created 请求结果不显示。
- 用实时 hostSnapshot.connected 与 MCP conn 区分原生宿主连接和仅独立数据通道连接。宿主未连接时隐藏工作区、模型、Run/继续控件及对应说明，不查询模型目录；不会因独立 MCP 已连接就显示原生执行面板。
- 保留会话 ID、执行状态、请求/错误记录、已有绑定目录和宿主连接提示。已有真实绑定但暂时断连时可保留禁用的打开按钮，未绑定时完全不显示。
- 宿主连接后恢复工作区/模型/Run 显示，原有能力判断继续决定是否可操作。Run 与打开会话的实际处理逻辑、内部 ID、绑定数据和执行状态机均未改变。
- 现有 TaskLane 插件 App、服务、manifest 与市场版本同步 0.3.7，构建包由既有流程生成，未安装或重启用户插件。

### 设计动机

没有真实线程时显示禁用的“打开会话”没有价值；没有原生宿主连接时展示整套执行控件
容易使用户误解为普通 MCP 连接已具备执行能力。此次仅调整可见性，不产生业务写入，
不猜测聊天身份，不以显示与否代替服务端权限和状态校验。

### 验证结果

| 检查 | 最终结果 |
| --- | --- |
| `pnpm --filter @tasklane/ui typecheck` | 通过 |
| `node --test ui/test/*.test.mjs` | **33/33 通过**，0 失败 |
| `pnpm build:ui` | 通过 |
| `pnpm build:plugin` | 通过，含 core/MCP 构建与 widget 打包 |
| `pnpm verify:plugin` | 通过 |
| `git diff --check` | 通过 |
| manifest、市场、App 与服务版本 | 0.3.7 一致 |

新增和更新组件渲染回归覆盖卡片、窄详情、宽抽屉的无 threadId/空值/内部 ID/占位 ID/
仅 created/有效绑定；以及 connecting/disconnected、独立 MCP 已连接但宿主未连接、
原生宿主重连恢复。确认未连接时不含工作区、模型与 Run/继续控件，仍保留会话和 pending
状态；无真实绑定无打开按钮。既有绑定在断连时保留禁用打开按钮。

各自动化命令设置 60 秒硬超时，无超时。本次没有核心业务改动，不执行全库业务测试；
构建与插件验证按当前共享状态通过。遵循当前原生计划不继续模拟浏览器验收的限制，
未打开测试服务/模拟宿主、未操作用户真实任务、未尝试真实 Codex 深链接。静态渲染和
协议测试不代表原生宿主界面已验收。

### 变更统计

- **统计口径**：任务开始前保存源码快照，逐文件执行 `git diff --no-index --shortstat`
  与 `--numstat`，排除之前已有改动与历史记录自身。返回 1 表示存在差异而非失败。
- **排除范围**：自动生成的插件 bundle 不计入行数；保留既有消息区移除、执行方、会话
  ID 优先级、模型目录和删除功能，不额外改动其它文件。TaskDetail 的条件块缩进变化包含在统计中。
- **变更文件数（源码/测试/配置/说明）**：10
- **新增行数**：+145
- **删除行数**：−69

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskDetail.tsx` | 61 | 54 |
| `ui/src/components/TaskCard.tsx` | 6 | 4 |
| `ui/test/task-detail-controls.test.mjs` | 71 | 4 |
| `ui/test/native-execution.test.mjs`（仅版本断言） | 1 | 1 |
| `ui/src/mcp/appsClient.ts`（仅版本） | 1 | 1 |
| `ui/README.md` | 1 | 1 |
| `extension/src/plugin-server.mjs`（仅版本） | 1 | 1 |
| `extension/plugin-src/plugin.json`（仅版本） | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json`（仅版本） | 1 | 1 |
| `.claude-plugin/marketplace.json`（仅版本） | 1 | 1 |

### 修改文件

上表 10 个文件、本历史记录，以及构建流程生成的 `plugins/tasklane/` server、widget
和两份 manifest。产物未手改；未执行 git add/commit/push，未操作真实看板或系统配置。

### 后续事项

源包已生成 0.3.7，用户已安装插件是否更新、运行中面板是否已重载尚未确认；真实 Codex
界面与深链接能力取证仍是既有原生验收事项，不属于本次隐藏控件范围。
