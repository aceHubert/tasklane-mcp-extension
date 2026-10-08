import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';

const STATE_CLASS = {
  running: 'run', waiting: 'wait', blocked: 'fail', failed: 'fail', completed: 'done',
};

/** 会话内的执行回执快照；详情只由明确点击打开。 */
export function ExecutionReportCard() {
  const { reportCard, reportCardError, reportCardOpening, openReportDetail, conn } = useBoard();
  const { t } = useLang();

  return (
    <main className="report-card-frame">
      <article className="execution-report-card" aria-label={t('reportCard.aria')}>
        <div className="report-card-label">TaskLane · {t('reportCard.label')}</div>
        {reportCard ? (
          <>
            <div className="card-head">
              <span className="tid mono">{reportCard.taskId}</span>
              <span className={`prio ${reportCard.priority}`}>{reportCard.priority}</span>
              <span className={`exec-chip ${STATE_CLASS[reportCard.state]}`} role="status">
                {t(`native.status.${reportCard.state}`)}
              </span>
            </div>
            <h1 className="report-card-title">{reportCard.title}</h1>
            {reportCard.activity ? <p className="report-card-activity">{reportCard.activity}</p> : null}
            <div className="report-card-footer">
              <time dateTime={reportCard.updatedAt} title={reportCard.updatedAt}>
                {new Date(reportCard.updatedAt).toLocaleString()}
              </time>
              <button className="btn primary" onClick={() => void openReportDetail()}
                disabled={conn !== 'connected' || reportCardOpening}>
                {t(reportCardOpening ? 'reportCard.opening' : 'reportCard.openDetail')}
              </button>
            </div>
          </>
        ) : !reportCardError ? <p className="report-card-activity" role="status">{t('reportCard.loading')}</p> : null}
        {reportCardError ? <p className="report-card-error" role="alert">{reportCardError}</p> : null}
        {reportCard && conn !== 'connected' ? (
          <p className="report-card-connection" role="status">
            {t(conn === 'connecting' ? 'header.connConnecting' : 'header.connDisconnected')}
          </p>
        ) : null}
      </article>
    </main>
  );
}
