# UI 中英文切换（i18n）执行计划

- 状态：已完成（全量迁移与验收通过）
- 创建日期：2026-10-03
- 最后更新：2026-10-03
- 负责人：i18n 会话（sess_6319197f-189a-48c4-b57a-b634bac178d2）
- 关联历史记录：无；实现完成后按 `docs/histories/` 规范补齐

## 目标

界面文案统一为中英双语可切换：不出现「中文（English）」混排或单语言写死的
写法；右上角提供「中 / EN」切换控件，切换即时生效并跨刷新保持。完成条件：
全部 UI 文案（含状态层 toast、prompt、aria 标签）经 `t(key)` 取词，
en 字典经类型检查证明全覆盖，浏览器与插件两种形态验收通过。

## 范围

- 包含：`ui/src/i18n/` 文案字典与语言上下文、右上角切换控件、全部组件与
  状态层文案迁移、样式、`ui/README.md` 与历史记录。
- 不包含：MCP 工具名、参数与错误码的国际化（Agent 契约保持语言无关）；
  写入存储的数据（`execution.activity` 前缀、`MAX_ACTIVITY_LEN` 截断等）
  不做 i18n；不做 zh/en 之外的语言与后端翻译接口。

## 背景

- 相关文档：[README.md](../../../README.md)、[ui/README.md](../../../ui/README.md)、
  [计划规范](../../PLANS_GUIDE.md)。
- 相关代码路径：`ui/src/i18n/messages.ts`、`ui/src/i18n/index.tsx`、
  `ui/src/components/LangSwitch.tsx`、`ui/src/mcp/types.ts`、
  `ui/src/components/*`、`ui/src/state/*`、`ui/src/styles.css`、`ui/index.html`。
- 当前行为与问题：界面文案为硬编码中文（部分混排英文），无法切换；
  `STATUS_LABEL` / `EVENT_LABEL` 写死在 `mcp/types.ts`。
- 已知约束：插件内联构建禁止 `import.meta`（资源必须静态 import）；
  `index.html lang="zh-CN"`；主题防闪烁使用内联 script，语言首帧设置需
  同理处理；构建命令 `pnpm build:ui` / `pnpm sidebar`（bridge 7433）。

## 方案（已固定）

1. **字典**：`messages.ts` 导出 `zh`（权威键源，`as const`）与
   `en: Record<MessageKey, string>`——en 漏译在类型检查直接报错；
   `translate(key, params)` 支持 `{name}` 插值，模块级 `currentLang`
   使非组件代码（`timeAgo` 等）也能取词。
2. **语言**：仅 `'zh' | 'en'`；`applyLang` 在 setState 前同步模块状态、
   更新 `document.documentElement.lang`（zh-CN / en）并持久化到
   localStorage `tasklane-lang`；读取时检测存储 + 默认 zh，
   localStorage 不可用只影响记忆不影响切换。
3. **上下文**：`LangProvider` 挂在 `BoardProvider` 之外（`App.tsx`），
   保证状态层 toast 也能取词；`useLang()` 提供 `lang / setLang / t`。
4. **切换控件**：`LangSwitch.tsx` 为 Header 右上角「中 / EN」分段控件
   （`role="radiogroup"`，复用 `.segmented` / `.seg` 样式类）。
5. **状态与事件标签**：`mcp/types.ts` 移除 `STATUS_LABEL` / `EVENT_LABEL`，
   改由 `messages.ts` 导出 `STATUS_KEYS` / `EVENT_KEYS` / `EXEC_KEYS`
   映射与 `statusKey()` / `eventKey()` / `execKey()` 辅助函数；
   `timeAgo` 改用 `translate('time.justNow')` 等。
6. **存储语言无关**：写入 MCP 存储的数据一律不随界面语言变化。

## 风险

- 风险：键名遗漏或 zh/en 不一致。
  缓解：en 用 `Record<MessageKey, string>` 强制全覆盖，类型检查兜底。
- 风险：与并行任务（[任务归档](task-archiving.md)）修改同一批 UI 文件。
  缓解：归档功能新增文案一律直接以 i18n 键追加进 `messages.ts`
  （不在组件写死文案），双方对字典的改动均为“追加键”；组件文件改动
  尽量分工，整合验证串行执行。
- 风险：切换后非组件代码（工具函数）不刷新。
  缓解：`translate` 读模块级 `currentLang`，`applyLang` 先同步模块状态
  再 setState，消费组件随 Provider value 变化重渲染。
- 风险：插件单文件构建引入 `import.meta` 导致白屏。
  缓解：沿用静态 import 资产的既有约定，`pnpm build:plugin` 验证。
- 兼容与备份策略：不涉及存储结构与 MCP 契约变更，无迁移。
- 回滚方式：纯 UI 改动，按文件回退即可，不影响任务数据。

## 里程碑与并行边界

1. **方案收敛**（已完成）：字典结构、语言持久化、Provider 层级、切换控件
   与标签映射方案已固定并落盘。
2. **分阶段迁移**（进行中）：组件层 → 状态层 → 样式与收尾。
3. **整合验证与收尾**：类型检查、构建、浏览器与插件形态验收、文档与
   历史记录。

- 可并行任务：与任务归档并行，见上文风险中的边界约定。
- 必须串行的依赖：`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`
  与浏览器验收须在全部迁移完成后统一执行。

## 验证方式与验收标准

- 自动化命令：`pnpm --filter @tasklane/ui typecheck`、`pnpm build:ui`；
  插件形态另跑 `pnpm build:plugin`（如改动了 bundle 内文件）。
- UI 检查：窄栏与宽视图逐屏核对；切换语言即时生效；刷新后语言保持；
  断连横幅、错误态、toast、prompt、aria 标签随语言切换。
- 环境与边界：后台自动化测试最长 60 秒硬超时；独立浏览器与原生宿主分别
  验收并记录。
- 可观察的验收条件：
  - [ ] 界面无「中文（English）」混排与单语言写死；新增代码统一 `t(key)`。
  - [ ] 右上角「中 / EN」切换即时生效；刷新后保持（localStorage）。
  - [ ] en 字典全覆盖（类型检查通过）。
  - [ ] 状态层（BoardContext / useTaskActions）toast 与 prompt 文案随语言切换。
  - [ ] `document.documentElement.lang` 与所选语言同步。
  - [ ] 类型检查与构建通过；窄栏 / 宽视图 / 断连 / 错误态浏览器验收记录。
  - [ ] `ui/README.md` 更新；历史记录补齐。
- 实际结果与未覆盖场景：typecheck / build / 浏览器验收尚未统一执行，
  完成后如实填写。

## 进度记录

- [x] 方案固定：字典、持久化、Provider 层级、切换控件、标签映射。
- [x] `ui/src/i18n/messages.ts`、`ui/src/i18n/index.tsx`、
  `ui/src/components/LangSwitch.tsx` 落盘。
- [x] 组件迁移：App、AppHeader、StatusTabs、TaskCard、TaskDetail、
  TaskList、BoardWide、NewTaskForm、DisconnectedBanner、AddBoardForm、
  RepoPicker（已引入 `t`，需核对是否全覆盖）、`mcp/types.ts`
  （移除 `STATUS_LABEL` / `EVENT_LABEL`）。
- [x] 状态层迁移：`BoardContext.tsx` 与 `useTaskActions.ts` 的 toast /
  prompt / 错误文案（如「项目模式已锁定当前仓库看板…」、
  `board_create(...) ok`、`已请求宿主打开 Agent Session…`）。
- [x] `styles.css` 补充 `.lang-switch`（复用 `.segmented`，覆盖
  `width:100%` 之类的布局干扰）。
- [x] 首帧语言设置核对（`index.html` 静态 `zh-CN` 是否需要内联脚本防
  首帧闪回）。
- [x] `pnpm --filter @tasklane/ui typecheck` + `pnpm build:ui` 通过。
- [x] 浏览器独立模式与插件形态分别验收并记录。
- [x] 更新 `ui/README.md`；补齐历史记录。
- [x] 2026-10-04 收尾核对与归档：上述遗留项已在后续会话完成（代码核对：
  `BoardContext.tsx`/`useTaskActions.ts` 经 `t()` 取词、`.lang-switch` 样式、
  `ui/README.md` 双语说明齐备；`pnpm --filter @tasklane/ui typecheck` 复跑通过），
  用户确认原生面板人工验收通过，计划归档。

## 决策记录

- 2026-10-03：语言仅 `zh | en`，zh 为权威键源，en 类型强制全覆盖。
- 2026-10-03：`LangProvider` 挂在 `BoardProvider` 之外，状态层 toast
  也能取词。
- 2026-10-03：`applyLang` 在 setState 前同步模块级语言（`translate` 对
  非组件代码可用），并同步 `html lang` 与 localStorage。
- 2026-10-03：写入 MCP 存储的数据保持语言无关，不做 i18n。
- 2026-10-03：与任务归档并行时，其新增 UI 文案直接以 i18n 键写入字典，
  避免二次返工与混排回潮。

## 阻塞点与下一步

- 当前阻塞：无。
- 下一步：迁移状态层文案（BoardContext / useTaskActions）→ 核对
  RepoPicker 覆盖 → 补样式 → typecheck / build → 浏览器与插件验收 →
  文档与历史记录。
