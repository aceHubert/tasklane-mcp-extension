import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { ExportDialog } from './ExportDialog';
import { ExportIcon } from './icons';

/**
 * 导出报告入口：icon=大屏头部平铺图标按钮，menu=小屏设置菜单项。
 * 对话框挂在触发按钮所在浮层之外，避免被 more-wrap/菜单的层叠上下文压住。
 */
export function ExportEntry({ variant }: { variant: 'icon' | 'menu' }) {
  const { t } = useLang();
  const { conn, boardId, widgetMode } = useBoard();
  const [open, setOpen] = useState(false);
  // 导出是只读能力，但需要连接与看板范围；项目打开失败或无看板时禁用
  const disabled = conn !== 'connected' || widgetMode === 'project-error' || !boardId;

  return (
    <>
      {variant === 'icon' ? (
        <button
          className="icon-btn"
          aria-label={t('header.export')}
          title={t('header.export')}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <ExportIcon />
        </button>
      ) : (
        <button
          type="button"
          className="menu-item"
          role="menuitem"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <ExportIcon /> {t('header.export')}
        </button>
      )}
      {open ? (
        <>
          <div className="backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="modal export-modal" role="dialog" aria-label={t('export.title')}>
            <ExportDialog onClose={() => setOpen(false)} />
          </div>
        </>
      ) : null}
    </>
  );
}
