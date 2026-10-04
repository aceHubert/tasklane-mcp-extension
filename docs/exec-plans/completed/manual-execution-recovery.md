# 会话状态核对与等待恢复

- 状态：已完成（原生面板人工验收通过）
- 创建日期：2026-10-04
- 最后更新：2026-10-04
- 负责人：ZCode 原实现；Codex 接续核心与技能，UI/回归按文件并行
- 关联历史记录：[接续实现记录](../../histories/2026-10/20261004-1741-session-status-check.md)

## 目标

接续指定 ZCode 会话的最后决定：通过消息核对会话，再更新真实回执，不由按钮直接重置。详情增加“核对会话状态”，运行中、等待及终态有疑问时也可核对。

## 范围与边界

- 复用 task_execution_recovery_request/recover，增加可选 purpose=status/recovery；默认 recovery 保留旧协议。
- UI 按钮固定 purpose=status，发送一次关联 checkId 的宿主消息；不继续正文、不调用 start/continue/retry、不创建聊天或工作区。
- 不操作真实任务、不自动纠正既有终态，不以 idle 推导 completed。
- 保留本聊天前序实现的 blocked、真实会话保存以及首次 running 同步 Ready→Doing。

## 核对契约

task_execution_recovery_request 输入 id/boardId/requestId/runId/checkId/purpose?，持久 recoveryCheck 的用途与观察快照。
status 允许当前非归档、非 cancelled 请求，包括 running/waiting/completed/failed/rejected。
同 checkId 不得换用途；同用途未超时 pending（60 秒）合并，异用途 pending 返回 EXECUTION_BUSY，不覆盖已投递核对。

task_execution_recover 使用已保存用途，不相信调用者切换用途。状态检查仅记录 busy/unknown/resumed 审计和新鲜线程观测，严禁 stopped，因此不会清除原请求锁、绑定、工作区或执行状态。
核对期间目标正常上报 running→completed，不妨碍同 run 的状态审计；换 run、换 check、过期观测、错宿主或归档仍拒绝。
目标可在读取真实工作证据后补 task_execution_report，仍遵守已绑定、真实开始和终态不可回退规则。发现终态矛盾只报告 unknown，不伪造回执。
普通 recovery 仍仅允许原 AWAITING 状态，stopped 保留原确认、快照 CAS、完整相关线程状态与活跃核对者例外守卫；UI 新按钮不走此路径。

## UI 与提示词

- 当前原生请求存在且未 cancelled 时显示按钮；断连/不支持消息/归档禁用。
- 核对消息要求读取真实已知 threadId；列表遗漏不等于不存在。
- 目标活跃时不重复投递；目标空闲且可能漏回执时，可向同一真实目标发送仅核对补回执消息，禁止恢复正文。
- 终态只核对审计；核对消息引起的活跃不当作原任务运行。
- 结束前 task_get 验证持久化结果；失败和 unknown 明确显示。

## 并行边界与验证

主代理负责 core 类型/存储/逻辑、MCP schema、技能和文档；UI 代理只改 UI；测试代理只写新增 core/MCP 测试。
检查类型、目的隔离、幂等、正常回执竞争、旧运行/跨板守卫、终态只读、无消息能力零写入和按钮渲染。
所有自动化命令独立硬超时 60 秒；集成使用临时目录和仓库，不改用户真实看板。
需要 build/test/smoke/verify:twoproc、UI typecheck/tests/build、插件 build/verify。浏览器真实验收与组件测试分开记录。

## 风险、兼容与回滚

v4 增加可选 purpose；旧记录缺省按 recovery 处理，status 的 observedStatus 放宽但禁止 recovered。新插件需整体加载，不能假设旧进程能处理新用途。
宿主核对身份不是认证；保留现有本地可信通道边界。撤回代码不清理看板审计、原聊天或 worktree。

## 进度

- [x] catchup 读取指定 ZCode 会话，核对实际已落盘实现。
- [x] 区分状态核对与解除等待，完成核心/MCP/技能实现。
- [x] 完成 UI、回归、构建与插件验证。
- [x] 更新历史记录。
- [x] 实际原生面板验收完成后归档计划：2026-10-04 用户在原生 Codex 面板完成人工验收并确认通过，计划归档（自动化验证结果见下方「实际结果」）。

## 实际结果

- core/MCP 构建与 259 项测试通过；UI typecheck、45 项测试、UI 构建通过。
- smoke、verify:twoproc、build:plugin、verify:plugin 均通过；每个自动化命令硬超时 60 秒。
- 内置 Chrome 本轮仍报 Unable to load browser request-header policy，未做真实面板验收；已记录技术债，不将组件测试或按钮发送成功视为目标已回写。
- 已重建仓库插件包，未覆盖已安装缓存、未修改用户真实任务；新版插件加载后再验收原生消息路由。
- 保留接续过程中已有 blocked、Ready→Doing 和其它任务的 UI 改动，针对当前实现更新陈旧渲染断言。
