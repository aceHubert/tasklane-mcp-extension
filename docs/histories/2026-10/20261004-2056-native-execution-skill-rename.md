## [2026-10-04 20:56 +0800] | 任务：重命名执行技能为 native-execution 并全英文化

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`account:zai-individual-coding-plan/GLM-5.3`
- **Runtime**：`ZCode Desktop（macOS darwin 25.6.0 arm64）`
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：`main`（unborn HEAD，仓库尚无提交，改动均在工作区）
- **关联计划**：[docs/exec-plans/completed/task-id-direct-execution.md](../../exec-plans/completed/task-id-direct-execution.md)

### 用户诉求

> 把 tasklane-native-execution 修改为 native-execution，文件名也修改。调用的地方写成「使用 tasklane native-execution」的写法。内容还是中英混杂的，全部使用英文。

### 变更概览

**影响范围**：`extension/plugin-src/skills/`、`extension/src/`、`ui/src/`、`ui/test/`、`scripts/`、`plugins/tasklane/`（构建产物）、`README.md`、`WORKFLOW.md`。

**主要操作**：

- **技能重命名**：`skills/tasklane-native-execution/` → `skills/native-execution/`（源与产物），frontmatter `name` 同步改为 `native-execution`；`scripts/build-plugin.mjs` 技能清单同步。
- **技能全英文化**：SKILL.md 全文中译英（160 行，含入口授权、认领、创建任务会话、执行指定任务、续接、回执与深链接各节），语义与既有规范逐条对应；校验无中文字符残留。create_thread 初始 prompt 模板以英文呈现，并注明以面板消息内嵌的原文为准（原样使用）。
- **调用点统一写法**：面板提示词改为「请使用 tasklane native-execution（的状态核对流程）」；MCP server instructions 改为 "follow the tasklane native-execution skill"；open-tasklane 技能、README/WORKFLOW/extension README 引用同步。
- **校验脚本适配**：verify-plugin 技能路径与内容断言（旧中文标记「执行指定任务」→ "Execute the designated task"）。
- **版本升级 0.3.12 → 0.3.13**（marketplace、两份 plugin.json、serverInfo、widget 资源 URI 缓存键 v0313、APP_VERSION、verify-plugin 校验、extension/README、UI 测试期望）。
- **重建与安装**：`pnpm build:plugin` 后手工删除产物中旧技能目录；`verify:plugin` ALL PASS；安装至 `~/.codex/plugins/cache/tasklane/tasklane/0.3.13/` 并逐文件 cmp 一致。

### 设计动机

技能名去掉插件前缀后，调用处以「tasklane native-execution」（插件名 + 技能名）引用，与 Codex 技能解析方式一致且消歧。技能内容统一英文，消除此前中英混杂导致的阅读与维护成本；面板发给宿主的中文提示词不受影响，create_thread 初始 prompt 仍以面板消息原文为准，避免技能内模板与实际投递文本漂移。回滚方式：还原上述源文件后重跑 `pnpm build:plugin` 并重装缓存。

### 验证结果

- 命令与结果：
  - `pnpm build:plugin`：成功（server 836KB、widget 717KB）。
  - `node --test ui/test/native-execution.test.mjs`：32/32 通过（版本期望同步 0.3.13）。
  - `node --test ui/test/*.mjs`：47 项中 43 通过；4 项失败为并行会话 TaskDetail「会话核对按钮」进行中改动，与本任务无关。
  - `node scripts/verify-plugin.mjs`：ALL PASS。
  - 安装核对：0.3.13 缓存与产物全部文件 cmp 一致；产物与缓存内旧技能名零残留、技能全文无中文、调用写法出现 2 处。
- 未覆盖场景：重启 Codex 后宿主按新技能名 `native-execution` 的实际加载与触发（含旧线程历史中的旧名引用是否仍能路由）。

### 变更统计

> unborn HEAD，按任务前快照与已知编辑计算；`git diff --no-index /dev/null` 统计新增文件。

- **统计口径**：源文件按逐处替换计数；旧技能 108 行删除、新技能 160 行新增；`plugins/tasklane/` 为重建产物，其中旧技能目录整体删除、新技能目录新增；排除历史记录自身。
- **变更文件数**：15（源）+ 构建产物
- **新增行数**：+182
- **删除行数**：−130

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `extension/plugin-src/skills/native-execution/SKILL.md`（新） | +160 | — |
| `extension/plugin-src/skills/tasklane-native-execution/SKILL.md`（删） | — | −108 |
| `ui/src/state/nativeExecution.ts`（2 处调用写法） | +2 | −2 |
| `ui/test/native-execution.test.mjs`（技能写法 + 版本期望） | +2 | −2 |
| `scripts/build-plugin.mjs` | +1 | −1 |
| `scripts/verify-plugin.mjs`（路径/断言/版本/URI） | +4 | −4 |
| `extension/src/plugin-server.mjs`（技能引用 + 版本） | +2 | −2 |
| `extension/src/widget.mjs`（URI v0313） | +1 | −1 |
| `extension/plugin-src/skills/open-tasklane/SKILL.md` | +1 | −1 |
| `ui/src/mcp/appsClient.ts`（APP_VERSION） | +1 | −1 |
| `README.md` / `WORKFLOW.md` / `extension/README.md` | +5 | −5 |
| `.claude-plugin/marketplace.json`、两份 `plugin.json` | +3 | −3 |
| `plugins/tasklane/`（重建产物 + 技能目录更名） | — | — |

### 修改文件

- `extension/plugin-src/skills/native-execution/SKILL.md`（新增，替代旧目录）
- `extension/plugin-src/skills/tasklane-native-execution/SKILL.md`（删除）
- `extension/plugin-src/skills/open-tasklane/SKILL.md`
- `extension/src/plugin-server.mjs`、`extension/src/widget.mjs`
- `ui/src/state/nativeExecution.ts`、`ui/src/mcp/appsClient.ts`
- `ui/test/native-execution.test.mjs`
- `scripts/build-plugin.mjs`、`scripts/verify-plugin.mjs`
- `README.md`、`WORKFLOW.md`、`extension/README.md`
- `.claude-plugin/marketplace.json`、`extension/plugin-src/plugin.json`、`extension/plugin-src/.codex-plugin/plugin.json`
- `plugins/tasklane/`（重建产物，含 `skills/native-execution/` 新增、`skills/tasklane-native-execution/` 删除）

### 后续事项

- 待用户重启 Codex 加载 0.3.13，验证新技能名的实际触发；旧执行线程历史中的 `tasklane-native-execution` 字样仅存在于历史消息，不再匹配新技能名，需要时按新名重新引用。
- 并行会话的 4 个 task-detail 测试失败（会话核对按钮）随 0.3.13 一并打包，归属并行任务收尾。
