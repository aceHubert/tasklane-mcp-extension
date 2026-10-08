import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { statusKey } from '../i18n/messages';
import { type Priority, type TaskStatus, localInputToIso } from '../mcp/types';
import { XIcon } from './icons';

const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

/** 新建任务只记录内容和业务阶段，执行由详情中的 Run 操作发起。 */
export function NewTaskForm({ onDone }: { onDone: () => void }) {
  const { call, conn, toast, refresh, boardId, widgetMode } = useBoard();
  const { t } = useLang();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [status, setStatus] = useState<TaskStatus>('ready');
  /** 截止时间（datetime-local 本地值）；留空不设置 */
  const [deadline, setDeadline] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 项目打开失败：无有效看板上下文，禁止创建（boardId 可能是错误前的陈旧值）
  const ctxBlocked = widgetMode === 'project-error';

  const submit = async () => {
    if (!title.trim() || submitting || !boardId || ctxBlocked) return;
    // 固定提交时的看板归属，用户中途切换不会把任务写入另一仓库。
    const targetBoardId = boardId;
    setSubmitting(true);
    try {
      const res = await call<{ task: { id: string } }>('task_create', {
        boardId: targetBoardId,
        title: title.trim(),
        description: desc.trim() || undefined,
        priority,
        status,
        // 留空不设置；本地时间在浏览器侧换算为带时区 ISO，避免服务端时区解析偏移
        deadline: localInputToIso(deadline),
      });
      const id = res?.task?.id;
      if (!id) throw new Error(t('form.noTaskId'));
      toast('ok', t('toast.mcpOk', { call: `task_create(${id})` }));

      await refresh();
      onDone();
    } catch (err) {
      toast('err', err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="detail">
      <div className="detail-top">
        <span className="detail-title">{t('header.newTask')}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onDone} aria-label={t('form.closeAria')}><XIcon /></button>
      </div>
      <div className="detail-scroll">
        <label className="field">
          <span className="field-label">{t('form.titleLabel')}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && title.trim()) void submit(); }}
            placeholder={t('form.titlePlaceholder')}
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field-label">{t('detail.fieldDescription')}</span>
          <textarea
            rows={4}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={t('form.descPlaceholder')}
          />
        </label>

        <div className="field">
          <span className="field-label">{t('detail.fieldPriority')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('detail.priorityAria')}>
            {PRIORITIES.map((p) => (
              <button
                key={p}
                role="radio"
                aria-checked={priority === p}
                className={`seg${priority === p ? ' active' : ''} ${p}`}
                onClick={() => setPriority(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">{t('form.initialStatus')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('form.initialStatus')}>
            {(['backlog', 'ready'] as TaskStatus[]).map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={status === s}
                className={`seg${status === s ? ' active' : ''}`}
                onClick={() => setStatus(s)}
              >
                {t(statusKey(s))}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field-label">{t('form.deadline')}</span>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </label>

        <div className="hint-note subtle">{t('form.plainHint')}</div>

        <div className="cta-row">
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={!title.trim() || !boardId || ctxBlocked || conn !== 'connected' || submitting}
          >
            {t('form.create')}
          </button>
          <button className="btn" onClick={onDone}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
