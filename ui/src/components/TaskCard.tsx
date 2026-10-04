import { useBoard } from '../state/BoardContext';
import { useTaskActions } from '../state/useTaskActions';
import { useLang } from '../i18n';
import type { WorkItem } from '../mcp/types';
import { BotIcon, BranchIcon, UserIcon } from './icons';

const STATE_CHIP_CLASS = {
  unbound: '',
  bound: '',
  pending: 'wait',
  uncertain: 'wait',
  blocked: 'fail',
  running: 'run',
  waiting: 'wait',
  failed: 'fail',
  completed: 'done',
};

export function TaskCard({ task, draggable = false }: { task: WorkItem; draggable?: boolean }) {
  const { openDetail, conn } = useBoard();
  const { t } = useLang();
  const actions = useTaskActions(task);
  const open = () => openDetail(task.id);
  const stopBubble = (e: React.MouseEvent) => e.stopPropagation();
  const disabled = conn !== 'connected';
  const isDone = task.status === 'done';
  const changes = task.changes;

  return (
    <article
      className={`card${draggable ? ' draggable' : ''}`}
      data-task-id={task.id}
      onClick={open}
      onKeyDown={(e) => {
        // 仅卡片自身聚焦时 Enter 打开详情；内部按钮的键盘事件不冒泡处理，
        // 避免按钮 Enter 同时触发卡片开详情（与归档卡片 F1 同类问题）。
        if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
        open();
      }}
      tabIndex={0}
      role="button"
      aria-label={t('card.taskAria', { id: task.id, title: task.title })}
      draggable={draggable && !disabled && !task.archivedAt}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="card-head">
        <span className="tid mono">{task.id}</span>
        <span className={`prio ${task.priority}`}>{task.priority}</span>
        {isDone && !task.archivedAt ? (
          // 归档入口与 task id 同行、靠右对齐，不再挤在 exec 行
          <button className="link-btn card-archive" onClick={(e) => { stopBubble(e); void actions.archive(); }} disabled={disabled}>{t('archive.action')}</button>
        ) : null}
      </div>
      <div className="card-title">{task.title}</div>
      <div className="exec card-tags">
        <span className={`exec-chip ${task.assignee === 'agent' ? 'agent' : 'human'}`}>
          {task.assignee === 'agent' ? <BotIcon /> : <UserIcon />}
          {task.assignee === 'agent' ? actions.agentName : t('card.human')}
        </span>
        <span className={`exec-chip card-state-tag ${STATE_CHIP_CLASS[actions.status]}`} role="status"
          title={t(`native.status.${actions.status}`)}>
          {t(`native.cardStatus.${actions.status}`)}
        </span>
      </div>
      {task.branch || changes?.filesChanged ? (
        <div className="ctx">
          {task.branch ? <span className="mono branch" title={task.branch}><BranchIcon /> {task.branch}</span> : null}
          {changes?.filesChanged ? (
            <span className="diff mono">{t('card.files', { count: changes.filesChanged })} <span className="add">+{changes.additions}</span> <span className="del">−{changes.deletions}</span></span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
