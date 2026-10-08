## [2026-10-08 15:01 +0800] | 任务：统一分发失败后恢复状态并支持重新发起

### 执行上下文

- **Agent ID**：`codex`，collab 并行处理 UI、技能契约和独立审查。
- **Base Model**：`GPT-6`。
- **Runtime**：Codex Desktop，本地 Bash、Node.js、pnpm。
- **Git User**：`hubert <hubert@lejian.com>`。
- **Branch**：`main`。
- **关联计划**：[统一分发失败恢复计划](../../exec-plans/completed/dispatch-failure-retry.md)。

### 用户诉求

> 恢复不应仅限会话消息被审核拒绝，任何任务分发失败都应恢复为可以重新发起的状态。

### 变更概览

**影响范围**：核心请求/投递和严格存储校验、MCP 契约、UI 入口和分发指令、技能镜像及测试。

- 统一明确分发失败：宿主路由、创建、准备或绑定、所有执行动作的消息投递，在无本轮
  startedAt 或任意目标 reports 时结束请求为 rejected，解除启动等待并保留实际创建结果。
- 已知结果的失败请求通过新 runId、recoveryOf 和相同 result 重新发起，继承原模型/模式；
  有绑定时复用原聊天，无绑定时核验已保存结果，不重复创建工作区或聊天。
- 首轮 Review pending 即使已经保存 reviewBinding，明确分发失败后也开放恢复 start；
  复用原验收聊天，新的真实 running 才开验收轮，失败分发不创建虚假轮次。
- 面板请求响应丢失但尚未发送宿主消息时，读取本次 requestId 和当前 run 进行核对；
  未认领的本次 pending 请求可结束分发失败，核对失败或已认领则不擅自回退。
- 未认领恢复请求已继承 result 时，同样可以结束面板分发失败；存储必须核验合法来源。
  reply/retry 等恢复动作可以保留源模型；人工解除等待的既有模型和模式锁定规则保持。

### 设计动机

之前的恢复只覆盖已 bound 的续接审核拒绝，创建、准备或绑定阶段仍可能留下 starting。
本次按“分发明确失败且目标尚未接手”判定统一收尾，不依赖具体异常名称或绑定阶段。
原 claimId、当前 request/run 和任意目标回执仍是核心守卫；真实运行和已接手执行不能被
分发方回退，超时或结果未知继续核对，不能据此重复创建或投递。

严格存储校验允许准备失败的 rejected+result 和未认领的合法 recoveryOf 结果，并核验
来源目的、模式、模型与结果一致。字段和枚举不变，部署时仍须同步升级读写服务；
不清理旧结果或工作区，不单独回滚旧严格读取器，部署前保留数据备份。

### 验证结果

- `pnpm build`、`pnpm test`：最终 333 项全部通过。
- `pnpm smoke`：通过，临时数据目录及临时 Git 仓库。
- `pnpm verify:twoproc`：通过，临时目录双进程并发一致性验证。
- `node --test ui/test/*.test.mjs`：100 项全部通过。
- UI 类型检查、UI 构建：通过。
- 自动化命令均设置 60 秒硬超时，未超时。
- 回归覆盖 claimed/created/bound/blocked/uncertain 准备阶段明确失败、结果持久化重开、
  新请求复用模型和工作区、首轮验收恢复、回复/重试模型继承、未认领恢复请求再次失败，
  保留真实目标回执及原有人工取消守卫；MCP 复合工具覆盖创建后准备失败和恢复前发送失败。
- 独立审查指出模型继承、未认领恢复结果两项缺口，补齐实现和测试后复核通过。
- 两份技能一致，`git diff --check` 通过。
- 浏览器独立模式：临时模拟数据与真实 TaskDetail/host/dispatchNativeExecution，
  420px 窄栏和 1280px 宽抽屉均可在首轮 created/bound 失败后重新发起；模型锁定、打开
  旧验收聊天保留，实际点击产生一条恢复消息，完整 recoveryOf 和原结果保留，禁止 create_thread。
  uncertain 模式保留在途保护，没有重新创建入口。未连接真实看板或投递真实任务。
- 浏览器限制：内置 Chrome 连接失败后使用 ego-browser；一次自动审批服务 502 导致命令
  未执行，重试后完成。截图捕获超时；浏览器证据使用 DOM、实际点击、动作和消息记录。
- 未覆盖：原生宿主真实创建/绑定/投递失败复现、已安装插件更新与部署。

### 变更统计

- **统计口径**：逐文件对比本次修改前临时快照，执行 `git diff --no-index --shortstat`
  和 `git diff --no-index --numstat`；新计划与 `/dev/null` 对比。排除全部任务前既存
  暂存及未暂存变更、构建产物、临时浏览器模拟页及本历史记录。
- **变更文件数**：16。
- **新增行数**：+630。
- **删除行数**：-179。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `packages/core/src/native-execution.ts` | 47 | 24 |
| `packages/core/src/board-store.ts` | 8 | 6 |
| `packages/core/test/native-execution.test.ts` | 90 | 21 |
| `packages/core/test/review-flow.test.ts` | 42 | 0 |
| `mcp/test/review-contract.test.ts` | 35 | 0 |
| `mcp/src/register.ts` | 14 | 11 |
| `ui/src/host.ts` | 11 | 2 |
| `ui/src/state/nativeExecution.ts` | 41 | 18 |
| `ui/src/components/TaskDetail.tsx` | 10 | 7 |
| `ui/test/native-execution.test.mjs` | 92 | 14 |
| `ui/test/review-controls.test.mjs` | 33 | 0 |
| `ui/test/review-linked-continuation.test.mjs` | 18 | 0 |
| `extension/plugin-src/skills/native-execution/SKILL.md` | 48 | 32 |
| `plugins/tasklane/skills/native-execution/SKILL.md` | 48 | 32 |
| `docs/native-execution-contract.md` | 20 | 12 |
| `docs/exec-plans/completed/dispatch-failure-retry.md` | 73 | 0 |

### 修改文件

见上表，另新增本历史记录。保留他人的修改；未执行 git add、commit 或 push。

### 后续事项

部署时同步升级读写服务并验收原生宿主的各分发失败场景。未修改真实任务数据。
