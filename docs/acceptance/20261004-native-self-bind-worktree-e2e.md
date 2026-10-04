# Codex 原生自绑定执行验收（2026-10-04）

## 结论

新协议（分发任务 ID、目标聊天自行绑定与回报，插件 0.3.14）在真实 Codex 宿主连续两次
验收通过。用户在原生面板任务详情选择「独立 worktree」并点击「执行」发起；派发聊天仅
一次 `create_thread` 原样分发任务 ID 与执行要求后即结束，不等待创建结果、不保存绑定；
目标聊天凭任务 ID 自行核验真实身份与独立 worktree，以同一真实结果完成 created→bound，
真实 running 回执自动驱动 Ready→Doing，完成后自行报告 completed。

## 任务与关联

| 字段 | TASK-117 | TASK-118 |
| --- | --- | --- |
| 标题 | 验收 worktree 任务聊天自行绑定与执行回报 | 查询杭州下周末天气（10月10日—11日） |
| boardId | `board-88568f0a`（codex-cliproxy） | 同左 |
| requestId | `request-f2ee8a3c-861a-4f5c-b53a-9f0801e19702` | `request-3bbaf05d-ceca-4e60-98af-b55f4d372f68` |
| runId | `run-d90655a1-c7d4-4f03-804e-c2fffe02e456` | `run-06d6eb29-c1c7-4e81-9088-113ce3a7d6be` |
| workspaceMode | `worktree` | `worktree` |
| 请求状态 | completed | completed |
| 派发聊天（receiver） | `01a105bd-039d-7643-a4f8-078267511971` | 同左 |
| 目标聊天（自绑定） | `01a1072f-1c82-7110-b107-1709347c45b0` | `01a10735-dbd2-7633-81cc-16b072cca87a` |
| 工作区 | `~/.codex/worktrees/7098/codex-cliproxy` | `~/.codex/worktrees/3885/codex-cliproxy` |
| provider / hostId | `codex-desktop` / `local` | 同左 |

## TASK-117 五项验收

1. 入口本轮仅一次原样创建后结束（无 wait_threads/read_thread、无二次分发、无重复创建）。
2. 目标聊天自行核验真实 threadId/hostId、实际目录与独立 worktree，branch=HEAD（detached 如实记录），
   同一真实结果 created→bound。
3. 真实 running 回执写入后核心自动将 Ready 移至 Doing（未调用 task_move 完成该移动）。
4. 只读检查 README、package.json 与 `git status --short` 通过；工作区独立于主仓库且
   common-dir 属于 codex-cliproxy；全程未修改、安装、提交或清理。
5. 完成回执（completed）已写入并持久化，任务业务状态由目标自行流转 review；
   最终 `task_get` 复核绑定与回执留存。

## TASK-118 复验

同协议真实联网任务：目标聊天 `01a10735` 在独立 worktree `3885` 自绑定并回报
running→completed，返回杭州 2026-10-10/11 天气查询结果（中国天气网 7 天预报）。
证明 117 非一次性巧合，协议可承载用户自然任务。

## 范围与未覆盖项

- 本轮覆盖：UI 按钮发起、独立 worktree（新建）工作方式、目标自绑定、真实回执、
  Ready→Doing 自动移列、请求合并与唯一创建。
- 仍未取证（转技术债）：旧工作区复用（existing）、widget 深链接（openThread）、
  全局入口消息路由、可靠停止接口。
- 证据留存：任务数据（含 executionRequests/executionBinding/reports）在本地看板
  `~/.tasklane/board.json`（TASK-117/118 已归档，`task_get` 仍可读取）。
