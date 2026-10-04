# TaskLane 原生应用插件接入

本目录维护现有 Codex 插件源码；当前源版本 `0.3.14`，身份保持 `tasklane@tasklane`。

## 构建与打开

```bash
pnpm install
pnpm build:plugin
pnpm verify:plugin
```

`plugins/tasklane/` 为构建流程生成的自包含包，含 server、widget、图标、打开技能及
`native-execution` 技能；不要手改 bundle。本次构建不代表插件已安装或正在运行。

按目标 Codex 宿主当前支持的插件流程更新现有 TaskLane 插件，再关闭并重新打开面板，
在新会话确认工具版本。旧会话可能继续使用旧 MCP 服务；不要仅凭磁盘版本判断已切换。
本次未安装、卸载、重启宿主或修改用户配置。升级访问真实数据前需停用同一数据目录的
旧写进程；v1/v2/v3 会锁内备份 `.vN.bak` 后迁移为 v4，不支持新旧服务混用。

项目聊天调用 `open_tasklane({ projectDir, baseBranch? })`；全局看板调用 `open_tasklane({})`。
projectDir 必须是当前聊天工作区绝对路径；子目录/worktree 会归位主仓库并锁定 lockedBoardId。
不从插件目录推断项目。打开失败保留错误空态，不回退全局第一看板或浏览器。
无提交仓库可管理任务；基线需匹配当前未提交分支，默认 main。不能为打开看板自动首次提交。

插件声明 global/thread 入口和 fullscreen MCP Apps 资源。入口声明和工具成功都不证明
真实宿主已经正确显示、路由或执行。普通 `pnpm mcp` 只有业务工具，未注册面板资源；
独立浏览器仅用于明确要求的开发/验证，不作为原生执行兜底。

## 已连接 Codex 直接提交任务

MCP Apps SDK `1.7.4` 提供 getHostVersion、getHostCapabilities、sendMessage、openLink。
标准 hostCapabilities 只有 message/openLinks 等通道能力，没有 create_thread、目标线程
路由或 Stop 声明。sendMessage 不接受目标 threadId，只送面板关联聊天。

- 确认宿主明确为 Codex 时使用 Codex 文案；其他或未知环境使用 Agent，能力判断独立。
- UI 桥可返回通用名称；同时读取服务端 SDK MCP 握手的 `mcpClient`，识别
  `codex` / `codex-mcp-client`。这只是本地可信连接中的身份提示，不提供身份认证。
- 已识别 Codex、握手已连接且支持消息，即可选择工作方式并提交实际任务。
  不再要求能力声明或创建独立验证聊天，原生工具与工作区支持在该任务请求中核对。
- 投递成功提示“已投递，等待开始”；明确拒绝显示错误，超时或结果未知显示待确认。
  只有目标聊天真实回报 running/completed 才更新执行状态。
- 接收 Agent 用宿主工具核对自身真实 hostId/threadId，在认领时保存实际接收身份。
  当前会话只创建一次并把任务 ID 与执行要求原样分发后即结束，不等待创建结果；
  执行会话凭任务 ID 自行核验真实身份与工作区，通过 MCP 完成 created→bound 绑定、
  执行并回写 running/completed。旧 sess-* 和创建中的 clientThreadId 不冒充就绪线程。
- 刷新后从只读 `tasklane_host_info` 取得真实 MCP 客户端，`window.name` 仅缓存看板范围。
  不缓存执行权限，不从 URL、任务文字或旧绑定猜测当前宿主。
- 声明是功能验证记录，不是身份认证；requestId、hostId、claimId 都只是关联字段。
- Stop 始终禁用，尚未验证可靠宿主中断接口，发停止消息和改派人工不是中断。

## 用户请求与真实执行

详情明确选择主仓库新聊天、独立 worktree 新聊天或原样复用旧工作区。
UI 先通过 MCP 记录请求，再 sendMessage 给关联接收 Agent；接收方重新读取任务和看板，
认领请求后调用实际原生聊天工具，保存 created 结果再 bound，目标聊天核对目录后报告
真实 running。继续、回复和重试复用已有绑定，完整回复不截断。

普通 task_assign 只改变负责人，不创建 sess-*、分支/worktree，也不启停 Agent。
task_move 只改业务阶段，投递/创建/Doing 不证明 running；执行更新必须走匹配真实绑定
和本轮 runId 的 task_execution_report。旧 sess-* 不转换成 threadId，不复制它冒充真实会话。

新独立 worktree 由 Codex 管理。旧 TaskLane 工作区必须完整复用；不支持复用时明确
提示，不能换到主仓库或另建目录。所有工具守卫归档、看板归属、认领、当前代次与绑定。
没有 CLI、App Server、后台进程、其他 Agent 或桌面私有接口兜底。

完整模型和五个执行工具见[原生执行契约](../docs/native-execution-contract.md)，实际
接收流程见[执行技能](plugin-src/skills/native-execution/SKILL.md)。

## 验收状态

主仓库原生 MCP 创建、绑定和真实开始/完成回执已由 TASK-102 实测，
见[原生执行报告](../docs/acceptance/20261004-native-execution-e2e.md)。
本轮直接提交流程的 UI 按钮、旧工作区复用和深链接仍需分别验收；
源码构建和已有原生测试不替代新界面入口的实际投递。
