## [2026-10-04 15:00 +0800] | 任务：精简看板卡片为同行执行方与状态 tag

### 执行上下文

- **Agent ID**：`ZCode`
- **Base Model**：`new-provider/gpt-6.1-sol`
- **Runtime**：ZCode Desktop；macOS darwin 25.6.0 arm64；React/TypeScript/Vite
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`，尚无首次提交，没有可用 HEAD 统计基线
- **关联计划**：无，本次为限定卡片 UI 精简，不改变核心和执行契约

### 用户诉求

> 看板卡片去掉“在 Agent 中执行”和下面的执行不可用说明；“未绑定聊天”用 tag 与 Agent/Human 同行。补充要求：打开 Agent 会话也不在看板显示。

### 变更概览

**影响范围**：TaskCard、卡片 tag 样式、双语紧凑状态文案、UI 回归及插件版本。

- 卡片去除 Run/继续执行、打开 Agent/Codex 会话和下方宿主不可用说明，减少多任务看板的卡片高度。
- 把独立执行状态行合入 Agent/人工同行的状态 tag。“未绑定聊天”保留原意思，其余状态提供短文案：请求中、待确认、运行中、等待输入、失败、完成。
- 复用中性/运行/等待/失败/完成 tag 色系；同行不换行、窄宽状态 tag 超出时省略，完整状态保留在 title。
- 保留 ID、优先级、标题、可选分支/diff、Done 归档、卡片点击进入详情及拖拽语义。
- 详情中的执行入口与已绑定打开会话按钮不改；生成标识、宿主识别、绑定和执行回执逻辑均不处理。
- 现有 TaskLane 插件 App/服务/manifest/市场同步 0.3.8，自包含包通过既有构建流程生成，未安装或发布。

### 设计动机

看板用于快速扫读，卡片不需要重复详情的执行与聊天控制面板。将执行方和状态压缩成
一行 tag，能在保留状态信息的同时减少卡片垂直占用。长状态保留 tooltip，详细错误和
运行/打开操作仍在详情中，不以布局变化伪造执行能力或改变任务数据。

### 验证结果

| 检查 | 最终结果 |
| --- | --- |
| `pnpm --filter @tasklane/ui typecheck` | 通过 |
| `node --test ui/test/*.test.mjs` | **34/34 通过**，0 失败 |
| `pnpm build:ui` | 通过 |
| `pnpm build:plugin` | 通过，含 core/MCP 构建与 widget 打包 |
| `pnpm verify:plugin` | 通过 |
| `git diff --check` | 通过 |
| manifest、市场、App 和服务版本 | 0.3.8 一致 |

新增组件渲染回归遍历 human/agent、八种聊天/执行状态和连接/断连，确认同一 exec 行
恰有执行方与状态两个 tag，没有独立 native-state、native-reason 或 Run/继续/打开会话
入口。调整既有测试：卡片所有连接状态都不提供 Run/继续；真实绑定打开会话的回归
仅针对详情，仍验证无绑定和占位 threadId 不显示。详情原有行为保持通过。

用户在本轮实施中补充“不显示打开会话”，已执行最终删除并重新完整运行上述验证，
不是只验证最初版本。自动化检查每项独立硬超时 60 秒，无超时。遵循现有原生计划
不继续模拟浏览器验收的约束，未启动浏览器模拟或真实 Agent，静态组件渲染不宣称为
原生 Codex 视觉实测。本次没有业务契约改动，不重复全库业务测试。

### 变更统计

- **统计口径**：任务开始前保存文件快照，通过 `git diff --no-index --shortstat` 与
  `--numstat` 逐文件比较；返回 1 为存在差异而非错误。
- **排除范围**：历史记录自身、生成插件 bundle、其它会话的删除/模型/主题改动不纳入。
  本次仅在既有样式加两行，没有全文件格式化；详情源码未修改。
- **变更文件数（源码/测试/配置/说明）**：11
- **新增行数**：+76
- **删除行数**：−37

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/components/TaskCard.tsx` | 17 | 23 |
| `ui/src/styles.css` | 2 | 0 |
| `ui/src/i18n/nativeMessages.ts` | 16 | 0 |
| `ui/test/task-detail-controls.test.mjs` | 33 | 6 |
| `ui/test/native-execution.test.mjs`（仅版本断言） | 1 | 1 |
| `ui/src/mcp/appsClient.ts`（仅版本） | 1 | 1 |
| `ui/README.md` | 2 | 2 |
| `extension/src/plugin-server.mjs`（仅版本） | 1 | 1 |
| `extension/plugin-src/plugin.json`（仅版本） | 1 | 1 |
| `extension/plugin-src/.codex-plugin/plugin.json`（仅版本） | 1 | 1 |
| `.claude-plugin/marketplace.json`（仅版本） | 1 | 1 |

### 修改文件

上表 11 个文件及本历史记录，构建生成的 `plugins/tasklane/` server、widget 与两份
manifest 同步，产物未手改。未 git add/commit/push，未操作真实看板、工作区或聊天。

### 后续事项

源包已更新为 0.3.8，用户已安装插件和运行中面板更新状态未确认；需加载新版本才能
看到紧凑卡片。实际 Codex 页面显示和深链接操作不由本次构建与渲染测试证明。
