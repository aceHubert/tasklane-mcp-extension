import { useMemo, useRef, useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { AlertIcon, CheckIcon, CopyIcon, ExportIcon, XIcon } from './icons';

/**
 * 导出 Markdown 报告对话框（task_export）：范围可选，区间默认「今天往前一个月」。
 * 日期在本地自然日上选择，默认值与 core 的月末回退口径保持一致（3 月 31 日 → 2 月 28/29 日）。
 * 生成即落盘；成功后只展示报告文件路径并提供「复制路径」（不展示报告内容，
 * Agent 侧照常读取工具返回的完整 markdown）。复制被宿主 iframe 拒绝时回退为选中路径文本。
 */

type Scope = 'all' | 'active' | 'archived';

function toInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 与 core 一致的月末回退：日号超出目标月时夹到当月最后一天，不整体顺延 */
function monthsAgo(date: Date, delta: number): Date {
  const total = date.getMonth() + delta;
  const year = date.getFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(date.getDate(), lastDay));
}

function defaultRange(): { start: string; end: string } {
  const today = new Date();
  return { start: toInputValue(monthsAgo(today, -1)), end: toInputValue(today) };
}

function thisMonthRange(): { start: string; end: string } {
  const today = new Date();
  return { start: toInputValue(new Date(today.getFullYear(), today.getMonth(), 1)), end: toInputValue(today) };
}

function lastMonthRange(): { start: string; end: string } {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const last = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start: toInputValue(first), end: toInputValue(last) };
}

/** 剪贴板写入：宿主 iframe 可能拒绝 navigator.clipboard，用临时 textarea + execCommand 兜底 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走兜底路径 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { board, boardId, call, conn } = useBoard();
  const { t, lang } = useLang();
  const initial = useMemo(defaultRange, []);
  const [range, setRange] = useState(initial);
  const [scope, setScope] = useState<Scope>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const pathRef = useRef<HTMLElement | null>(null);

  const invalidRange = Boolean(range.start && range.end && range.start > range.end);
  const disabled = busy || invalidRange || !boardId || conn !== 'connected';

  const submit = async () => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    setCopyFailed(false);
    try {
      const payload = await call<{ path: string }>('task_export', {
        boardId,
        start: range.start,
        end: range.end,
        scope,
        lang,
      });
      setPath(payload?.path ?? null);
    } catch (err) {
      setPath(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 复制失败时选中路径文本，用户可直接 Cmd/Ctrl+C，不把剪贴板失败当成导出失败 */
  const selectPath = () => {
    const node = pathRef.current;
    if (!node) return;
    const selection = window.getSelection();
    if (!selection) return;
    const textRange = document.createRange();
    textRange.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(textRange);
  };

  const copyPath = async () => {
    if (!path) return;
    const ok = await writeClipboard(path);
    setCopied(ok);
    setCopyFailed(!ok);
    if (!ok) selectPath();
  };

  return (
    <div className="detail export-dialog">
      <div className="detail-top">
        <span className="detail-title">
          <ExportIcon /> {t('export.title')}
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label={t('export.closeAria')}>
          <XIcon />
        </button>
      </div>

      <div className="detail-scroll">
        <div className="kv">
          <span className="k">{t('export.boardLabel')}</span>
          <span className="v">{board?.name ?? '—'}</span>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="field-label">{t('export.startLabel')}</span>
            <input
              type="date"
              value={range.start}
              max={range.end || undefined}
              onChange={(e) => {
                setRange((prev) => ({ ...prev, start: e.target.value }));
                setPath(null);
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('export.endLabel')}</span>
            <input
              type="date"
              value={range.end}
              min={range.start || undefined}
              onChange={(e) => {
                setRange((prev) => ({ ...prev, end: e.target.value }));
                setPath(null);
              }}
            />
          </label>
        </div>

        <div className="export-quick">
          <button className="btn small" onClick={() => { setRange(defaultRange()); setPath(null); }}>
            {t('export.quickMonth')}
          </button>
          <button className="btn small" onClick={() => { setRange(thisMonthRange()); setPath(null); }}>
            {t('export.quickThisMonth')}
          </button>
          <button className="btn small" onClick={() => { setRange(lastMonthRange()); setPath(null); }}>
            {t('export.quickLastMonth')}
          </button>
        </div>

        <label className="field">
          <span className="field-label">{t('export.scopeLabel')}</span>
          <select value={scope} onChange={(e) => { setScope(e.target.value as Scope); setPath(null); }}>
            <option value="all">{t('export.scopeAll')}</option>
            <option value="active">{t('export.scopeActive')}</option>
            <option value="archived">{t('export.scopeArchived')}</option>
          </select>
        </label>

        <div className="hint-note subtle">{t('export.hint')}</div>

        {invalidRange ? (
          <div className="fail-note" role="alert">
            <AlertIcon />
            <span>{t('export.invalidRange')}</span>
          </div>
        ) : null}
        {error ? (
          <div className="fail-note" role="alert">
            <AlertIcon />
            <span>{t('export.failed')}: {error}</span>
          </div>
        ) : null}

        <div className="cta-row">
          <button className="btn primary" onClick={() => void submit()} disabled={disabled}>
            {busy ? t('export.submitting') : t('export.submit')}
          </button>
        </div>

        {path ? (
          <div className="export-path-row">
            <span className="field-label">{t('export.pathLabel')}</span>
            <div className="path-line">
              <code className="export-path mono" ref={pathRef}>{path}</code>
              <button className="btn small" onClick={() => void copyPath()}>
                {copied ? <CheckIcon /> : <CopyIcon />} {copied ? t('export.pathCopied') : t('export.pathCopy')}
              </button>
            </div>
            {copyFailed ? (
              <div className="fail-note" role="alert">
                <AlertIcon />
                <span>{t('export.pathCopyFailed')}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
