import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { statusKey } from '../i18n/messages';
import { AppHeader } from './AppHeader';
import { ArchiveAllButton } from './ArchiveAllButton';
import { DisconnectedBanner } from './DisconnectedBanner';
import { TaskCard } from './TaskCard';
import { TaskDetail } from './TaskDetail';
import { NewTaskForm } from './NewTaskForm';
import { STATUS_ORDER, type TaskStatus } from '../mcp/types';

/** M5 展开视图：多列 Kanban（760–899 横向滚动，≥1000 完整 5 列）+ 拖拽 + 右侧 drawer */
export function BoardWide() {
  const { tasks, board, boardId, detailId, openDetail, mutate, call, conn, search, widgetMode } = useBoard();
  const { t } = useLang();
  const [newOpen, setNewOpen] = useState(false);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  // 项目打开失败：宽视图同样进入错误空态，不渲染旧看板的列与计数
  if (widgetMode === 'project-error') {
    return (
      <div className="frame wide">
        <DisconnectedBanner />
        <AppHeader />
        <div className="board-cols">
          <div className="empty" role="alert">
            <div className="empty-title">{t('list.projectErrorTitle')}</div>
            <p className="empty-desc">
              {t('list.projectErrorDesc')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const matchSearch = (t: { id: string; title: string; branch?: string }) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (t.branch?.toLowerCase().includes(q) ?? false);
  };

  const onDrop = (status: TaskStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    // 拖拽卡片来自当前看板；携带 boardId 校验归属，切换后旧卡片已随 key 重置卸载
    void mutate(
      () => call('task_move', { id, status, boardId }),
      t('toast.mcpOk', { call: `task_move(${id} → ${status})` }),
    );
  };

  return (
    <div className="frame wide">
      <DisconnectedBanner />
      <AppHeader wide onNew={() => setNewOpen(true)} />

      <div className="board-cols">
        {STATUS_ORDER.map((status) => {
          const items = tasks.filter((t) => t.status === status && matchSearch(t));
          const count = board?.counts?.[status] ?? items.length;
          return (
            <section
              key={status}
              className={`col${dragOver === status ? ' drag-over' : ''}`}
              data-column={status}
              aria-label={t('board.colAria', { status: t(statusKey(status)) })}
              onDragOver={(e) => { e.preventDefault(); setDragOver(status); }}
              onDragLeave={() => setDragOver((cur) => (cur === status ? null : cur))}
              onDrop={onDrop(status)}
            >
              <header className="col-head">
                <span className={`col-dot st-${status}`} aria-hidden="true" />
                <span className="col-name">{t(statusKey(status))}</span>
                <span className="col-count">{count}</span>
              </header>
              {status === 'done' ? (
                // Done 列头提供「归档全部已完成」；作用于当前看板全部 done，不受搜索限制
                <div className="col-archive-bar">
                  <ArchiveAllButton />
                </div>
              ) : null}
              <div className="col-body">
                {items.length === 0 ? (
                  <div className="col-empty">{status === 'doing' ? t('board.dropHint') : '—'}</div>
                ) : (
                  items.map((t) => <TaskCard key={t.id} task={t} draggable />)
                )}
              </div>
            </section>
          );
        })}
      </div>

      {detailId ? (
        <>
          <div className="backdrop" onClick={() => openDetail(null)} aria-hidden="true" />
          <TaskDetail inDrawer onClose={() => openDetail(null)} />
        </>
      ) : null}

      {newOpen ? (
        <>
          <div className="backdrop" onClick={() => setNewOpen(false)} aria-hidden="true" />
          <div className="modal" role="dialog" aria-label={t('header.newTask')}>
            <NewTaskForm onDone={() => setNewOpen(false)} />
          </div>
        </>
      ) : null}

      {conn !== 'connected' ? <div className="veil" aria-hidden="true" /> : null}
    </div>
  );
}
