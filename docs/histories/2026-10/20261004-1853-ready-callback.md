## [2026-10-04 18:53 +0800] | 任务：明确准备结果主动回传

### 执行上下文

- **Agent ID**：Codex 主代理及并行回归测试代理
- **Base Model**：未知
- **Runtime**：Codex Desktop 本地工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main
- **关联计划**：[回传计划（已取消）](../../exec-plans/completed/ready-callback.md)

### 用户诉求

> 修改代码明确使用回传，解决目标已输出准备结果但发起会话未收到的问题。

### 变更概览与设计动机

- UI 新建提示要求认领后从 request.receiver 获取真实 callbackThreadId/callbackHostId，写入目标初始提示。
- 目标使用执行技能并核对用户授权后，必须调用 send_message_to_thread 回传 SESSION_READY 或 SESSION_BLOCKED，不能仅在自身 final 输出；发送未知时不盲目重发。
- 发起方读取真实聊天和当前任务关联核验后再 created→bound；旧轮与重复回传不可重建或重复正文。复用旧请求的 continue/retry/reply 不重新走新准备流程。
- branch 使用 git rev-parse --abbrev-ref HEAD；detached 时为 HEAD，提交 SHA 单独放 commit，不传给绑定接口的 branch。
- 更新技能、协议与提示词回归。插件验证清单补齐并行新增的 task_export，不修改该工具实现。
- 不变更存储结构，不修改用户看板、不发送真实聊天消息、不恢复 TASK-113；回滚不删除聊天和工作区。

### 验证结果

- UI 全部 47 项测试通过；UI 类型检查通过。
- build:plugin（含 core/MCP 与 UI 构建）、verify:plugin 通过。
- 每条自动化命令设置 60 秒硬超时，git diff --check 通过。
- 仓库插件包与技能已同步；未修改已安装缓存、未提交。加载新包后仍需新任务的真实回传验收，已登记技术债。

### 变更统计

- **统计口径**：任务前快照的 git diff --no-index --shortstat/--numstat；新增计划相对 /dev/null。排除其他任务改动、构建产物和本记录。
- **变更文件数**：7
- **新增行数**：+109
- **删除行数**：-5

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| ui/src/state/nativeExecution.ts | 5 | 1 |
| ui/test/native-execution.test.mjs | 54 | 0 |
| extension/plugin-src/skills/tasklane-native-execution/SKILL.md | 17 | 4 |
| docs/native-execution-contract.md | 2 | 0 |
| scripts/verify-plugin.mjs | 1 | 0 |
| docs/exec-plans/tech-debt-tracker.md | 1 | 0 |
| docs/exec-plans/active/ready-callback.md | 29 | 0 |

### 后续事项

真实宿主回传、收信后单次绑定和正文投递尚未验收，不将生成提示词测试视为端到端成功。
