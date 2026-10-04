## [2026-10-04 01:08 +0800] | 任务：将原生执行技能改为英文

### 执行上下文

- **Agent ID**：Codex
- **Base Model**：未知
- **Runtime**：Codex desktop，本地 macOS 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（尚无有效 HEAD，仓库全部改动处于暂存/未跟踪状态）
- **关联计划**：`docs/exec-plans/completed/codex-native-execution-bridge.md`

### 用户诉求

> 把 tasklane-native-execution skills 内容英文。

### 变更概览

**影响范围**：`extension/plugin-src/skills/`、`plugins/tasklane/skills/`、`scripts/`。

- **技能翻译**：`tasklane-native-execution/SKILL.md` 的 frontmatter `description` 与
  全部正文（安全边界、面板能力验证、认领与创建、继续/回复/重试、目标聊天执行与回报、
  打开聊天及验收）改为英文；技能名、MCP 工具名、参数与 JSON 声明结构保持原样。
- **同步插件包**：源文件逐字节复制到 `plugins/tasklane/skills/`，并同步本机插件缓存副本。
- **校验断言跟随**：`verify-plugin.mjs` 原本断言中文原文 `没有可靠中断接口`，
  改为英文技能中对应的 `no reliable interrupt interface`。

### 设计动机

技能是给宿主 Agent 读的操作性指令，与已英文化的 `open-tasklane` 技能保持一致语言。
翻译只做等义改写，不调整任何流程顺序、门控条件或禁止兜底约束，避免语义漂移；
验证脚本的硬编码字符串随之更新，否则插件冒烟会因文案语言变化而误报失败。

### 验证结果

- `rg '[\u4e00-\u9fff]' extension/plugin-src/skills/tasklane-native-execution/SKILL.md`：无匹配，正文已无中文。
- `cmp` 源文件与 `plugins/tasklane/skills/`、插件缓存副本：逐字节一致。
- `node scripts/verify-plugin.mjs`：ALL PASS（含“插件打包原生执行技能及禁止兜底约束”）。
- `git diff --check`：通过。
- core/mcp 单元测试与 UI 构建：未执行；本次仅改技能文本与冒烟断言字符串。
- Codex 原生宿主内的连接验证与真实执行路由：未验收，沿用前一任务记录的待办。

### 变更统计

- **统计口径**：两份 SKILL.md 均为未跟踪文件，与任务前原文快照逐文件执行
  `git diff --no-index --numstat`；`scripts/verify-plugin.mjs` 用 `git diff` 仅取本次改动的断言行，
  排除该文件中他人未提交的既有改动与本历史记录自身。
- **变更文件数**：3
- **新增行数**：+227
- **删除行数**：-225

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `extension/plugin-src/skills/tasklane-native-execution/SKILL.md` | 113 | 112 |
| `plugins/tasklane/skills/tasklane-native-execution/SKILL.md` | 113 | 112 |
| `scripts/verify-plugin.mjs` | 1 | 1 |

> 说明：两份 SKILL.md 任务前与中文原文逐字节相同、任务后与英文译稿逐字节相同，
> 因此各自相对同一基线的 `--no-index` 统计都是 113/112；整篇重写使 frontmatter 与正文段落计为成对增删。
> 本机插件缓存副本也已同步为英文，但不在仓库统计口径内。

### 修改文件

- `extension/plugin-src/skills/tasklane-native-execution/SKILL.md`
- `plugins/tasklane/skills/tasklane-native-execution/SKILL.md`
- `scripts/verify-plugin.mjs`

### 后续事项

- 宿主需重新加载更新后的插件包才能读到英文技能；本机缓存副本已手工同步，正式分发以仓库构建产物为准。
- `ui/src/state/nativeExecution.ts` 与 `ui/src/mcp/appsClient.ts` 向目标聊天发送的指令文案仍为中文，
  属 UI 侧产品文案，本任务未触及；如需与技能统一语言，另开任务处理。
- Codex 原生宿主验收事项沿用 `docs/exec-plans/completed/codex-native-execution-bridge.md`。
