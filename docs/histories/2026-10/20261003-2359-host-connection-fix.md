## [2026-10-03 23:59 +0800] | 任务：修复 Codex 宿主识别并提供连接验证入口

### 执行上下文

- **Agent ID**：Codex
- **Base Model**：具体模型变体未知
- **Runtime**：Codex Desktop，macOS，本地 pnpm workspace
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[原生执行计划](../../exec-plans/completed/codex-native-execution-bridge.md)

### 用户诉求

> 重启后仍提示未接入 Agent 执行能力，要求直接修改；后续明确同意更新已安装插件。

### 变更概览与动机

- `open_tasklane` 从 MCP SDK 实际 initialize 连接读取 `mcpClient`，不接受
  调用参数冒充客户端。UI 联合真实 MCP Apps 握手与 `codex` /
  `codex-mcp-client` 标识识别 Codex，兼容通用 UI 桥名称。
- `nativeExecution.hostInfo` 保留实际名称和版本，包括通用桥名；UI 仍校验
  本次握手、声明、有效期与上下文。身份提示不等于执行证明，也不提供认证。
- 新增 `HostConnection`：展示两条握手原始信息，提供内联确认的连接验证。
  只向关联聊天发送专用只读测试聊天请求，不写任务、不因投递成功启用执行。
- 验证未知结果使用原 verificationId 核对；待核对标记跨上下文和重载保留，
  避免重复创建。缓存不会恢复客户端身份或执行声明。
- 技能适配必填 prompt 的原生创建工具：先只读准备、取得真实结果并绑定，
  再发送任务正文。Stop 继续禁用，非 Codex 默认不执行。
- 插件与面板版本升至 0.3.1，更新资源 URI 避免复用旧页面；通过构建生成
  bundle，保留其他会话的界面清理和未提交改动。

### 验证结果

- `pnpm test`：119/119，通过（包含构建）。
- UI 协议测试：10/10，通过，包括通用桥识别、非 Codex 零投递、无声明
  不执行、真实 peer 输出、缓存剥离、跨上下文/重载防重复。
- UI typecheck、UI 构建、插件构建、stdio 冒烟、插件验证均通过；后台检查
  设置 60 秒硬超时。未重复运行 Git、双进程和 bridge 检查，核心规则未修改。
- 独立浏览器临时看板：宽视图和 360×800 窄栏显示连接事实，缺失值为
  “未提供”，验证和执行入口禁用；窄栏无横向溢出，断连后保持只读。
- 自动审批最初拒绝持久更新插件；用户随后明确同意。原命令重试成功，
  安装返回 `tasklane@tasklane`、0.3.1；本地清单和缓存 manifest 均确认版本。
- 当前聊天的打开工具仍未返回新 `mcpClient` 字段，实际新服务加载尚需
  重载确认。没有提供伪造的路由声明，没有创建真实测试聊天或启动任务。
- 临时服务和页面已清理，未修改真实看板数据、Git 分支或工作区。

### 变更统计

- **统计口径**：本次唯一独占新增组件与 `/dev/null` 对比，使用
  `git diff --no-index --shortstat` / `--numstat`，排除历史记录自身。
- **确定新增文件数**：1；**新增行数**：+88；**删除行数**：-0。
- 共享文件任务前已修改，未保存完整任务前快照，不能把暂存差异全部算作
  本次新增。另已执行限定十个共享源文件的 `git diff --shortstat` /
  `--numstat`；当时输出 +769/-283，包含既有实现，**不是本次净增删统计**。
- 未跟踪但已存在的 UI 测试、技能和契约也只做局部修改，不将其全部行数
  归入本次任务；生成 bundle 不计入独占新增统计。

### 修改文件

- `ui/src/components/HostConnection.tsx`、`TaskDetail.tsx`。
- `ui/src/host.ts`、`ui/src/mcp/appsClient.ts`、`ui/src/i18n/nativeMessages.ts`、
  `ui/src/styles.css`、`ui/test/native-execution.test.mjs`。
- `extension/src/widget.mjs`、`plugin-server.mjs`，插件源 manifest 与 marketplace。
- 原生执行技能、契约、接入说明、执行计划和验收报告；插件产物由构建生成。

### 后续事项

- 重新加载 0.3.1 服务，查看实际握手，再通过连接入口明确确认专用验证聊天。
- 实测接收聊天、真实目录、回复与深链接；已有 worktree 复用和可靠停止仍
  按原计划分别验证，不能用测试或安装成功替代真实执行闭环验收。
