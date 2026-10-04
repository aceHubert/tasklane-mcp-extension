## [2026-10-03 15:20 +0800] | 任务：UI 侧栏视觉对齐设计稿

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3-Flash`
- **Runtime**：`ZCode CLI（macOS darwin arm64）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（仓库尚无任何提交，unborn HEAD；全部文件处于已暂存未提交状态）`
- **关联计划**：无

### 用户诉求

> 根据 codex-kanban-sidebar.html 设计稿优化侧栏视觉，重点是配色、图标、Tag、关闭等，不涉及逻辑变更。追加要求：logo 使用项目资源文件（extension/assets）；设计稿偏旧，以项目现状为准；「添加仓库」入口移入仓库选择器的 suffix 槽位。

### 变更概览

**影响范围**：`ui/`（纯展示层，无状态/MCP 契约/存储改动）。

**主要操作**：

- **配色体系**：`styles.css` 引入设计稿 Design Tokens——深色主题完全采用深板岩三层底（`#0c1017`/`#141a24`/`#1c2331`）、靛蓝强调（`#4f46e5`/`#6366f1`）、紫 Agent（`#a855f7`）；浅色主题按同色系取深阶保持对比度。新增 P0 红/P1 橙/P2 天蓝/P3 灰的优先级徽章配色（彩色文字 + 16% 底 + 35% 描边）。
- **图标**：新增 `ui/src/components/icons.tsx` 内联 SVG 图标集（stroke 2 风格），替换头部与卡片中的文本符号/emoji（⊞ ☾ ⋯ ⟳ ⧉ ⑂ 👤 🤖 ⏸ ⚠ ✔ ← 等），统一 14px 描边风格；品牌徽标改为项目自带 `extension/assets/logo-64.png`（复制到 `ui/public/logo.png`）。
- **Tag**：优先级 P0–P3 徽章、状态 Tag（Backlog 灰/Ready 天蓝/Doing 绿/Review 琥珀/Done 紫）、指派 Chip（Human 中性灰 / Agent 紫）、列头彩色状态点 + 计数徽章，全部对齐设计稿 badge 语言。
- **关闭等交互细节**：详情页/新建表单/添加仓库的顶部栏统一为「ID + 状态 Tag + 复制 + 关闭 ✕」结构（icon-btn 透明底样式）；Running 脉冲改为设计稿的外扩光圈动画；Toast 改左缘 3px 状态色条；Drawer/Modal 增加入场动画与背板模糊；细滚动条；状态 Tabs 改分段控件浮起样式；优先级分段选择器改凹陷容器 + 浮起选中项。
- **仓库选择器**：「添加仓库」按钮移入选择器 suffix 槽位（自绘 chevron，appearance:none），首次使用（无看板）时退化为独立按钮。
- **资源重命名**（同会话追加要求）：`kanban-logo*` 资源文件去掉 `kanban-` 前缀，统一为 `logo-*`（`extension/assets/` 8 个、`plugins/tasklane/assets/` 4 个、canvas 资产 1 个、`ui/public/logo.png`），并同步更新插件 manifest（源 + 产物）、`scripts/build-plugin.mjs` 图标清单、画布 `cowart-canvas.json` 的资产 id/name/src 及 UI 引用；跟踪文件以 `git mv` 重命名保持暂存区一致。
- **深色主题换深空灰**（同会话追加要求，先改设计稿后改代码）：深色板从中性带蓝的板岩色（`#0c1017`/`#141a24`/`#1c2331` 等）整体换成 Space Gray 中性锌灰阶（`#0e0e10`/`#18181b`/`#202024`/`#28282d`，边框 `#2a2a2f`/`#3f3f46`，文字 `#f4f4f5`/`#a1a1aa`/`#71717a`），P3 与 icon-hover 同步去蓝；靛蓝强调与状态/优先级彩色令牌不变。设计稿同步：v1 全量色板替换、v2 深色块 9 处 oklch 去色度（存于 OpenDesign 项目，不在本仓库）。
- **修复深色下拉看不清**（同会话追加）：根因是原生 `select` 弹出层未声明 `color-scheme`，深色下按浅色方案渲染（白底 + `--fg` 浅字）。在 `:root` 加 `color-scheme: light`、`[data-theme='dark']` 加 `color-scheme: dark`，让原生控件（下拉弹层、滚动条、表单控件）跟随主题；设计稿 v1/v2 同步补齐。
- **抽屉避让宿主输入框**（同会话追加，最终方案）：用户实测宿主（Codex/Cowart 侧栏）输入框悬浮在右下、遮挡抽屉底部操作区。曾按用户要求先改挂左侧，随后用户调整为保留右侧全高，改为抽屉内容区 `padding-bottom: calc(var(--host-safe-bottom, 100px) + 12px)`——滚动到底时最后一段内容可完整滚出遮挡区；`--host-safe-bottom: 100px` 在 `:root` 显式声明便于调整。设计稿 v1/v2 同步（抽屉全高 + 内容区 padding 预留）。
- **主题切换改回图标按钮**（同会话追加）：小屏设置菜单（HeaderSettings）中的主题控件由无状态 switch 改回 sun/moon 图标按钮——深色显太阳（点击切浅色）、浅色显月亮，与大屏平铺按钮一致，图标本身表达 dark/light 目标模式；aria/title 沿用 i18n 的 `header.themeLight/Dark*`。`styles.css` 中 `.toggle` 样式随之闲置（保留未删）。
- **Header 操作区重排**（同会话追加）：原最右「⋯更多」入口改为搜索图标按钮，弹出层含搜索框与刷新（`aria-expanded` 同步）；「主题」「语言」移到操作区**最后**。顺序经用户两次调整后定为：**新建 → 搜索 → 归档 → 主题 → 语言**（宽视图；窄视图搜索在归档前、设置菜单殿后）。设计稿 v2 S1 头部同步 ⋯→🔍。
- **修复卡片链接按钮漂移**（同会话追加）：卡片/分区为 flex-column，`link-btn` 作为子项被拉伸整行且文字居中，视觉上「在 Agent 中执行」等飘在行中部、留大片空白。修复：`.link-btn` 加 `width: fit-content; max-width: 100%; text-align: left`。
- **修复下拉箭头压边框**（同会话追加，二次修复定稿）：全局表单样式覆盖了 select 的 padding，且一旦 select 被自定义边框/背景，Chromium 会把原生箭头画死在最右缘——`padding-right` 只推走文字、推不走箭头。定稿方案：`appearance: none` + 主题色自绘 chevron（`--select-arrow`，浅 #66707b / 深 #a1a1aa），`background-position: right 12px center` + `padding-right: 34px`；仓库切换器 suffix 槽位有自己的箭头图标，`background-image: none` 豁免。
- **disabled 可读性**（同会话追加）：`.btn/.link-btn/.icon-btn:disabled` 透明度 0.45 → 0.65（用户确认调高）；补 `input/select/textarea:disabled` 明确样式（muted 字 + `--bg-inset` 凹陷底 + not-allowed），不再依赖浏览器默认灰。
- **强调色换 logo 亮蓝**（同会话追加，先改设计稿后改代码）：从 `extension/assets/logo-64.png` 采样最右侧彩色带主色 **#00a8b8**（青蓝），替代原靛蓝/紫强调。设计稿：v1 的 border-accent/主按钮/拖拽高亮/focus 光圈（5 处）、v2 浅深两主题的 accent 三件套（oklch：浅 61% 0.105 211、深 76% 0.122 206 等六值）。代码 `styles.css`：浅色 `--accent/--accent-strong #0093a6`、`--accent-hover #007e90`；深色 `--accent #2cc7d8`、`--accent-hover #4fd6e4`、`--accent-strong #0093a6`（按钮底沿用深阶保证白字对比）。**Agent 紫（`--agent` 系）作为身份色保留未动**；v2 的 status-running 蓝亦保留（状态语义色）。
- **强调色混入 logo 暗蓝加深**（同会话追加）：#00a8b8 直译色偏亮、按钮白字对比不足（约 3:1）。按用户要求混入 logo 第二条暗色 `#0068b8`（右栏暗部）：accent 定为 **#0080ae**（45% 混合，白字对比 4.47:1），hover **#0074b0**（5.1:1）。设计稿 v1 主按钮、v2 浅色 accent/hover 同步（oklch 56% 0.116 233 / 54% 0.127 242）；代码浅色 accent 三值与深色 `--accent-strong` 同步加深，深色链接亮青蓝 `#2cc7d8` 保留（深底无白字对比问题）。
- **旧会话标签换行修复**（同会话追加）：详情抽屉「指派对象」分区里 `exec.sessionId` 行的标签原为「旧内部标识（不是真实聊天）」（13 字），超出 `.kv .k` 固定 110px 窄列在列内折行，视觉破碎且是开发者口吻。改为「旧会话」（英文 Legacy session），单行放得下；该行语义不变——仍表示旧版内置执行器留下的内部会话 ID（区别于真实聊天线程）。
- **取消新旧会话区分**（同会话追加，用户拍板「不需要兼容、不分新旧」）：推翻上一条的折中方案，彻底移除「旧会话 / 真实聊天」二元展示与 `unverified`（旧执行状态未核实）状态——会话 ID 只有一个：优先宿主真实聊天线程（`executionBinding.threadId`），否则回退本地自动生成 ID（`exec.sessionId`）。`host.ts` 的 `executionStatus()` 删除 `unverified` 分支与联合成员（无绑定一律 `unbound`，有绑定无本轮回执一律 `bound`，旧 `execution.state` 不再参与状态推导；宿主路由验证的 `HostBlockReason 'unverified'` 是另一概念，保留）；`TaskDetail` 删除「指派对象」里的旧会话行，「执行工作方式」分区改为单一「会话」行（`native.session`，中/英）；i18n 删除 `native.status.unverified`、`native.internalSession`，`native.thread`（真实聊天）并入 `native.session`，`native.status.unbound` 措辞去掉「真实」二字；`styles.css` 删除 `.native-state.unverified` 选择器。
- **未绑定状态并入会话行 tag**（同会话追加）：「执行工作方式」分区里单独占一行的「未绑定聊天」状态，改为中性灰 chip（复用 `.exec-chip`，零新增 CSS）跟在会话 ID 后面；仅当 `unbound` 且本地有会话 ID 时并入（`unboundTag`），其余状态仍走 `.native-state` 状态行，无会话 ID 的未绑定任务也保留原状态行兜底。
- **下拉弹层选项显式主题色**（同会话追加，三次定稿）：此前 `color-scheme` 方案在标准 Chrome 生效，但用户宿主（Codex 侧栏 webview）画弹层画布时不跟页面 `color-scheme`——画布仍白底，选项文字却继承页面深色主题的浅色，出现「白底浅灰字不可读」。修复：`option, optgroup { background: var(--panel); color: var(--fg) }` + `option:checked { background: var(--card-hover) }`，不依赖 `color-scheme`——宿主既然绘制 option 颜色（浅灰字即为证据），显式深底浅字即整行可读，`:checked` 同时压掉原生蓝色高亮。浅色主题下选项为白底深字不受影响。
- **归档入口移到卡片头部**（同会话追加）：已完成卡片的「归档」链接按钮从 exec 行（指派徽章同行）移到 `card-head`（task id 同行），`margin-left: auto` 靠右对齐（`.card-archive`）。
- **时间线长文本撑破抽屉修复**（同会话追加）：`tasklane-task102-start-…` 这类不可断 token 把 `.tl-detail` 的 min-content 一路顶到 `.timeline`（grid）与 `.detail-scroll`（grid）的 `auto` 轨道上，抽屉出横向滚动条；`.tl-detail` 原有的 `text-overflow: ellipsis` 因 flex/grid 子项 `min-width: auto` 永不生效。修复三件套：`.tl-detail` 加 `min-width: 0`；`.detail-scroll` 与 `.timeline` 轨道改 `minmax(0, 1fr)`；事件 detail 加 `title` 悬停看全文。临时环境注入超长 runId 与长中文回执验证：无横向滚动、按省略号截断。
- **抽屉底部归档按钮**（同会话追加）：详情抽屉内容区最底部（`primaryCta` 之后）新增「归档」按钮（`ArchiveIcon` + `archive.action`，复用 `.btn` 自带 icon gap），仅对已完成未归档任务显示——与卡片入口及 core `archiveTask` 仅允许 done 的规则一致；已归档任务底部仍是「恢复到已完成」。在用户真实看板（7433，只读验证）确认按钮位于抽屉最后且样式正常，未点击执行。
- **补齐 favicon**（同会话追加）：`ui/index.html` 引用的 `favicon-16/32/64.png` 与 `apple-touch-icon.png` 在 `ui/public/` 中不存在，页面标签图标 404。从 `extension/assets/` 复制同尺寸 logo（`logo-16/32/64/180.png`）为对应 favicon 文件；构建后 7433 实测四个 URL 均 200 且按声明尺寸加载。
- **抽屉底部按钮合并一行**（同会话追加）：上一条新增的「归档」原独占一行，按用户要求并入已完成分支的 `primaryCta` 同一 `cta-row`——「重新打开」与「归档」并排；删除独立的底部归档行。随后用户追加要求：「重新打开」改 `btn danger` 红色警示（会把完成结果退回待审查，属破坏性流转）。7433 真实看板只读验证：两按钮同行、danger 红色生效。
- **执行状态改 alert 提示条并上移**（同会话追加）：「执行工作方式」分区里原 `.native-state` 纯文本状态行（如「本轮执行完成」）改为 `.status-note` alert 样式（圆角提示条 + 状态配色：completed/running 绿、waiting/uncertain 黄、failed 红、其余 info 蓝，配语义图标 Check/Pause/Alert），并移到「会话」行**上方**；未绑定+有会话 ID 时不显示（仍是会话行内的 tag）。7433 真实看板验证：绿色提示条「✓ 本轮执行完成」位于会话行上方。
- **已执行任务的创建模型常显**（同会话追加）：原「创建时模型」kv 行被 `hostConnected` 门控——非 Codex 宿主（如浏览器独立模式）下已执行任务完全不显示模型记录。改为：已绑定聊天的任务**始终**纯文本展示模型记录，不再依赖当前宿主连接；模型**选择框**仍仅在 Codex 宿主连接且未绑定时显示。随后用户要求：标签改为「使用模型」（英文 Model used）、隐藏行下说明文字（`native.model.record` 段落删除）；7433 真实看板验证：宿主未连接的 TASK-103 显示「使用模型 gpt-6-luna」且无说明文字。
- **打开会话不可用改为隐藏**（同会话追加）：抽屉「打开 Agent 会话」按钮原在不可用（断连或 openReason 阻断）时置灰禁用，按用户要求改为条件渲染直接隐藏；卡片上的同名链接用户已在并行改动中自行移除。7433 验证：宿主未连接时抽屉内无该按钮。
- **会话恢复按钮上移至状态 alert 下方**（同会话追加）：「检查并恢复 / 核对会话状态」按钮原位于分区底部（blocked 说明文字之后），按用户截图要求移到「执行工作方式」分区顶部状态提示条（`.status-note`）正下方，阻塞时恢复操作第一眼可见；说明文字与核对结果回显位置不变。用户将自行手工验收该流程，未做自动化 UI 验证。
- **模型区展示逻辑按宿主与选择状态分流定稿**（同会话追加，用户确认规则）：① 非 Codex 宿主且选择未确认 → 模型区完全不显示；② Codex 宿主且选择未确认 → 可编辑模型表单（select）；③ 选择已确认（有聊天绑定**或**请求已提交锁定模型）→ 无论 Codex 与否一律只读文本「使用模型」。移除 pending 态的禁用 select（改为文本）、`pendingModelMissing` 兜底选项及 `native.model.pending`/`native.model.record` 两个 i18n key。另修复用户截图旧 select 的根因之一：bridge 静态服务此前无缓存头，webview 缓存旧 `index.html` 引用旧 bundle——现 `index.html` 发 `cache-control: no-cache`、`/assets/*`（带 hash）发 `immutable` 长缓存；`pnpm verify:bridge` 通过。
- **执行状态变更清除过期核对消息**（同会话追加，用户规则「任何一次执行状态的变更都应该清除消息」）：`recoveryCheck`（恢复/状态核对结果，含长异常摘要）此前一经写入永久残留在请求上，同一请求后续真实回执（running→completed）也不会清，UI 长期回显过期异常。修复两层：① core `native-execution.ts` 新增 `supersedeCheck`——claim/delivery/bind/report 每次实际状态变更时清除**已出结果**（非 pending）的核对消息，pending 在途检查保留（不影响恢复 CAS 语义）；② UI 对终态请求（completed/failed/rejected/cancelled，含历史遗留数据）不再回显核对消息。曾尝试存储加载时对终态请求丢 check，因破坏「终态 recover 报 EXECUTION_CONFLICT」守卫测试契约回退。新增回归测试（bound→核对 unknown→report running/completed 清除）；`pnpm build` + `pnpm test` 260 项全过。
- **执行工作方式默认 worktree**（同会话追加）：详情抽屉的工作方式下拉默认值由空（请选择，阻断 start）改为「新建聊天并在独立 worktree 执行」；已有 worktreePath 的任务默认「原样复用已有工作区」（core 规则要求）。移除空占位 option 与「请选择工作方式」字段标签，删除失效 i18n key `native.select`。
- **工作方式随运行持久化转只读文本**（同会话追加，用户定稿规则）：显示模式由**持久化对象**决定而非单个字段值——点「执行」即持久化请求对象，此后（pendingCreation，无论 Codex 与否）工作方式与模型一律只读文本、不允许修改（模型此前已改）；仅有绑定显示工作区路径，请求待回执显示「工作方式」文本（`native.mode` 新 key），两者都不存在且 Codex 连接时才显示可编辑 select（默认 worktree）。
- **核对入口仅卡住超时显示**（同会话追加，用户两次修正定稿）：`canRecover` 原条件过宽（任意未取消请求都显示），导致执行完成后仍出现「核对对话状态」按钮。先收紧为 blocked/uncertain，用户再修正为最终规则：**仅在请求进行中（pending/delivered/claimed/created/bound）且 `updatedAt` 距今超过 5 分钟**时显示核对按钮（等待回执超时视为需要人工干预）；blocked/uncertain/completed 等状态一律不显示，由各自提示条表达。7433 验证：阻塞任务（黄色「执行阻塞，核对后可继续」提示条）与已完成任务均无核对按钮。
- **阻塞提示去重**（同会话追加）：阻塞状态此前三处重复——指派对象徽章、指派对象区红色 fail-note（与「当前活动」全文一致）、执行区状态提示条（仅短语）。定稿：删除指派对象区的 fail-note；其完整原因（`exec.activity` / `deliveryError`）并入执行区状态提示条——blocked 时显示「执行阻塞：<完整原因>」（err 红），其余状态仍显示短语。7433 验证：指派对象区无阻塞 alert，执行区提示条含完整原因，与「当前活动」同源不双写。
- **头部操作区宽窄分流定稿**（同会话追加）：新增 `ExportEntry` 组件（icon/menu 两种形态复用同一对话框）。大屏头部平铺：新建 → 搜索 → 归档 → **导出**（归档后面）→ 主题 → 语言，无设置按钮；小屏头部只留 新建 → 搜索 → **⋯设置菜单**（齿轮改回三个点 MoreIcon），归档也收进菜单，菜单首行平铺**语言在前、主题在后**（无标签、默认靠左；曾按要求改过靠右，最终定稿靠左），下接「已归档任务（N）」「导出报告」动作项。7433 大小两档宽度验证：大屏顺序正确、小屏头部无归档/导出、菜单首行语言在主题前。
- **工作区说明文字仅可编辑态显示**（同会话追加）：「新独立工作区由 Codex 管理…」说明（`native.ownership`）原在 `hostConnected` 时恒显示，只读文本（工作方式/模型 kv 行）下方也出现。改为并入可编辑 select 分支内——与模型帮助文字一致，只读时一并不显示。7433 验证：待回执任务显示「工作方式/使用模型」kv 行且无说明文字。

### 设计动机

设计稿与项目现状存在结构差异（设计稿含架构页/审计日志等未实现模块），按用户要求仅吸收其视觉语言：令牌化配色、徽章化 Tag、统一 SVG 图标、克制的关闭/悬浮反馈；所有 className、组件结构与业务逻辑保持不变，`StatusTabs`/`TaskList` 等未触碰。回滚方式：还原 `ui/` 下对应文件即可，无数据或契约影响。

### 验证结果

- `pnpm --filter @tasklane/ui typecheck`：通过（`tsc --noEmit` 无输出）。
- `pnpm build:ui`：通过（47 modules，339ms）。
- 浏览器验证：`node packages/bridge/bridge.mjs` + 临时数据目录（`TASKLANE_HOME=/tmp/ck-ui-verify-home`，临时 Git 仓库 `/tmp/ck-ui-verify-repo` 种子 6 任务），420px 窄栏与 1440px 宽视图、深色/浅色双主题下检查：卡片/优先级 Tag 四色、Agent Running 脉冲与 Waiting 琥珀态、详情页头部与关闭、列头状态点、suffix「添加仓库」入口，均符合预期；未操作用户真实看板（真实数据目录未被写入）。
- 未运行：`pnpm test`（core/mcp 无改动，无需构建测试链路）；Codex 原生侧栏宿主内验收未做。
- 未覆盖场景：拖拽落列的高亮反馈、360px 最窄验收态、断连横幅在实际宿主中的表现。

### 变更统计

> 仓库无有效 HEAD（尚无提交），修改文件按 `git diff --numstat -- <file>`（index 与工作区对比）统计；新增文件与 `/dev/null` 对比（`git diff --no-index`）。`ui/src/mcp/appsClient.ts` 的 APP_VERSION 改动系任务开始前已存在于工作区的他人改动，未纳入本次统计（已保留）。历史记录自身不计入。
> 注：自 color-scheme / 抽屉避让追改起，用户对同一批文件（含 styles.css）存在并行修改与暂存，`git diff` 已无法按任务精确拆分；下表为止于「深空灰 + color-scheme」时点的快照，其后追加改动不再单独更新总数。

- **统计口径**：仅本次任务触及的 `ui/` 文件；修改 9 个（+400/−156，含深空灰追改与 color-scheme 修复），新增 2 个（icons.tsx +172 行；logo.png 二进制）。
- **变更文件数**：11
- **新增行数**：+572（含新增文件；不含二进制）
- **删除行数**：-156

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `ui/src/styles.css` | 318 | 108 |
| `ui/src/components/AppHeader.tsx` | 49 | 28 |
| `ui/src/components/icons.tsx`（新增） | 172 | 0 |
| `ui/src/components/TaskDetail.tsx` | 11 | 7 |
| `ui/src/components/TaskCard.tsx` | 8 | 7 |
| `ui/src/components/AddBoardForm.tsx` | 4 | 2 |
| `ui/src/components/DisconnectedBanner.tsx` | 3 | 1 |
| `ui/src/components/NewTaskForm.tsx` | 3 | 1 |
| `ui/src/components/BoardWide.tsx` | 2 | 1 |
| `ui/src/App.tsx` | 2 | 1 |
| `ui/public/logo.png`（新增，二进制） | — | — |

### 修改文件

- `ui/src/styles.css`
- `ui/src/components/icons.tsx`（新增）
- `ui/src/components/AppHeader.tsx`
- `ui/src/components/TaskCard.tsx`
- `ui/src/components/TaskDetail.tsx`
- `ui/src/components/NewTaskForm.tsx`
- `ui/src/components/AddBoardForm.tsx`
- `ui/src/components/BoardWide.tsx`
- `ui/src/components/DisconnectedBanner.tsx`
- `ui/src/App.tsx`
- `ui/public/logo.png`（新增，复制自 `extension/assets/logo-64.png`）

### 后续事项

- 无。设计稿中的架构页、MCP 审计日志等未实现模块不在本次范围，如需实现应另立执行计划。
