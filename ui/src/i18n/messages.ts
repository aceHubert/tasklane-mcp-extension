import type { TaskStatus } from '@tasklane/core';
import { nativeZh, nativeEn } from './nativeMessages';

/**
 * 界面文案字典：zh 为键的权威来源，en 必须覆盖完全相同的键（漏译在类型检查报错）。
 * 界面上不再出现「中文（English）」混排或单语言写死，统一走 t(key, params) 取词；
 * 写入 MCP 存储的数据（execution.activity 前缀等）不属于界面文案，保持语言无关。
 */

export type Lang = 'zh' | 'en';

/** 插值参数：模板中的 {name} 占位符 */
export type MessageParams = Record<string, string | number>;

const zh = {
  ...nativeZh,
  // 通用
  'common.cancel': '取消',
  'common.loading': '加载中…',
  'lang.aria': '切换界面语言',

  // Header
  'header.connConnected': 'MCP 已连接',
  'header.connConnecting': '连接中…',
  'header.connDisconnected': 'MCP 已断开',
  'header.newTask': '新建任务',
  'header.new': '新建',
  'header.switchBoardAria': '切换仓库看板',
  'header.addBoard': '添加仓库',
  'header.moreAria': '更多操作',
  'header.refresh': '刷新',
  'header.searchPlaceholder': '搜索 ID / 标题 / 分支…',
  'header.searchAria': '搜索任务',
  'header.boardOption': '{name}（{count}）',
  'header.boardOptionNonGit': '{name}（{count}·非 Git）',
  'header.themeLightAria': '切换到浅色主题',
  'header.themeDarkAria': '切换到深色主题',
  'header.themeLight': '浅色主题',
  'header.themeDark': '深色主题',
  'settings.aria': '设置',
  'menu.theme': '主题',
  'menu.language': '语言',

  // 任务状态（Tabs / 看板列 / 详情下拉共用）
  'status.backlog': '待办',
  'status.ready': '就绪',
  'status.doing': '执行中',
  'status.review': '待审查',
  'status.done': '已完成',

  // 执行态（Agent · state）
  'exec.idle': '空闲',
  'exec.assigned': '已指派',
  'card.execTag': '执行',
  'card.reviewTag': '验收',
  'exec.starting': '启动中',
  'exec.running': '运行中',
  'exec.waiting': '等待输入',
  'exec.blocked': '已阻塞',
  'exec.failed': '失败',
  'exec.completed': '已完成',

  // 时间线事件
  'event.created': '创建',
  'event.assigned': '已指派',
  'event.started': '已开始',
  'event.activity': '活动',
  'event.waiting': '等待输入',
  'event.blocked': '执行阻塞',
  'event.failed': '失败',
  'event.completed': '执行完成',
  'event.stopped': '已停止',
  'event.moved': '状态流转',

  // 任务卡片
  'card.human': '人工',
  'card.start': '启动',
  'card.waiting': '等待输入',
  'card.reply': '回复',
  'card.failed': '失败',
  'card.retry': '重试',
  'card.readyForReview': '执行完成，待审查',
  'card.reviewChanges': '查看变更',
  'card.completed': '已完成',
  'card.taskAria': '任务 {id}：{title}',
  'card.files': '{count} 个文件',
  'card.overdue': '已过期',

  // 会话执行报告卡片
  'reportCard.aria': 'TaskLane 执行报告卡片',
  'reportCard.label': '执行报告',
  'reportCard.loading': '正在读取执行报告…',
  'reportCard.openDetail': '查看详情',
  'reportCard.opening': '正在打开…',
  'reportCard.unsupported': '当前宿主不支持展开详情，执行报告已保留。',
  'reportCard.refused': '宿主未允许打开详情，请重试。执行报告已保留。',
  'reportCard.contextChanged': '报告上下文已改变，请从当前卡片重新打开详情。',

  // 任务详情
  'detail.closeAria': '关闭详情',
  'detail.copyIdAria': '复制任务 ID',
  'detail.idCopied': '{id} 已复制',
  'detail.titleAria': '任务标题',
  'detail.statusAria': '任务状态',
  'detail.priorityAria': '优先级',
  'detail.deadlineAria': '截止时间',
  'detail.deadlineClear': '清除',
  'detail.fieldStatus': '状态',
  'detail.fieldPriority': '优先级',
  'detail.fieldDeadline': '截止时间',
  'detail.fieldDescription': '描述',
  'detail.notDirect': '（不可直达）',
  'detail.descPlaceholder': '补充上下文（Markdown）…',
  'detail.assignedTo': '执行方',
  'detail.agentState': 'Agent · {state}',
  'detail.currentActivity': '当前活动',
  'detail.started': '开始时间',
  'detail.session': '会话',
  'detail.failNoteWithActivity': '执行失败：{activity} — 可重试或打开会话排查',
  'detail.failNote': '执行失败 — 可重试或打开会话排查',
  'detail.waitNote': 'Agent 正在等待你的输入，回复后继续执行',
  'detail.timeline': '执行时间线',
  'detail.gitContext': 'Git 上下文',
  'detail.repo': '仓库',
  'detail.base': '基线',
  'detail.branch': '分支',
  'detail.worktree': '工作区',
  'detail.changeSummary': '变更摘要',
  'detail.filesChanged': '{count} 个文件变更',
  'detail.testsPassing': '测试 ✓',
  'detail.testsFailing': '测试 ✗',
  'detail.testsUnknown': '测试 ?',
  'detail.openDiff': '打开 Diff',
  'detail.worktreeCopied': 'worktree 路径已复制，完整 diff 请在编辑器中打开',
  'detail.noGitContext': '本任务没有 Git 上下文（仓库未配置）',
  'detail.noChanges': '暂无变更数据（无 Git 上下文或尚未进入审查）',
  'detail.openSession': '打开会话',
  'detail.openAgentSession': '打开 Agent 会话',
  'detail.markDone': '标记完成',
  'detail.reopen': '重新打开（回到待审查）',
  'detail.delete': '删除任务',
  'detail.deleteConfirm': '确定删除该任务吗？任务及执行时间线将被移除，且不可恢复。',
  'detail.deleteDone': '{id} 已删除',

  // 新建任务表单
  'form.closeAria': '关闭新建表单',
  'form.titleLabel': '标题 *',
  'form.titlePlaceholder': '例如：Add OAuth callback handler',
  'form.descPlaceholder': '可选，Markdown；Agent 会通过 MCP 读取',
  'form.initialStatus': '初始状态',
  'form.deadline': '截止时间（可选）',
  'form.plainHint': '创建后保持人工标识；在详情点击运行，提交执行请求后自动标记为 Agent。',
  'form.create': '创建',
  'form.noTaskId': 'task_create 未返回任务 ID',

  // 列表空态与错误态
  'tabs.aria': '任务状态导航',
  'tabs.reviewDot': '待审查',
  'list.projectErrorTitle': '项目看板打开失败',
  'list.projectErrorDesc':
    '当前聊天的工作区无法解析为可用的 Git 仓库看板（路径无效或基线分支不匹配）。请修正后重新打开；不会自动回退到其他仓库。',
  'list.boardsErrorTitle': '看板列表读取失败',
  'list.loadingAria': '加载中',
  'list.noBoardsTitle': '还没有看板',
  'list.noBoardsDesc': '点击顶部 ⊞ 添加一个本地 Git 仓库，开始管理它的任务看板。',
  'list.noTasksTitle': '还没有任务',
  'list.noTasksDesc': '创建第一个任务，或从示例模板开始。',
  'list.emptyDoing': '没有正在执行的任务',
  'list.emptyReview': '暂无待审查变更',
  'list.emptyOther': '该状态下暂无任务',
  'list.viewReady': '查看「就绪」',
  'list.listAria': '「{status}」任务列表',
  'list.tpl1': '添加带 state 校验的 OAuth 回调处理',
  'list.tpl2': '为 auth 模块编写单元测试',
  'list.tpl3': '重构看板存储以支持分页',

  // 宽视图看板列
  'board.colAria': '「{status}」列',
  'board.dropHint': '拖入卡片改变业务阶段（不启动执行）',

  // 断连横幅
  'banner.connecting': '正在连接 MCP 服务…',
  'banner.disconnected': 'MCP 连接中断：列表为缓存只读，操作已禁用；正在自动重连…',
  'banner.note': '连接错误 ≠ 任务失败，已执行的操作不受影响',

  // 添加仓库表单
  'add.closeAria': '关闭添加仓库表单',
  'add.repoPathLabel': '项目目录绝对路径 *',
  'add.repoPathPlaceholder': '例如 /Users/you/projects/my-repo',
  'add.browse': '浏览…',
  'add.browseTitle': '浏览本机目录选择 Git 仓库',
  'add.nameLabel': '看板名称',
  'add.namePlaceholder': '可选，默认使用仓库目录名',
  'add.baseLabel': '基线分支',
  'add.basePickedPlaceholder': '检测自仓库分支：{branch}',
  'add.basePlaceholder': '默认 main；无提交时填写当前分支',
  'add.basePickedTitle': '基线分支检测：优先 main，其次 master，无提交时取当前分支，其余默认 main',
  'add.baseTitle': '已有提交时须为已存在的本地分支；无提交时须与当前分支一致',
  'add.hint':
    '注册本地项目目录为新看板；Git 仓库的子目录、符号链接与 worktree 会自动归位到主仓库。非 Git 目录同样可添加（Git 分支与 worktree 能力不可用，后续初始化 Git 自动获得）。重复注册同一仓库或目录时直接切换到已有看板。尚无提交的仓库也可添加，创建任务 worktree 前才需要首次提交。',
  'add.nonGitHint': '检测为非 Git 目录：将按项目目录注册；Git 分支管理与创建 worktree 不可用，任务仍在该目录执行与验收。',
  'add.registering': '注册中…',
  'add.submit': '添加',

  // 目录选择器
  'picker.title': '选择仓库',
  'picker.cancelAria': '取消选择仓库',
  'picker.upAria': '返回上一级',
  'picker.upTitle': '上一级',
  'picker.jumpTo': '跳转到 {path}',
  'picker.readFailed': '读取目录失败：{error}',
  'picker.reading': '读取目录中…',
  'picker.noSubdirs': '此目录下没有可见的子目录',
  'picker.subdirsAria': '子目录列表',
  'picker.useRepo': '使用仓库 {path}（基线：{branch}）',
  'picker.useCurrent': '使用当前目录 {path}',
  'picker.useCurrentTitle': '将当前目录作为项目添加（非 Git 目录同样可用）',
  'picker.enter': '进入 {name}',
  'picker.hint': '点击 Git 仓库直接选用；点击普通文件夹进入下一级，或使用底部按钮把当前目录添加为项目。隐藏目录不展示。',

  // 操作反馈（toast / prompt / 错误）
  'toast.mcpOk': '{call} 成功',
  'toast.replyPromptLabel': '回复 Agent（保留完整内容）',
  'toast.projectLockedSwitch': '项目模式已锁定当前仓库看板；切换请打开全局看板入口',
  'toast.projectLockedAdd': '项目模式已锁定当前仓库看板；添加仓库请打开全局看板入口',
  'toast.boardCreateNoId': 'board_create 未返回看板 ID',
  'mcp.notConnected': 'MCP 未连接',

  // 相对时间（分钟/小时/天为紧凑单位，两种语言一致）
  'time.justNow': '刚刚',
  'time.ago': '{time} 前',

  // 任务归档
  'archive.action': '归档',
  'archive.archivedChip': '已归档',
  'archive.archivedAgo': '已归档 {time}',
  'detail.archivedBanner': '已归档 {time} — 任务只读，恢复后回到「已完成」',
  'detail.restoreToDone': '恢复到「已完成」',
  'header.archived': '已归档',
  'header.archivedAria': '已归档任务（{count}）',
  'archive.viewTitle': '已归档 · {name}',
  'archive.searchPlaceholder': '搜索 ID / 标题…',
  'archive.searchAria': '搜索已归档任务',
  'archive.closeAria': '关闭归档列表',
  'archive.emptyTitle': '还没有已归档任务',
  'archive.emptySearchTitle': '没有匹配的归档任务',
  'archive.emptySearchDesc': '换一个关键词，或清除搜索查看全部归档任务。',
  'archive.readErrorTitle': '归档列表读取失败',
  'archive.restore': '恢复到「已完成」',
  'archive.cardAria': '任务 {id}：{title}',
  'archiveAll.button': '归档全部已完成（{count}）',
  'archiveAll.buttonEmpty': '归档全部已完成',
  'archiveAll.confirmText': '归档看板「{name}」全部 {count} 个已完成任务？',
  'archiveAll.confirm': '确认归档',
  'archiveAll.busy': '归档中…',
  'archiveAll.done': '已归档 {count} 个已完成任务',
  'archiveAll.noBoard': '尚未选择看板',
  'event.archived': '已归档',
  'event.restored': '已恢复',

  // 导出报告（task_export）
  'header.export': '导出报告',
  'export.title': '导出 Markdown 报告',
  'export.closeAria': '关闭导出面板',
  'export.boardLabel': '看板',
  'export.startLabel': '开始日期',
  'export.endLabel': '结束日期',
  'export.scopeLabel': '任务范围',
  'export.scopeAll': '全部（含归档）',
  'export.scopeActive': '仅未归档',
  'export.scopeArchived': '仅已归档',
  'export.quickMonth': '最近一个月',
  'export.quickThisMonth': '本月',
  'export.quickLastMonth': '上月',
  'export.hint': '默认从今天往前推一个月（本地自然日，含起止当天）；任务创建、更新或归档时间落在区间内即导出。',
  'export.invalidRange': '开始日期不能晚于结束日期',
  'export.submit': '生成报告',
  'export.submitting': '生成中…',
  'export.pathLabel': '文件路径',
  'export.pathCopy': '复制路径',
  'export.pathCopied': '已复制',
  'export.pathCopyFailed': '宿主拒绝剪贴板写入，请手动选择路径复制',
  'export.failed': '导出失败',
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  ...nativeEn,
  'common.cancel': 'Cancel',
  'common.loading': 'Loading…',
  'lang.aria': 'Switch interface language',

  'header.connConnected': 'MCP connected',
  'header.connConnecting': 'Connecting…',
  'header.connDisconnected': 'MCP disconnected',
  'header.newTask': 'New task',
  'header.new': 'New',
  'header.switchBoardAria': 'Switch repository board',
  'header.addBoard': 'Add repository',
  'header.moreAria': 'More actions',
  'header.refresh': 'Refresh',
  'header.searchPlaceholder': 'Search ID / title / branch…',
  'header.searchAria': 'Search tasks',
  'header.boardOption': '{name} ({count})',
  'header.boardOptionNonGit': '{name} ({count} · non-Git)',
  'header.themeLightAria': 'Switch to light theme',
  'header.themeDarkAria': 'Switch to dark theme',
  'header.themeLight': 'Light theme',
  'header.themeDark': 'Dark theme',
  'settings.aria': 'Settings',
  'menu.theme': 'Theme',
  'menu.language': 'Language',

  'status.backlog': 'Backlog',
  'status.ready': 'Ready',
  'status.doing': 'Doing',
  'status.review': 'Review',
  'status.done': 'Done',

  'exec.idle': 'Idle',
  'exec.assigned': 'Assigned',
  'card.execTag': 'Exec',
  'card.reviewTag': 'Review',
  'exec.starting': 'Starting',
  'exec.running': 'Running',
  'exec.waiting': 'Waiting for input',
  'exec.blocked': 'Blocked',
  'exec.failed': 'Failed',
  'exec.completed': 'Completed',

  'event.created': 'Created',
  'event.assigned': 'Assigned',
  'event.started': 'Started',
  'event.activity': 'Activity',
  'event.waiting': 'Waiting for input',
  'event.blocked': 'Execution blocked',
  'event.failed': 'Failed',
  'event.completed': 'Completed',
  'event.stopped': 'Stopped',
  'event.moved': 'Status changed',

  'card.human': 'Human',
  'card.start': 'Start',
  'card.waiting': 'Waiting for input',
  'card.reply': 'Reply',
  'card.failed': 'Failed',
  'card.retry': 'Retry',
  'card.readyForReview': 'Done, ready for review',
  'card.reviewChanges': 'Review changes',
  'card.completed': 'Completed',
  'card.taskAria': 'Task {id}: {title}',
  'card.files': '{count} files',
  'card.overdue': 'overdue',

  'reportCard.aria': 'TaskLane execution report card',
  'reportCard.label': 'Execution report',
  'reportCard.loading': 'Loading execution report…',
  'reportCard.openDetail': 'View details',
  'reportCard.opening': 'Opening…',
  'reportCard.unsupported': 'This host cannot expand task details. The execution report remains available.',
  'reportCard.refused': 'The host did not allow task details to open. Please retry. The execution report remains available.',
  'reportCard.contextChanged': 'The report context changed. Open details again from the current card.',

  'detail.closeAria': 'Close details',
  'detail.copyIdAria': 'Copy task ID',
  'detail.idCopied': 'Copied {id}',
  'detail.titleAria': 'Task title',
  'detail.statusAria': 'Task status',
  'detail.priorityAria': 'Priority',
  'detail.deadlineAria': 'Deadline',
  'detail.deadlineClear': 'Clear',
  'detail.fieldStatus': 'Status',
  'detail.fieldPriority': 'Priority',
  'detail.fieldDeadline': 'Deadline',
  'detail.fieldDescription': 'Description',
  'detail.notDirect': ' (not directly reachable)',
  'detail.descPlaceholder': 'Add context (Markdown)…',
  'detail.assignedTo': 'Handled by',
  'detail.agentState': 'Agent · {state}',
  'detail.currentActivity': 'Current activity',
  'detail.started': 'Started',
  'detail.session': 'Session',
  'detail.failNoteWithActivity': 'Execution failed: {activity} — retry or open the session to investigate',
  'detail.failNote': 'Execution failed — retry or open the session to investigate',
  'detail.waitNote': 'The agent is waiting for your input; reply to continue',
  'detail.timeline': 'Execution timeline',
  'detail.gitContext': 'Git context',
  'detail.repo': 'Repo',
  'detail.base': 'Base',
  'detail.branch': 'Branch',
  'detail.worktree': 'Worktree',
  'detail.changeSummary': 'Change summary',
  'detail.filesChanged': '{count} files changed',
  'detail.testsPassing': 'tests ✓',
  'detail.testsFailing': 'tests ✗',
  'detail.testsUnknown': 'tests ?',
  'detail.openDiff': 'Open diff',
  'detail.worktreeCopied': 'Worktree path copied; open the full diff in your editor',
  'detail.noGitContext': 'This task has no Git context (repo not configured)',
  'detail.noChanges': 'No changes yet (no Git context or not yet in review)',
  'detail.openSession': 'Open session',
  'detail.openAgentSession': 'Open agent session',
  'detail.markDone': 'Mark done',
  'detail.reopen': 'Reopen (back to review)',
  'detail.delete': 'Delete task',
  'detail.deleteConfirm': 'Delete this task? The task and its execution timeline will be removed and cannot be recovered.',
  'detail.deleteDone': '{id} deleted',

  'form.closeAria': 'Close the new task form',
  'form.titleLabel': 'Title *',
  'form.titlePlaceholder': 'e.g. Add OAuth callback handler',
  'form.descPlaceholder': 'Optional; Markdown. The agent reads it via MCP',
  'form.initialStatus': 'Initial status',
  'form.deadline': 'Deadline (optional)',
  'form.plainHint': 'New tasks stay marked Human. Run from the details to submit an execution request and mark the task as Agent.',
  'form.create': 'Create',
  'form.noTaskId': 'task_create did not return a task ID',

  'tabs.aria': 'Task status navigation',
  'tabs.reviewDot': 'Awaiting review',
  'list.projectErrorTitle': 'Failed to open the project board',
  'list.projectErrorDesc':
    'The workspace of this chat cannot be resolved to a Git repository board (invalid path or base branch mismatch). Fix it and reopen; it will not fall back to another repository.',
  'list.boardsErrorTitle': 'Failed to load the board list',
  'list.loadingAria': 'Loading',
  'list.noBoardsTitle': 'No boards yet',
  'list.noBoardsDesc': 'Click ⊞ at the top to add a local Git repository and start managing its task board.',
  'list.noTasksTitle': 'No tasks yet',
  'list.noTasksDesc': 'Create the first task or start from a sample template.',
  'list.emptyDoing': 'No tasks in progress',
  'list.emptyReview': 'No changes awaiting review',
  'list.emptyOther': 'No tasks in this status',
  'list.viewReady': 'View Ready',
  'list.listAria': '{status} task list',
  'list.tpl1': 'Add OAuth callback handler with state validation',
  'list.tpl2': 'Write unit tests for auth module',
  'list.tpl3': 'Refactor board store for pagination',

  'board.colAria': '{status} column',
  'board.dropHint': 'Drop to change task status (does not start execution)',

  'banner.connecting': 'Connecting to the MCP server…',
  'banner.disconnected':
    'MCP connection lost: the list is a read-only cache and actions are disabled; reconnecting…',
  'banner.note': 'A connection error ≠ a task failure; already executed actions are unaffected',

  'add.closeAria': 'Close the add repository form',
  'add.repoPathLabel': 'Absolute project directory path *',
  'add.repoPathPlaceholder': 'e.g. /Users/you/projects/my-repo',
  'add.browse': 'Browse…',
  'add.browseTitle': 'Browse local directories to pick a Git repository',
  'add.nameLabel': 'Board name',
  'add.namePlaceholder': 'Optional; defaults to the repository directory name',
  'add.baseLabel': 'Base branch',
  'add.basePickedPlaceholder': 'Detected from the repository branch: {branch}',
  'add.basePlaceholder': 'Defaults to main; use the current branch for empty repositories',
  'add.basePickedTitle':
    'Base branch detection: prefer main, then master; use the current branch for empty repositories, otherwise default to main',
  'add.baseTitle':
    'With commits it must be an existing local branch; for empty repositories it must match the current branch',
  'add.hint':
    'Register a local project directory as a new board; Git subdirectories, symlinks and worktrees are resolved to the main repository. Plain non-Git directories can be added too (Git branch and worktree features stay unavailable until Git is initialized). Registering the same repository or directory again just switches to its existing board. Repositories without commits can be added; the first commit is only required before creating a task worktree.',
  'add.nonGitHint': 'Detected as a non-Git directory: it will be registered by project directory; Git branch management and worktree creation are unavailable, while tasks still execute and review in that directory.',
  'add.registering': 'Registering…',
  'add.submit': 'Add',

  'picker.title': 'Select a repository',
  'picker.cancelAria': 'Cancel repository selection',
  'picker.upAria': 'Go to the parent directory',
  'picker.upTitle': 'Parent directory',
  'picker.jumpTo': 'Go to {path}',
  'picker.readFailed': 'Failed to read the directory: {error}',
  'picker.reading': 'Reading directory…',
  'picker.noSubdirs': 'No visible subdirectories in this folder',
  'picker.subdirsAria': 'Subdirectory list',
  'picker.useRepo': 'Use repository {path} (base: {branch})',
  'picker.useCurrent': 'Use current directory {path}',
  'picker.useCurrentTitle': 'Add the current directory as a project (non-Git directories work too)',
  'picker.enter': 'Enter {name}',
  'picker.hint':
    'Click a Git repository to select it; click a regular folder to descend, or use the bottom button to add the current directory as a project. Hidden directories are not shown.',

  'toast.mcpOk': '{call} OK',
  'toast.replyPromptLabel': 'Reply to the agent (full text is preserved)',
  'toast.projectLockedSwitch':
    'Project mode locks the current repository board; open the global board entry to switch',
  'toast.projectLockedAdd':
    'Project mode locks the current repository board; open the global board entry to add repositories',
  'toast.boardCreateNoId': 'board_create did not return a board ID',
  'mcp.notConnected': 'MCP not connected',

  'time.justNow': 'just now',
  'time.ago': '{time} ago',

  // Task archiving
  'archive.action': 'Archive',
  'archive.archivedChip': 'Archived',
  'archive.archivedAgo': 'Archived {time}',
  'detail.archivedBanner': 'Archived {time} — read-only; restoring returns it to Done',
  'detail.restoreToDone': 'Restore to Done',
  'header.archived': 'Archived',
  'header.archivedAria': 'Archived tasks ({count})',
  'archive.viewTitle': 'Archived · {name}',
  'archive.searchPlaceholder': 'Search ID / title…',
  'archive.searchAria': 'Search archived tasks',
  'archive.closeAria': 'Close archived list',
  'archive.emptyTitle': 'No archived tasks yet',
  'archive.emptySearchTitle': 'No matching archived tasks',
  'archive.emptySearchDesc': 'Try another keyword, or clear the search to see all archived tasks.',
  'archive.readErrorTitle': 'Failed to load archived list',
  'archive.restore': 'Restore to Done',
  'archive.cardAria': 'Task {id}: {title}',
  'archiveAll.button': 'Archive all done ({count})',
  'archiveAll.buttonEmpty': 'Archive all done',
  'archiveAll.confirmText': 'Archive all {count} done tasks of board "{name}"?',
  'archiveAll.confirm': 'Archive',
  'archiveAll.busy': 'Archiving…',
  'archiveAll.done': 'Archived {count} done tasks',
  'archiveAll.noBoard': 'No board selected',
  'event.archived': 'Archived',
  'event.restored': 'Restored',

  // Export report (task_export)
  'header.export': 'Export report',
  'export.title': 'Export Markdown report',
  'export.closeAria': 'Close export panel',
  'export.boardLabel': 'Board',
  'export.startLabel': 'Start date',
  'export.endLabel': 'End date',
  'export.scopeLabel': 'Task scope',
  'export.scopeAll': 'All (incl. archived)',
  'export.scopeActive': 'Active only',
  'export.scopeArchived': 'Archived only',
  'export.quickMonth': 'Last month',
  'export.quickThisMonth': 'This month',
  'export.quickLastMonth': 'Previous month',
  'export.hint': 'Defaults to one month back from today (local calendar days, inclusive); a task is exported when created, updated, or archived within the range.',
  'export.invalidRange': 'Start date cannot be later than end date',
  'export.submit': 'Generate report',
  'export.submitting': 'Generating…',
  'export.pathLabel': 'File path',
  'export.pathCopy': 'Copy path',
  'export.pathCopied': 'Copied',
  'export.pathCopyFailed': 'Clipboard blocked by the host — select the path and copy manually',
  'export.failed': 'Export failed',
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh, en };

/** 状态/事件枚举到字典键的映射：组件用 t(statusKey(s)) 取词，未知事件回退原始 kind */
const STATUS_KEYS: Record<TaskStatus, MessageKey> = {
  backlog: 'status.backlog',
  ready: 'status.ready',
  doing: 'status.doing',
  review: 'status.review',
  done: 'status.done',
};

const EVENT_KEYS: Record<string, MessageKey> = {
  created: 'event.created',
  assigned: 'event.assigned',
  started: 'event.started',
  activity: 'event.activity',
  waiting: 'event.waiting',
  blocked: 'event.blocked',
  failed: 'event.failed',
  completed: 'event.completed',
  stopped: 'event.stopped',
  moved: 'event.moved',
  archived: 'event.archived',
  restored: 'event.restored',
  execution_requested: 'native.event.requested',
  execution_delivered: 'native.event.delivered',
  execution_claimed: 'native.event.claimed',
  execution_created: 'native.event.created',
  execution_bound: 'native.event.bound',
  execution_uncertain: 'native.event.uncertain',
  execution_rejected: 'native.event.rejected',
  execution_blocked: 'native.event.blocked',
  execution_recovered: 'native.event.recovered',
  review_round: 'native.event.reviewRound',
  review_updated: 'native.event.reviewUpdated',
  execution_external_bound: 'native.event.externalBound',
};

const EXEC_KEYS: Record<string, MessageKey> = {
  idle: 'exec.idle',
  assigned: 'exec.assigned',
  starting: 'exec.starting',
  running: 'exec.running',
  waiting: 'exec.waiting',
  blocked: 'exec.blocked',
  failed: 'exec.failed',
  completed: 'exec.completed',
};

export function statusKey(status: TaskStatus): MessageKey {
  return STATUS_KEYS[status];
}

export function eventKey(kind: string): MessageKey | null {
  return EVENT_KEYS[kind] ?? null;
}

export function execKey(state: string): MessageKey | null {
  return EXEC_KEYS[state] ?? null;
}

function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  // 缺参时保留占位符原样，便于发现漏传而不是渲染成 undefined
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

/** 首次语言：本地保存 > 浏览器语言（zh* 视为中文）> 默认中文 */
function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem('tasklane-lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* localStorage 不可用（如隐私模式）只影响记忆，不影响检测 */
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * 模块级当前语言：供 React 之外的调用点（client 错误消息、timeAgo 等）取词。
 * LangProvider 切换语言时同步更新；组件内请优先用 useLang().t（随重渲染刷新）。
 */
let currentLang: Lang = detectInitialLang();

export function getCurrentLang(): Lang {
  return currentLang;
}

/** 纯函数取词：非 React 代码路径使用；语言切换由 LangProvider 驱动 */
export function translate(key: MessageKey, params?: MessageParams): string {
  return format(MESSAGES[currentLang][key], params);
}

/** 供 LangProvider 在语言变化时同步模块级状态与 <html lang> */
export function applyLang(next: Lang): void {
  currentLang = next;
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  try {
    localStorage.setItem('tasklane-lang', next);
  } catch {
    /* 存储不可用只影响记忆，不影响本次会话的语言切换 */
  }
}
