# UI — Sidebar（M2–M8 已交付）

按设计文档与 OpenDesign v2 原型实现，React + Vite，零额外运行时依赖（除 react）。

- **420px 窄栏（S1/S2）**：App Header（仓库看板选择器 + MCP 连接状态点 + 添加仓库 + More）· 状态 Tabs（含计数、激活态底纹+下划线）· 单列 TaskCard（紧凑四层：ID/优先级 → 标题 → Agent/人工与聊天/执行态 tag 同行 → 可选分支+diff；不展示 Run/继续、打开会话及宿主限制说明）· Task Detail **整页替换**（← Back，非抽屉）· 底部 sticky「+ 新建任务」
- **多仓库看板（M7）**：顶部选择器切换仓库（localStorage 持久化、失效回退）·「添加仓库」弹窗（board_create：绝对路径/名称/基线分支，失败保留输入内联报错）· 切换即清空旧看板列表/详情/搜索（boardId 作为视图 key 重置局部状态）· 请求按「发起时 boardId + 请求代次」隔离，覆盖 A→B→A 快速切换；写操作携带任务 boardId，服务端 BOARD_MISMATCH 兜底
- **项目/全局入口（M8，宿主嵌入）**：MCP Apps `toolresult` 接收 `open_tasklane` 上下文（connect 前注册 ONE_SHOT handler）· 项目模式锁定 `lockedBoardId`（隐藏选择器/添加入口、switchBoard/addBoard 双重守卫、不读写全局 localStorage）· 打开失败进入错误空态并禁用全部写入口（宽窄视图一致）· `window.name` 仅缓存看板范围；刷新后只读查询真实 MCP 客户端，不缓存身份权限。
- **原生直接请求与回执**：握手成功且识别 Codex 可提交实际任务，原生工具在该请求内核对，不另建验证聊天；未知/非 Codex/断连仍禁用。详情明确选择工作方式，真实 threadId/hostId/目录先返回、created→bound 后执行；明确拒绝展示请求错误，未知不重发，running/completed 只认真实回执。详情不再展示回复输入框和回复／重试／停止控制区，后续沟通交给原生聊天；会话行优先显示有效绑定的真实 threadId，否则回退内部 sessionId 并标注未绑定；请求中仍保留进度显示。仅调整显示优先级，不改内部 ID 生成或真实绑定规则；看板卡片不展示执行或打开会话操作；详情仅在有效绑定真实 threadId 后显示打开会话按钮，未绑定时不展示占位按钮，打开处理逻辑保持不变。宿主未连接（包括只连接独立 MCP 数据通道）时隐藏工作区、模型选择和 Run/继续控件，不查询模型目录；会话 ID、执行进度、历史绑定和连接提示仍保留。执行方仅作只读展示：新建默认人工，Run 的有效请求持久化后自动标记 Agent；没有手动指派按钮或新建自动指派选项。手动业务流转不触发执行。
- **Review（M4）**：Change Summary（files +/− + 测试状态 + 文件列表）、Review Changes 高亮定位、Mark Done、Open Diff（复制 worktree 路径）
- **宽视图（M5，≥760px）**：5 列 Kanban 横向滚动（760–899 露 2–3 列）· HTML5 拖拽（落列即 task_move，非法流转 toast 报错）· 右侧 Task Detail drawer（360–440px，Board 上下文保留）
- **M6**：Light/Dark 双主题（localStorage 持久化、首帧防闪烁）· 首次空态/Doing 空态/Review 空态/无看板空态 · MCP 断连横幅（缓存只读+操作禁用+自动重连，重连后重读看板列表）· skeleton 加载 · 全键盘可达（focus-visible、aria-label）
- **中英文切换（i18n）**：`ui/src/i18n/` 统一双语字典（zh 键为权威来源，en 类型检查强制全覆盖），全部界面文案经 `t(key, params)` 取词——不再出现「中文（English）」混排或单语言写死 · 首次语言 = localStorage `tasklane-lang` > 浏览器语言（zh* → 中文）> 默认中文 · 宽视图（≥760px）Header 右上角平铺「中/EN」分段控件与主题图标；窄栏收进「设置 ⚙」菜单（语言同款分段控件、主题 toggle），搜索/刷新仍在「更多 ⋯」菜单 · 切换即整树重渲染并同步 `<html lang>`；写入 MCP 存储的数据（execution.activity 等）保持语言无关

所有业务读写均通过 MCP；独立模式使用 WebSocket，原生面板使用 `McpAppsClient`。原生 sendMessage/openLink 必须通过统一宿主门控，不能直接调用别的 MCP 服务的聊天工具。

UI 自动化门控测试：`node --test ui/test/native-execution.test.mjs`；协议模拟不是 Codex 原生路由验收。

开发模式 `pnpm --filter @tasklane/ui dev`（Vite 5176 代理 /mcp → bridge 7433），独立运行见根 README「运行 Sidebar」。
