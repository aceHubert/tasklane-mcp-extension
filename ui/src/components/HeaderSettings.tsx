import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { ExportEntry } from './ExportEntry';
import { LangSwitch } from './LangSwitch';
import { ArchiveIcon, MoreIcon, MoonIcon, SunIcon } from './icons';

/**
 * 窄栏设置菜单（⋯）：归档、导出报告、语言与主题切换（大屏这些均平铺在头部，无此菜单）。
 * 搜索与刷新不在此 —— 两者在头部的搜索弹出层里，与宽窄一致。
 */
export function HeaderSettings() {
  const { t } = useLang();
  const { conn, boardId, board, setArchiveOpen } = useBoard();
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tasklane-theme', next);
    setDark(!dark);
  };

  const archiveDisabled = conn !== 'connected' || !boardId;
  const close = () => setOpen(false);

  return (
    <div className="more-wrap">
      <button
        className="icon-btn"
        aria-label={t('settings.aria')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div className="popover settings-menu" role="menu">
          {/* 首行平铺语言与主题（无标签、靠左，语言在前） */}
          <div className="menu-actions">
            <LangSwitch />
            <button
              type="button"
              className="icon-btn"
              aria-label={dark ? t('header.themeLightAria') : t('header.themeDarkAria')}
              title={dark ? t('header.themeLight') : t('header.themeDark')}
              onClick={toggleTheme}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={archiveDisabled}
            onClick={() => {
              close();
              setArchiveOpen(true);
            }}
          >
            <ArchiveIcon /> {t('header.archivedAria', { count: board?.archivedCount ?? 0 })}
          </button>
          <ExportEntry variant="menu" />
        </div>
      ) : null}
    </div>
  );
}
