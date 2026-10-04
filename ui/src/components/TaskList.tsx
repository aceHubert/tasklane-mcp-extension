import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { statusKey, type MessageKey } from '../i18n/messages';
import { ArchiveAllButton } from './ArchiveAllButton';
import { TaskCard } from './TaskCard';

/** 示例模板标题（空态快捷创建）：随界面语言切换 */
const TEMPLATE_KEYS: MessageKey[] = ['list.tpl1', 'list.tpl2', 'list.tpl3'];

function matchSearch(q: string, t: { id: string; title: string; branch?: string }): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return (
    t.id.toLowerCase().includes(needle) ||
    t.title.toLowerCase().includes(needle) ||
    (t.branch?.toLowerCase().includes(needle) ?? false)
  );
}

export function TaskList() {
  const {
    tasks,
    loading,
    activeTab,
    search,
    setActiveTab,
    board,
    boardId,
    boards,
    boardsError,
    widgetMode,
    projectCtx,
    mutate,
    call,
    conn,
  } = useBoard();
  const { t } = useLang();

  // 项目打开失败（路径无效/注册失败等）：错误空态，不显示其他仓库任务
  if (widgetMode === 'project-error') {
    return (
      <div className="empty" role="alert">
        <div className="empty-title">{t('list.projectErrorTitle')}</div>
        <p className="empty-desc">
          {t('list.projectErrorDesc')}
        </p>
        {projectCtx?.projectDir ? <p className="empty-desc mono">{projectCtx.projectDir}</p> : null}
      </div>
    );
  }

  // 看板列表读取失败：展示错误态（断连时由横幅提示，这里只兜从未加载成功的情况）
  if (boardsError) {
    return (
      <div className="empty" role="alert">
        <div className="empty-title">{t('list.boardsErrorTitle')}</div>
        <p className="empty-desc mono">{boardsError}</p>
      </div>
    );
  }

  if (loading && tasks.length === 0) {
    return (
      <div className="task-list" aria-busy="true" aria-label={t('list.loadingAria')}>
        {[0, 1, 2].map((i) => (
          <div className="sk-card" key={i}>
            <div className="sk-line w40" />
            <div className="sk-line w90" />
            <div className="sk-line w60" />
          </div>
        ))}
      </div>
    );
  }

  // 没有任何看板：引导添加第一个仓库（顶部 ⊞ 入口）
  if (boards.length === 0 && conn === 'connected') {
    return (
      <div className="empty">
        <div className="empty-title">{t('list.noBoardsTitle')}</div>
        <p className="empty-desc">{t('list.noBoardsDesc')}</p>
      </div>
    );
  }

  const total = board?.total ?? tasks.length;
  // 窄栏 Done 页提供「归档全部已完成」（无目标任务时禁用；作用于当前看板全部 done，不受搜索限制）
  const doneBar = activeTab === 'done' ? (
    <div className="archive-all-row">
      <ArchiveAllButton />
    </div>
  ) : null;

  if (total === 0) {
    return (
      <div className="list-stack">
        {doneBar}
        <div className="empty">
          <div className="empty-title">{t('list.noTasksTitle')}</div>
          <p className="empty-desc">{t('list.noTasksDesc')}</p>
          <div className="empty-actions">
            {TEMPLATE_KEYS.map((key) => (
              <button
                key={key}
                className="btn small"
                disabled={conn !== 'connected' || !boardId}
                onClick={() =>
                  mutate(() => call('task_create', { boardId, title: t(key) }), t('toast.mcpOk', { call: `task_create(${t(key).slice(0, 24)}…)` }))
                }
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const filtered = tasks.filter((t) => t.status === activeTab && matchSearch(search, t));

  if (filtered.length === 0) {
    const hint: Record<string, MessageKey> = {
      doing: 'list.emptyDoing',
      review: 'list.emptyReview',
    };
    return (
      <div className="list-stack">
        {doneBar}
        <div className="empty">
          <div className="empty-title">{t(hint[activeTab] ?? 'list.emptyOther')}</div>
          {activeTab === 'doing' ? (
            <button className="btn small" onClick={() => setActiveTab('ready')}>
              {t('list.viewReady')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="list-stack" aria-label={t('list.listAria', { status: t(statusKey(activeTab)) })}>
      {doneBar}
      <div className="task-list">
        {filtered.map((t) => (
          <TaskCard key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}
