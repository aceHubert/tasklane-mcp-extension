## [2026-10-03 18:05 +0800] | 任务：通过 MCP 打开原生看板面板

### 执行上下文

- **Agent ID**：Codex 主代理及文档、审查子代理
- **Base Model**：未知
- **Runtime**：Codex desktop，本地 macOS 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（尚无有效 HEAD）
- **关联计划**：无；本次为既有插件打开契约及配套指导的集中修改。

### 用户诉求

> 参考 Cowart，在当前项目的会话中使用 MCP 工具打开 TaskLane 原生应用面板，
> 默认不使用浏览器 URL。

### 变更概览

**影响范围**：插件资源与入口、MCP Apps 客户端、插件打包、冒烟验证及使用文档。

- 资源与客户端统一声明 `fullscreen`；打开工具声明 `global`、`thread` 入口。
- 资源改为 `ui://widget/tasklane/board-panel.html`，避免旧 inline 页面缓存。
- 工具描述、服务说明及新增打开技能明确项目会话传 `projectDir`，打开失败报告
  原因，不自动启动 bridge、打开网页、切换全局看板或创建 Git 提交。
- 错误结果保留 UI 模板关联，供宿主呈现既有项目错误态；业务层 Git 注册规则不变。
- Codex 插件清单声明技能目录，打包复制技能并重新生成自包含插件。
- 构建不再删除整个插件目录，保留其中其他文件，仅覆盖明确产物。
- 文档将原生 MCP 面板作为默认入口，浏览器方式作为显式开发路径；普通 stdio
  服务只有业务工具，不能替代插件 UI 服务。
- 修正 stdio 冒烟过时的工具数量断言，验证 9 个业务工具且没有原生打开入口。

### 设计动机

引用聊天此前已调用项目 MCP 打开工具，但仓库没有提交导致注册失败；随后按当时
明确的浏览器请求打开了独立页面。显示模式调整不能修复 Git 注册条件，因此本次
保留明确项目错误，补齐入口指导、错误资源关联和协议验证，避免误报项目打开成功。

`fullscreen` 为应用显示模式，面板位置由宿主决定。线程入口不会保证宿主自动
补充工作区，项目会话仍须显式传参。入口注册依据 OpenAI 官方 Extensions 文档：
[Sidebar apps](https://developers.openai.com/plugins/build/extensions#sidebar-apps)。

### 验证结果

- `pnpm test`：通过，含 core/mcp 构建，45 项单元测试通过。
- `pnpm --filter @tasklane/ui typecheck`：通过。
- `pnpm build:plugin`：通过，重新构建插件服务、单文件 UI、清单及打开技能。
- `pnpm build:ui`：通过。
- `pnpm verify:plugin`：通过，覆盖 10 个插件工具、全局/线程入口、UI 模板、
  fullscreen 资源、项目自动注册/幂等、错误态、技能打包及业务工具共享数据。
- 新增无提交临时仓库验证：项目失败仍带原生模板，不注册其他看板、不创建提交。
- `pnpm smoke`：初次发现既有数量断言仍为 8；修正为实际 9 个业务工具后复验通过。
- 修改的 JavaScript 语法检查及 `git diff --check`：通过。
- 独立只读审查：未发现本次入口注册或技能打包缺陷；发现未修改的
  `BoardContext.tsx` 既有错误分支没有保留具体 `ctx.error`，面板显示通用原因列表。
  工具结果仍包含具体错误，Agent 应据此说明失败原因；面板细化错误内容未纳入本次修改。
- 自动化命令均使用 60 秒进程组硬超时；测试使用临时数据目录和临时 Git 仓库。
- 独立浏览器交互：本次未执行；未修改界面布局或业务交互。
- Codex 原生宿主显示、全局/线程入口点击、重连及错误面板渲染：未执行，须宿主
  重新加载构建后的插件再验收。协议通过不等于宿主实际显示通过。

### 变更统计

- **统计口径**：仓库无有效 HEAD；已有文件与修改前快照逐文件执行
  `git diff --no-index --shortstat` 和 `--numstat`，新增技能与 `/dev/null` 对比。
  包含本次重新生成的插件文件，排除任务前已有修改、设计资产、dist 缓存及本历史。
- **变更文件数**：17
- **新增行数**：+248
- **删除行数**：-115

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `README.md` | 30 | 11 |
| `WORKFLOW.md` | 43 | 24 |
| `extension/README.md` | 26 | 13 |
| `extension/src/widget.mjs` | 12 | 7 |
| `extension/src/plugin-server.mjs` | 6 | 3 |
| `ui/src/mcp/appsClient.ts` | 3 | 3 |
| `scripts/build-plugin.mjs` | 8 | 2 |
| `scripts/verify-plugin.mjs` | 42 | 8 |
| `scripts/smoke.mjs` | 3 | 3 |
| `extension/plugin-src/.codex-plugin/plugin.json` | 7 | 4 |
| `extension/plugin-src/plugin.json` | 6 | 4 |
| `extension/plugin-src/skills/open-tasklane/SKILL.md` | 12 | 0 |
| `plugins/tasklane/server.mjs` | 23 | 23 |
| `plugins/tasklane/kanban-widget.html` | 2 | 2 |
| `plugins/tasklane/plugin.json` | 6 | 4 |
| `plugins/tasklane/.codex-plugin/plugin.json` | 7 | 4 |
| `plugins/tasklane/skills/open-tasklane/SKILL.md` | 12 | 0 |

### 修改文件

见上述逐文件统计；插件产物由构建生成，未手改。

### 后续事项

- Codex 重新加载插件后，验收原生入口和真实面板显示；现有宿主执行桥仍需独立验收。
- 原生打开直接依赖 MCP 工具与资源关联；技能是可选的调用流程指导，用户询问后已明确
  这一边界，不能把工具失败归因于缺少技能。
- 当前项目仓库没有提交，项目注册仍会报错；本任务没有执行 Git 提交、修改真实看板
  或安装路径中的插件配置。
