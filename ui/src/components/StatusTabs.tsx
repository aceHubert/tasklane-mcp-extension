import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { statusKey } from '../i18n/messages';
import { STATUS_ORDER } from '../mcp/types';

export function StatusTabs() {
  const { board, activeTab, setActiveTab } = useBoard();
  const { t } = useLang();
  const counts = board?.counts;

  return (
    <nav className="tabs" aria-label={t('tabs.aria')}>
      {STATUS_ORDER.map((status) => {
        const count = counts?.[status] ?? 0;
        const active = activeTab === status;
        const hot = status === 'doing' || status === 'review';
        return (
          <button
            key={status}
            className={`tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => setActiveTab(status)}
          >
            <span className="tab-name">{t(statusKey(status))}</span>
            <span className={`tab-count${hot && count > 0 ? ' hot' : ''}`}>{count}</span>
            {status === 'review' && count > 0 ? <span className="review-dot" aria-label={t('tabs.reviewDot')} /> : null}
          </button>
        );
      })}
    </nav>
  );
}
