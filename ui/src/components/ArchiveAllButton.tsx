import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { ArchiveIcon } from './icons';

/**
 * 「归档全部已完成」：内联确认（展示看板名与数量）而非系统对话框，
 * 避免宿主 iframe 禁止原生弹窗；提交期间禁用重复操作；
 * 成功反馈实际归档数量（以服务端事务提交时为准）。
 * 窄栏 Done 页与宽视图 Done 列头共用；数量为看板全部未归档 done，
 * 不受搜索结果限制。
 */
export function ArchiveAllButton() {
  const { board, boardId, conn, widgetMode, archiveAllDone } = useBoard();
  const { t } = useLang();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const count = board?.counts?.done ?? 0;
  const disabled =
    conn !== 'connected' || widgetMode === 'project-error' || !boardId || count === 0 || busy;

  const run = () => {
    setBusy(true);
    void archiveAllDone().finally(() => {
      setBusy(false);
      setConfirming(false);
    });
  };

  if (!confirming) {
    return (
      <button className="btn small archive-all-btn" onClick={() => setConfirming(true)} disabled={disabled}>
        <ArchiveIcon /> {count > 0 ? t('archiveAll.button', { count }) : t('archiveAll.buttonEmpty')}
      </button>
    );
  }

  return (
    <div className="archive-all-confirm" role="alertdialog" aria-label={t('archiveAll.confirm')}>
      <span className="archive-all-text">
        {t('archiveAll.confirmText', { name: board?.name ?? boardId ?? '', count })}
      </span>
      <button className="btn small" onClick={() => setConfirming(false)} disabled={busy}>
        {t('common.cancel')}
      </button>
      <button className="btn small danger" onClick={run} disabled={busy}>
        {busy ? t('archiveAll.busy') : t('archiveAll.confirm')}
      </button>
    </div>
  );
}
