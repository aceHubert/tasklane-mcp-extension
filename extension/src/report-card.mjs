/**
 * task_execution_report 成功结果的报告卡片字段组装（插件侧 builder）。
 *
 * 独立成模块以便单测：不依赖 ext-apps 与 SDK，纯字段推导。复用 open_tasklane
 * 的 widgetData 结构，附带只读快照供聊天卡片展示；点击后才聚焦任务详情：
 * - boardHome = 数据目录；lockedBoardId = 任务归属看板；
 * - repoRoot = 看板记录的仓库绝对路径，缺仓库时回退请求仓库、绑定工作区；
 * - projectDir 优先执行绑定 workspacePath（保留 worktree 视角），回退 repoRoot。
 * 任一路径无法解析为绝对路径时返回 null，调用方保持纯结果，不阻塞回执。
 */

/** 为独立报告入口预先设置卡片模式；模板异常时拒绝返回完整看板。 */
export function reportWidgetHtml(html) {
  const head = /<head(?:\s[^>]*)?>/i;
  if (!head.test(html)) throw new Error('报告模板缺少 head，无法安全初始化任务卡片');
  return html.replace(head, (tag) => `${tag}<script>globalThis.__TASKLANE_REPORT_CARD__=true;document.documentElement.dataset.reportCard='true';</script>`);
}

/**
 * @param {{
 *   result: {
 *     task?: { id?: string, boardId?: string, title?: string, priority?: string, updatedAt?: string,
 *       execution?: { state?: string, activity?: string, updatedAt?: string },
 *       reviewExecution?: { state?: string, activity?: string, updatedAt?: string },
 *       executionBinding?: { workspacePath?: string }, reviewBinding?: { workspacePath?: string } },
 *     request?: { repo?: string, purpose?: string, status?: string, updatedAt?: string },
 *   },
 *   boardHome: string,
 *   store?: { getBoard(id: string): { repo?: string | null, projectDir?: string | null } | undefined },
 *   clientVersion?: () => { name?: string, version?: string } | undefined,
 * }} options
 * @returns {Record<string, unknown> | null}
 */
export function reportWidgetData({ result, boardHome, store, clientVersion }) {
  const task = result?.task;
  const request = result?.request;
  if (!task?.id || !task.boardId || !request) return null;
  const isReview = request.purpose === "review";
  const binding = isReview ? task.reviewBinding : task.executionBinding;
  const execution = isReview ? task.reviewExecution : task.execution;
  const absolute = (...candidates) =>
    candidates.find((value) => typeof value === "string" && value.startsWith("/")) ?? null;
  const board = store?.getBoard?.(task.boardId);
  const repoRoot = absolute(board?.repo, board?.projectDir, request.repo, binding?.workspacePath);
  const projectDir = absolute(binding?.workspacePath, repoRoot);
  if (!repoRoot || !projectDir) return null;
  const peer = typeof clientVersion === "function" ? clientVersion() : undefined;
  return {
    version: 2,
    widget: "tasklane-board",
    title: "TaskLane",
    rendering: "native-widget",
    mode: "project",
    boardHome,
    lockedBoardId: task.boardId,
    repoRoot,
    projectDir,
    taskId: task.id,
    presentation: "report-card",
    reportCard: {
      taskId: task.id,
      title: task.title ?? task.id,
      priority: task.priority ?? "P2",
      state: execution?.state ?? request.status ?? "idle",
      activity: execution?.activity,
      updatedAt: execution?.updatedAt ?? request.updatedAt ?? task.updatedAt ?? "",
    },
    ...(peer ? { mcpClient: { name: peer.name, version: peer.version } } : {}),
  };
}
