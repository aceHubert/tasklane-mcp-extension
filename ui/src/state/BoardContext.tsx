import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { McpClient, type ConnState, type BoardClient } from '../mcp/client';
import { McpAppsClient, hasMcpAppsHost, isReportCardResource, type ExecutionReportSnapshot, type WidgetContext } from '../mcp/appsClient';
import { useLang } from '../i18n';
import { emptyHostSnapshot, type ExecutionHost, type HostSnapshot } from '../host';
import { translate } from '../i18n/messages';
import type { BoardSummary, TaskStatus, TaskDetailPayload, WorkItem } from '../mcp/types';

export interface Toast {
  id: number;
  kind: 'ok' | 'err';
  text: string;
}

export interface AddBoardInput {
  repo: string;
  name?: string;
  baseBranch?: string;
}

export type AddBoardResult = { ok: true; boardId: string } | { ok: false; error: string };

/** 项目模式的锁定上下文（open_tasklane 返回，widget 实例独立持有） */
export interface ProjectContext {
  /** 聊天所在工作区（保留 worktree/子目录原始路径，不等同于主仓库） */
  projectDir: string;
  /** 看板对应的主仓库根目录 */
  repoRoot: string;
  /** 锁定的看板 ID：刷新/重连始终恢复它，不受全局选择影响 */
  lockedBoardId: string;
  boardName?: string;
}

export type WidgetMode = 'global' | 'project' | 'project-error';

interface BoardContextValue {
  conn: ConnState;
  executionHost: ExecutionHost | null;
  hostSnapshot: HostSnapshot;
  isCurrentBoard(id: string): boolean;
  /** 全部看板（board_list 结果，含各自计数） */
  boards: BoardSummary[];
  /** 当前选择的看板 ID（项目模式恒为 lockedBoardId；全局模式为本浏览器选择） */
  boardId: string | null;
  /** 当前看板对象（boards 中 boardId 对应项） */
  board: BoardSummary | null;
  /** 看板列表读取失败的错误信息（断连由 conn 横幅单独提示） */
  boardsError: string | null;
  /** widget 打开模式：项目入口锁定单仓库；全局入口可添加切换；独立 bridge 恒为 global */
  widgetMode: WidgetMode;
  /** 项目模式上下文；global / project-error 时为 null */
  projectCtx: ProjectContext | null;
  /** 报告资源初始显示紧凑卡片；仅点击并获宿主确认后进入完整看板。 */
  reportCardVisible: boolean;
  reportCard: ExecutionReportSnapshot | null;
  reportCardError: string | null;
  reportCardOpening: boolean;
  openReportDetail(): Promise<void>;
  tasks: WorkItem[];
  loading: boolean;
  activeTab: TaskStatus;
  search: string;
  toasts: Toast[];
  detailId: string | null;
  detail: TaskDetailPayload | null;
  /** 归档视图是否打开（独立入口，不占用业务状态 Tab） */
  archiveOpen: boolean;
  /** 当前看板的归档任务（archive=archived 查询；失败保留原列表） */
  archivedTasks: WorkItem[];
  archiveLoading: boolean;
  archiveError: string | null;
  /** 归档视图专属搜索：只作用于归档列表，不与普通视图混用 */
  archiveSearch: string;
  setActiveTab(tab: TaskStatus): void;
  setSearch(q: string): void;
  openDetail(id: string | null): void;
  setArchiveOpen(open: boolean): void;
  setArchiveSearch(q: string): void;
  /** 批量归档当前看板全部未归档 done 任务；成功提示实际数量并刷新 */
  archiveAllDone(): Promise<boolean>;
  switchBoard(id: string): void;
  addBoard(input: AddBoardInput): Promise<AddBoardResult>;
  refresh(): Promise<void>;
  mutate(fn: () => Promise<unknown>, okText?: string): Promise<boolean>;
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  toast(kind: Toast['kind'], text: string): void;
}

const BoardContext = createContext<BoardContextValue | null>(null);

const POLL_MS = 4000;
/** 浏览器本地保存的当前看板选择；刷新后先验证 ID 仍存在再恢复 */
const BOARD_STORAGE_KEY = 'tasklane-board-id';

export function BoardProvider({ children }: { children: ReactNode }) {
  const { t } = useLang();
  // client 按运行环境异步创建：侧栏嵌入（MCP Apps 宿主）立即用宿主桥；
  // 独立模式等 /api/config（token 模式需要 ?token=）后建 WebSocket 客户端
  const [client, setClient] = useState<BoardClient | null>(null);

  const [conn, setConn] = useState<ConnState>('connecting');
  const [hostSnapshot, setHostSnapshot] = useState<HostSnapshot>(emptyHostSnapshot);
  const executionHost = client instanceof McpAppsClient ? client : null;
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [boardsError, setBoardsError] = useState<string | null>(null);
  const [widgetMode, setWidgetMode] = useState<WidgetMode>('global');
  const [projectCtx, setProjectCtx] = useState<ProjectContext | null>(null);
  const [reportCardVisible, setReportCardVisible] = useState(isReportCardResource);
  const [reportCard, setReportCard] = useState<ExecutionReportSnapshot | null>(null);
  const [reportCardError, setReportCardError] = useState<string | null>(null);
  const [reportCardOpening, setReportCardOpening] = useState(false);
  const reportCardVisibleRef = useRef(isReportCardResource());
  const reportCardRef = useRef<ExecutionReportSnapshot | null>(null);
  const reportOpenSeqRef = useRef(0);
  const reportCardOpeningRef = useRef(false);
  const [tasks, setTasks] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TaskStatus>('doing');
  const [search, setSearch] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null);
  /** 报告卡片待聚焦任务（widget 上下文 taskId）：锁定看板任务加载完成后消费 */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpenState] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState<WorkItem[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSearch, setArchiveSearch] = useState('');

  // ref 与 state 同步维护：异步回调比对"发起时的看板 + 最新请求代次"，丢弃串板响应
  const boardIdRef = useRef<string | null>(null);
  const detailIdRef = useRef<string | null>(null);
  /** 已聚焦过的任务：同一 widget 实例内重复上下文不重复打开详情 */
  const focusedTaskRef = useRef<string | null>(null);
  /** 列表请求代次：每次发起新请求自增；旧响应（含 board_list → task_list 间隙的切换）一律作废 */
  const listSeqRef = useRef(0);
  /** 详情请求代次：旧响应后到不得覆盖新响应或回填已切换的详情 */
  const detailSeqRef = useRef(0);
  /** 归档列表请求代次：切换看板/关闭视图时作废在途响应 */
  const archiveSeqRef = useRef(0);
  /** 归档视图开关的同步镜像：轮询据此决定是否顺带刷新归档列表 */
  const archiveOpenRef = useRef(false);
  /** widget 模式的同步镜像：refresh / 切换 / 注册的守卫依据，避免 setState 异步间隙误判 */
  const widgetModeRef = useRef<WidgetMode>('global');
  const projectCtxRef = useRef<ProjectContext | null>(null);

  /** 所有 boardId 变更的唯一入口：ref 立即生效，避免 setState 异步间隙读到旧值 */
  const applyBoardSelection = useCallback((id: string | null) => {
    boardIdRef.current = id;
    setBoardId(id);
    // 项目模式的选择不属于全局模式：不写入共享的 localStorage 选择
    if (id && widgetModeRef.current !== 'project') localStorage.setItem(BOARD_STORAGE_KEY, id);
  }, []);

  /** 清空列表/详情/搜索并按代次加载目标看板任务（切换与项目锁定共用） */
  const loadBoardTasks = useCallback(
    (id: string) => {
      const seq = ++listSeqRef.current;
      setTasks([]);
      detailIdRef.current = null;
      setDetailId(null);
      setDetail(null);
      setSearch('');
      setActiveTab('doing');
      // 归档视图随看板切换关闭并清空：旧看板的归档列表/搜索不得串入新看板
      archiveOpenRef.current = false;
      setArchiveOpenState(false);
      archiveSeqRef.current += 1;
      setArchivedTasks([]);
      setArchiveError(null);
      setArchiveSearch('');
      setLoading(true);
      void (async () => {
        try {
          const listRes = await client?.call<{ tasks: WorkItem[] }>('task_list', { boardId: id });
          if (seq !== listSeqRef.current || boardIdRef.current !== id) return;
          setTasks(listRes?.tasks ?? []);
        } catch {
          /* 加载失败由轮询与断连横幅兜底 */
        } finally {
          if (seq === listSeqRef.current) setLoading(false);
        }
      })();
    },
    [client],
  );

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600);
  }, []);

  /** 归档列表加载：代次 + 看板双重校验；失败保留原列表并记录错误（不伪装为空） */
  const refreshArchived = useCallback(async () => {
    if (!client) return;
    const id = boardIdRef.current;
    if (!id) {
      setArchivedTasks([]);
      return;
    }
    const seq = ++archiveSeqRef.current;
    setArchiveLoading(true);
    try {
      const res = await client.call<{ tasks: WorkItem[] }>('task_list', { boardId: id, archive: 'archived' });
      if (seq !== archiveSeqRef.current || boardIdRef.current !== id) return;
      setArchivedTasks(res?.tasks ?? []);
      setArchiveError(null);
    } catch (err) {
      if (seq !== archiveSeqRef.current) return;
      setArchiveError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === archiveSeqRef.current) setArchiveLoading(false);
    }
  }, [client]);

  const refresh = useCallback(async () => {
    if (!client) return;
    // 会话报告只读工具回执快照，不在用户点击前请求完整看板或详情。
    if (reportCardVisibleRef.current) return;
    // 项目打开失败：保持错误空态，不请求任务（不显示其他仓库任务）
    if (widgetModeRef.current === 'project-error') return;
    const seq = ++listSeqRef.current;
    try {
      const boardRes = await client.call<{ boards: BoardSummary[] }>('board_list');
      if (seq !== listSeqRef.current) return;
      const list = boardRes?.boards ?? [];
      setBoards(list);
      setBoardsError(null);

      // 项目模式：目标固定 lockedBoardId，不读 localStorage、不回退第一个可用看板
      let target: string | null;
      if (widgetModeRef.current === 'project' && projectCtxRef.current) {
        target = projectCtxRef.current.lockedBoardId;
      } else {
        // 恢复/校验当前选择：已保存的选择失效时退回第一个可用看板（仅全局模式）
        const cur = boardIdRef.current;
        if (!cur || !list.some((b) => b.id === cur)) {
          const saved = localStorage.getItem(BOARD_STORAGE_KEY);
          const next = saved && list.some((b) => b.id === saved) ? saved : list[0]?.id ?? null;
          applyBoardSelection(next);
        }
        target = boardIdRef.current;
      }

      if (!target) {
        setTasks([]);
        return;
      }
      const listRes = await client.call<{ tasks: WorkItem[] }>('task_list', { boardId: target });
      // 仍匹配当前选择及最新请求的响应才允许更新画面（覆盖 A → B → A 快速切换）
      if (seq !== listSeqRef.current || boardIdRef.current !== target) return;
      setTasks(listRes?.tasks ?? []);
      // 归档视图打开时随轮询一起刷新；关闭时不多发请求
      if (archiveOpenRef.current) void refreshArchived();
    } catch (err) {
      // 断连/失败时保留缓存数据，由 conn 横幅提示；只有从未加载成功时展示错误态
      if (seq === listSeqRef.current && boards.length === 0) {
        setBoardsError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, [client, boards.length, applyBoardSelection, refreshArchived]);

  const refreshDetail = useCallback(async () => {
    if (!client) return;
    const id = detailIdRef.current;
    const seq = ++detailSeqRef.current;
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      // task_get 省略 boardId：任务 ID 全局唯一，服务端按任务自身归属校验
      const payload = await client.call<TaskDetailPayload>('task_get', { id });
      // 代次 + 目标双重校验：同一详情的并发刷新/旧响应后到都不覆盖新数据
      if (seq === detailSeqRef.current && detailIdRef.current === id) setDetail(payload);
    } catch {
      /* keep stale */
    }
  }, [client]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshDetail()]);
  }, [refresh, refreshDetail]);

  /** 切换仓库看板：立即清空旧看板的任务/详情/搜索状态（表单经 boardId key 重置）。项目模式（含打开失败）禁止切换。 */
  const switchBoard = useCallback(
    (id: string) => {
      if (widgetModeRef.current !== 'global') {
        // 隐藏入口之外的兜底守卫（不只是隐藏按钮）
        toast('err', t('toast.projectLockedSwitch'));
        return;
      }
      if (id === boardIdRef.current) return;
      applyBoardSelection(id);
      loadBoardTasks(id);
    },
    [applyBoardSelection, client, loadBoardTasks, toast, t],
  );

  /**
   * 应用 widget 打开上下文（open_tasklane 结果，宿主 toolresult 送达或 sessionStorage 恢复）：
   * - project：锁定 lockedBoardId（不读写全局 localStorage），刷新/重连始终恢复它
   * - project-error：保持错误空态并禁用写操作，不显示其他仓库任务
   * - global：全局模式（独立 bridge 模式无上下文，默认即全局）
   */
  const applyWidgetContext = useCallback(
    (ctx: WidgetContext) => {
      const report = ctx.presentation === 'report-card' || isReportCardResource();
      reportCardVisibleRef.current = report;
      setReportCardVisible(report);
      reportCardRef.current = report ? ctx.reportCard ?? null : null;
      setReportCard(reportCardRef.current);
      setReportCardError(ctx.error ?? null);
      reportOpenSeqRef.current += 1;
      reportCardOpeningRef.current = false;
      setReportCardOpening(false);
      if (report) {
        // 新报告回执撤销旧详情及在途读取，避免卡片未点击就打开上轮任务。
        listSeqRef.current += 1;
        detailSeqRef.current += 1;
        detailIdRef.current = null;
        setDetailId(null);
        setDetail(null);
        setTasks([]);
        setPendingFocus(null);
        setLoading(false);
      }
      if (ctx.error) {
        widgetModeRef.current = 'project-error';
        setWidgetMode('project-error');
        projectCtxRef.current = null;
        setProjectCtx(null);
        // 作废在途响应并清空画面：不显示任何仓库任务
        listSeqRef.current += 1;
        setTasks([]);
        detailIdRef.current = null;
        setDetailId(null);
        setDetail(null);
        setPendingFocus(null);
        setLoading(false);
        return;
      }
      if (ctx.mode === 'project' && ctx.lockedBoardId) {
        widgetModeRef.current = 'project';
        setWidgetMode('project');
        const next: ProjectContext = {
          projectDir: ctx.projectDir ?? '',
          repoRoot: ctx.repoRoot ?? '',
          lockedBoardId: ctx.lockedBoardId,
          boardName: ctx.boardName,
        };
        projectCtxRef.current = next;
        setProjectCtx(next);
        // 普通看板入口保留 taskId 聚焦；报告入口必须等待用户点击卡片。
        setPendingFocus(report ? null : ctx.taskId ?? null);
        // 旧异步响应不能替换新 widget 的项目：即使全局模式已选中其他看板也强制回到锁定看板
        if (boardIdRef.current !== next.lockedBoardId) {
          applyBoardSelection(next.lockedBoardId);
          if (!report) loadBoardTasks(next.lockedBoardId);
        }
        return;
      }
      widgetModeRef.current = 'global';
      setWidgetMode('global');
      projectCtxRef.current = null;
      setProjectCtx(null);
      setPendingFocus(null);
    },
    [applyBoardSelection, loadBoardTasks],
  );

  /**
   * 添加仓库（board_create）：成功或仓库已存在时切换到目标看板；
   * 失败时返回错误信息，调用方保留输入、不切换看板。项目模式锁定禁止添加。
   */
  const addBoard = useCallback(
    async (input: AddBoardInput): Promise<AddBoardResult> => {
      if (widgetModeRef.current !== 'global') {
        return { ok: false, error: t('toast.projectLockedAdd') };
      }
      if (!client) return { ok: false, error: translate('mcp.notConnected') };
      try {
        const res = await client.call<{ board: BoardSummary }>('board_create', {
          repo: input.repo,
          name: input.name,
          baseBranch: input.baseBranch,
        });
        const newId = res?.board?.id;
        if (!newId) return { ok: false, error: t('toast.boardCreateNoId') };
        toast('ok', t('toast.mcpOk', { call: `board_create(${res.board.name})` }));
        switchBoard(newId);
        // 立即重读看板列表：选择器不用等下一轮轮询就能看到新看板
        void refresh();
        return { ok: true, boardId: newId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [client, switchBoard, refresh, toast, t],
  );

  // 连接初始化：宿主侧栏（MCP Apps）先恢复/接收 open_tasklane 的 widget 上下文
  // （项目或全局模式），再用注入的宿主桥调同一 MCP server；
  // 独立模式先取 bridge 连接配置（token 模式需 ?token=），再建 WebSocket 客户端。
  // 配置获取失败（纯静态部署）按无 token 处理。
  // 注意依赖必须为空：applyWidgetContext → loadBoardTasks → client，若直接依赖
  // 会形成"创建 client → 依赖变化 → 再创建"的无限循环；经 ref 引用最新实现。
  const applyWidgetContextRef = useRef(applyWidgetContext);
  applyWidgetContextRef.current = applyWidgetContext;
  useEffect(() => {
    if (hasMcpAppsHost()) {
      const c = new McpAppsClient();
      // iframe 重载场景先从会话缓存恢复锁定；宿主 toolresult 到达后覆盖为本次打开上下文
      const cached = c.initialWidgetContext;
      if (cached) applyWidgetContextRef.current(cached);
      c.onWidgetContext = (ctx) => applyWidgetContextRef.current(ctx);
      c.onHostSnapshot = setHostSnapshot;
      c.onDisplayMode = (mode) => {
        if (mode !== 'inline' || !reportCardRef.current) return;
        reportCardVisibleRef.current = true;
        setReportCardVisible(true);
        detailSeqRef.current += 1;
        detailIdRef.current = null;
        setDetailId(null);
        setDetail(null);
      };
      setClient(c);
      return;
    }
    let cancelled = false;
    void (async () => {
      let token: string | null = null;
      try {
        const res = await fetch('/api/config');
        if (res.ok) token = (await res.json())?.token ?? null;
      } catch {
        /* 无 bridge 配置端点，按默认连接 */
      }
      if (cancelled) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const query = token ? `?token=${encodeURIComponent(token)}` : '';
      setClient(new McpClient(`${proto}://${location.host}/mcp${query}`, () => {}));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 连接 + 轮询（人和 agent 操作同一份数据，轮询保证 UI 跟随 agent 变化）。
  // 列表与打开中的详情一起刷新：外部客户端把任务改为 Doing/Failed 后，详情不再停留在旧状态。
  // 重连恢复后重读看板列表与当前仓库任务（其他客户端可能已注册新看板）。
  // refreshAll 经 ref 引用：其身份随 boards.length 等状态变化，直接进依赖会让
  // 本 effect 重跑并重复 connect，叠加出多条 WebSocket 连接（清理只清了轮询）。
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  useEffect(() => {
    if (!client) return;
    client.onState = (s) => {
      setConn(s);
      if (s === 'connected') void refreshAllRef.current();
    };
    client.connect();
    const pollData = setInterval(() => {
      if (client instanceof McpAppsClient) setHostSnapshot(client.getSnapshot());
      if (client.connectionState === 'connected') void refreshAllRef.current();
    }, POLL_MS);
    void refreshAllRef.current();
    return () => clearInterval(pollData);
  }, [client]);

  useEffect(() => {
    void refreshDetail();
  }, [detailId, refreshDetail]);

  const mutate = useCallback(
    async (fn: () => Promise<unknown>, okText?: string) => {
      try {
        await fn();
        if (okText) toast('ok', okText);
        await refreshAll();
        return true;
      } catch (err) {
        toast('err', err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [refreshAll, toast],
  );

  const openDetail = useCallback((id: string | null) => {
    detailSeqRef.current += 1; // 作废在途 task_get：旧响应不得回填到新打开的详情
    const changed = detailIdRef.current !== id;
    detailIdRef.current = id;
    setDetailId(id);
    // 切换目标（或关闭）时清掉已加载的旧详情：新详情到达前抽屉显示加载态，
    // 不能继续展示/可编辑上一个任务的字段；重复打开同一任务不清（避免闪烁）
    if (changed || !id) setDetail(null);
  }, []);

  const openReportDetail = useCallback(async () => {
    const card = reportCardRef.current;
    const lockedBoardId = projectCtxRef.current?.lockedBoardId;
    if (!(client instanceof McpAppsClient) || !card || !lockedBoardId || reportCardOpeningRef.current) return;
    const seq = ++reportOpenSeqRef.current;
    const version = client.getSnapshot().contextVersion;
    setReportCardOpening(true);
    reportCardOpeningRef.current = true;
    setReportCardError(null);
    try {
      await client.expandReportCard(version, card.taskId, lockedBoardId);
      if (seq !== reportOpenSeqRef.current || reportCardRef.current !== card ||
        boardIdRef.current !== lockedBoardId || client.getSnapshot().contextVersion !== version) {
        throw new Error(t('reportCard.contextChanged'));
      }
      reportCardVisibleRef.current = false;
      setReportCardVisible(false);
      openDetail(card.taskId);
      void refresh();
    } catch (err) {
      // 上下文已换成另一张报告时，旧点击结果不能污染新卡片。
      if (seq === reportOpenSeqRef.current) setReportCardError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reportOpenSeqRef.current) {
        reportCardOpeningRef.current = false;
        setReportCardOpening(false);
      }
    }
  }, [client, openDetail, refresh, t]);

  // 普通看板入口携带 taskId：锁定看板任务加载完成后
  // 打开该任务详情。同一实例对同一任务仅打开一次，重复上下文不重复弹详情；
  // 归档任务不在活动列表中，仍可经 task_get 读取详情。
  useEffect(() => {
    if (!pendingFocus || loading) return;
    if (focusedTaskRef.current !== pendingFocus) {
      focusedTaskRef.current = pendingFocus;
      openDetail(pendingFocus);
    }
    setPendingFocus(null);
  }, [pendingFocus, loading, openDetail]);

  const call = useCallback(
    <T,>(name: string, args: Record<string, unknown> = {}) => {
      if (!client) return Promise.reject(new Error(translate('mcp.notConnected')));
      return client.call<T>(name, args);
    },
    [client],
  );

  /** 打开/关闭归档视图：打开时立即拉取最新归档列表 */
  const setArchiveOpen = useCallback(
    (open: boolean) => {
      archiveOpenRef.current = open;
      setArchiveOpenState(open);
      if (open) void refreshArchived();
    },
    [refreshArchived],
  );

  /**
   * 批量归档当前看板全部未归档 done 任务（task_archive_done）：
   * 实际归档范围以服务端事务提交时为准，成功按返回数量反馈；失败提示错误并保留原列表。
   */
  const archiveAllDone = useCallback(async () => {
    const boardId = boardIdRef.current;
    if (!boardId) {
      toast('err', t('archiveAll.noBoard'));
      return false;
    }
    try {
      const res = await call<{ archivedCount: number }>('task_archive_done', { boardId });
      toast('ok', t('archiveAll.done', { count: res?.archivedCount ?? 0 }));
      await Promise.all([refresh(), refreshArchived(), refreshDetail()]);
      return true;
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [call, refresh, refreshArchived, refreshDetail, toast, t]);

  // 当前看板对象每次从最新列表解析（board_list 刷新后计数跟随更新）
  const board = useMemo(() => boards.find((b) => b.id === boardId) ?? null, [boards, boardId]);

  const isCurrentBoard = useCallback((id: string) => boardIdRef.current === id, []);

  const value = useMemo<BoardContextValue>(
    () => ({
      conn,
      executionHost,
      hostSnapshot,
      isCurrentBoard,
      boards,
      boardId,
      board,
      boardsError,
      widgetMode,
      projectCtx,
      reportCardVisible,
      reportCard,
      reportCardError,
      reportCardOpening,
      openReportDetail,
      tasks,
      loading,
      activeTab,
      search,
      toasts,
      detailId,
      detail,
      archiveOpen,
      archivedTasks,
      archiveLoading,
      archiveError,
      archiveSearch,
      setActiveTab,
      setSearch,
      openDetail,
      setArchiveOpen,
      setArchiveSearch,
      archiveAllDone,
      switchBoard,
      addBoard,
      refresh,
      mutate,
      call,
      toast,
    }),
    [
      conn,
      executionHost,
      hostSnapshot,
      isCurrentBoard,
      boards,
      boardId,
      board,
      boardsError,
      widgetMode,
      projectCtx,
      reportCardVisible,
      reportCard,
      reportCardError,
      reportCardOpening,
      openReportDetail,
      tasks,
      loading,
      activeTab,
      search,
      toasts,
      detailId,
      detail,
      archiveOpen,
      archivedTasks,
      archiveLoading,
      archiveError,
      archiveSearch,
      openDetail,
      setArchiveOpen,
      archiveAllDone,
      switchBoard,
      addBoard,
      refresh,
      mutate,
      call,
      toast,
    ],
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error('useBoard must be used within BoardProvider');
  return ctx;
}
