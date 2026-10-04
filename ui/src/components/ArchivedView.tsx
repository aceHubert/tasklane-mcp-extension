import { useBoard } from '../state/BoardContext';
import { useTaskActions } from '../state/useTaskActions';
import { useLang } from '../i18n';
import { agoText, type WorkItem } from '../mcp/types';
import { ArchiveIcon, RestoreIcon, SearchIcon, XIcon } from './icons';

/**
 * 已归档任务视图（独立入口，不占用业务状态列）：搜索 + 归档时间倒序 + 恢复。
 * 归档任务只读：卡片不提供指派/流转，恢复走 task_restore；
 * 点卡片本体打开常规详情（只读态）查看完整信息。
 */

function ArchivedCard({ task }: { task: WorkItem }) {
  const { conn, openDetail, setArchiveOpen } = useBoard();
  const { t } = useLang();
  const { restore } = useTaskActions(task);
  const disabled = conn !== 'connected';

  const open = () => {
    // 先关闭归档视图再打开详情，避免双层遮罩
    setArchiveOpen(false);
    openDetail(task.id);
  };

  return (
    <article
      className="card archived"
      onClick={open}
      onKeyDown={(e) => {
        // 仅卡片自身聚焦时 Enter 打开详情；子元素（恢复按钮等）的键盘事件
        // 不在此处理，避免按钮 Enter 先冒泡打开详情并卸载按钮（验收 F1）。
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        open();
      }}
      tabIndex={0}
      role="button"
      aria-label={t('archive.cardAria', { id: task.id, title: task.title })}
    >
      <div className="card-head">
        <span className="tid mono">{task.id}</span>
        <span className={`prio ${task.priority}`}>{task.priority}</span>
      </div>
      <div className="card-title">{task.title}</div>
      <div className="exec">
        <span className="exec-chip archived">
          <ArchiveIcon /> {t('archive.archivedAgo', { time: agoText(task.archivedAt) })}
        </span>
        <button
          className="btn small"
          onClick={(e) => { e.stopPropagation(); void restore(); }}
          disabled={disabled}
        >
          <RestoreIcon /> {t('archive.restore')}
        </button>
      </div>
    </article>
  );
}

export function ArchivedView({ onClose }: { onClose: () => void }) {
  const { archivedTasks, archiveLoading, archiveError, archiveSearch, setArchiveSearch, board } = useBoard();
  const { t } = useLang();

  // 搜索只作用于归档视图（任务 ID / 标题）；默认按归档时间倒序
  const q = archiveSearch.trim().toLowerCase();
  const filtered = archivedTasks
    .filter((task) => !q || task.id.toLowerCase().includes(q) || task.title.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  let body: React.ReactNode;
  if (archiveError) {
    body = (
      <div className="empty" role="alert">
        <div className="empty-title">{t('archive.readErrorTitle')}</div>
        <p className="empty-desc mono">{archiveError}</p>
      </div>
    );
  } else if (archiveLoading && archivedTasks.length === 0) {
    body = (
      <div className="sk-card" aria-busy="true">
        <div className="sk-line w40" />
        <div className="sk-line w90" />
        <div className="sk-line w60" />
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <div className="empty">
        <div className="empty-title">
          {archivedTasks.length === 0 ? t('archive.emptyTitle') : t('archive.emptySearchTitle')}
        </div>
        {archivedTasks.length > 0 ? <p className="empty-desc">{t('archive.emptySearchDesc')}</p> : null}
      </div>
    );
  } else {
    body = filtered.map((task) => <ArchivedCard key={task.id} task={task} />);
  }

  return (
    <>
      <div className="backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal archive-modal" role="dialog" aria-label={t('header.archived')}>
        <div className="archive-head">
          <span className="archive-title">
            <ArchiveIcon /> {t('archive.viewTitle', { name: board?.name ?? '' })}
          </span>
          <span className="archive-count mono">{archivedTasks.length}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label={t('archive.closeAria')}>
            <XIcon />
          </button>
        </div>
        <div className="search-box archive-search">
          <SearchIcon />
          <input
            placeholder={t('archive.searchPlaceholder')}
            value={archiveSearch}
            onChange={(e) => setArchiveSearch(e.target.value)}
            aria-label={t('archive.searchAria')}
          />
        </div>
        <div className="archive-list">{body}</div>
      </div>
    </>
  );
}
