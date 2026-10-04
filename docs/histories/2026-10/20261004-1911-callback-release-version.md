## [2026-10-04 19:11 +0800] | 任务：区分回传修复包与旧安装缓存

### 执行上下文

- **Agent ID**：Codex
- **Base Model**：未知
- **Runtime**：Codex Desktop 本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[准备回传计划（已取消）](../../exec-plans/completed/ready-callback.md)

### 用户诉求与发现

用户反馈新验收聊天仍阻塞，并怀疑没有使用 worktree。只读核对发现实际原生创建传入 worktree 模式，Git worktree 清单和独立 git-dir 证明工作区已隔离，处于 detached HEAD。
实际创建提示仍没有 callbackThreadId/send_message_to_thread 要求；已安装 0.3.9 技能不含回传协议，而仓库源码及构建包包含。此前只重新构建同版本包，没有更新安装缓存，不能把打包成功视为用户运行环境已更新。

### 变更

- 将市场目录、两种插件清单、MCP 服务与 UI appInfo 同步升级 0.3.10。
- 面板资源 URI 改为 board-panel-v0310.html，避免复用旧资源缓存。
- 插件验证核对市场/插件/实际服务版本一致，并检查面板与技能均包含主动回传协议。
- 同步版本测试和 extension 文档；生成产物由 build:plugin 重建。

### 验证与边界

- UI typecheck、47 项 UI 测试、build:plugin、verify:plugin 通过；命令硬超时 60 秒。
- 只读确认现有 worktree，不更改分支、工作区、任务或会话，不发送执行消息。
- 未提交、未发布远端、未覆盖已安装缓存。需加载本地新包并重新打开面板/使用加载新版技能的接收聊天，再验收真实回传。

### 统计

相对本轮快照，使用 git diff --no-index --shortstat/--numstat；排除构建产物、他人已有改动及本记录。
9 个源文件，新增 14 行、删除 9 行。8 个版本/URI/文档/测试文件各 +1/-1，verify-plugin.mjs +6/-1。

### 后续事项

确认实际加载版本为 0.3.10，而非只确认仓库磁盘版本；真实新聊天准备提示必须含 callbackThreadId 和主动回传要求。
