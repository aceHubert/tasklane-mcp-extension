# Codex 主仓库原生执行验收（2026-10-04）

## 结论

`TASK-102` 在真实 Codex 主仓库聊天中完成只读执行。MCP 请求、唯一认领、原生聊天创建、
两阶段绑定、真实开始与完成回执、Done 流转已走通。此次由 Agent 通过原生 MCP 发起，
没有点击 UI 执行按钮，不能将结果扩展为 UI 消息投递入口也已验收。

## 范围与授权

- 用户明确请求“创建一个测试可执行的走完全流程”。
- 在 `codex-cliproxy` 看板创建唯一只读测试任务，主仓库工作方式；旧 `TASK-101` 不变。
- 唯一新增任务聊天，不创建 worktree，不安装依赖，不修改项目文件，不提交或切换分支。
- 接收聊天读取源聊天中的直接人类授权，再向目标聊天发送准备和执行指令。
- 版本：TaskLane 0.3.2；实际 UI 桥 `chatgpt / 26.930.31730`，MCP 客户端
  `codex-mcp-client / 0.160.0`；这些是功能验证关联信息，不是认证。

## 实际关联

| 字段 | 实际结果 |
| --- | --- |
| taskId / boardId | `TASK-102` / `board-88568f0a` |
| 接收聊天 | `01a10293-ad81-79d0-aec6-3acc816161aa` |
| 目标聊天 | `01a10508-902c-7cd3-b0c8-c7bec9829b1a`，标题 `TASK-102 原生只读测试` |
| hostId | `local` |
| 工作方式 | `project`；`workspaceOwner=user` |
| 实际目录 / Git 根 | `/Users/hubert/Desktop/projects/codex-cliproxy` |
| 实际分支 | `main` |
| requestId | `tasklane-task102-start-1791085782375-83c31e8231cd1` |
| runId | `run-e93591ea-ed52-416e-8639-bfd93c98f26f` |

## 持久化与真实命令证据

下列时间均为北京时间（+0800），经 `task_get` 的时间线与目标聊天工具记录交叉核对：

| 时间 | 实际事件 |
| --- | --- |
| 11:48:09 | 创建测试任务，backlog |
| 11:48:49–11:48:52 | 指派 agent，backlog → ready；尚未执行 |
| 11:49:46–11:49:54 | start 请求及唯一 claim 保存 |
| 11:52:59 | `phase=created` 保存实际原生结果 |
| 11:53:08 | `phase=bound` 使用完全相同的线程、目录和分支 |
| 11:54:53 | 目标聊天报告真实 `running`，产生 `startedAt` |
| 11:55:23 | 目标聊天报告真实 `completed` |
| 11:55:58–11:56:22 | 接收端依次 ready → doing → review → done |

任务业务阶段与执行状态分别推进；阶段流转晚于实际执行回执，不用阶段证明已执行。

目标实际执行了 `pwd`、`git rev-parse --show-toplevel`、`git branch --show-current`、
`GIT_OPTIONAL_LOCKS=0 git status --short`，均成功。目录、Git 根与真实绑定一致，分支为 main。
工作区已有 51 项变更；本轮仅执行只读核对，没有文件写入命令。

两个真实回执属于同一任务、请求、运行代次与绑定：

- `run-e93591ea-ed52-416e-8639-bfd93c98f26f-running-1`
- `run-e93591ea-ed52-416e-8639-bfd93c98f26f-completed-1`

最终独立 `task_get` 核验：`task.status=done`、`execution.state=completed`、
请求状态 completed，真实绑定保留。没有使用 `task_update.execution` 伪造状态。

## 异常与恢复

首次创建的准备轮次在任何命令前遇到宿主错误：`function_call_output.call_id 必须是字符串`。
接收端复用了同一真实聊天，发送一次只读准备恢复消息，随后目录和身份核对成功。
聊天列举失败时通过宿主读取记录确认身份；未猜测标识，也未创建第二个聊天。

## 能力声明与未覆盖项

- 实际创建和消息往返成功后，接收端在 11:53:22 返回新声明：
  `createThread=true`、`sendToThread=true`、`project=true`。
- `openThread`、`worktree`、`existing` 保持 false；旧任务工作区复用未验证。
- 新声明对应的最新卡片尚未展开，接收端只能读取上一轮面板，因此本轮的最新声明
  显示状态仍待验收。前一轮已在真实面板确认“声明已提供”，但当时 createThread=false。
- UI 按钮发起、回复/继续/重试、独立工作区、旧工作区复用、深链接与 Stop 均未在本轮验证。
- 声明最长 10 分钟，刷新、断连或执行上下文变化后仍须复验；测试完成不授予永久能力。
- 完整桥接计划仍保留 active，后续各入口必须单独取证。
