import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { AddBoardForm } from './AddBoardForm';
import { ExportEntry } from './ExportEntry';
import { HeaderSettings } from './HeaderSettings';
import { LangSwitch } from './LangSwitch';
import { ArchiveIcon, ChevronDownIcon, LockIcon, MoonIcon, PlusIcon, RefreshIcon, SearchIcon, SunIcon, AlertIcon } from './icons';
// 静态 import：vite 按 assetsInlineLimit 内联为 data URL。
// 不能用 new URL(..., import.meta.url) —— 插件内联构建把 bundle 放进经典 script，import.meta 会语法报错（白屏）。
import liquidGlassLogoUrl from '../assets/liquid-glass-logo-white.png';

/**
 * 操作区顺序：大屏 = 新建 → 搜索 → 归档 → 导出 → 主题 → 语言；
 * 窄栏 = 新建 → 搜索 → ⋯ 设置菜单（归档/导出/语言/主题收纳其中）。
 */
export function AppHeader({ onNew, wide = false }: { onNew?: () => void; wide?: boolean }) {
  const { board, boards, boardId, switchBoard, conn, search, setSearch, refresh, widgetMode, projectCtx, setArchiveOpen } = useBoard();
  const { t } = useLang();
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark');

  const projectLocked = widgetMode !== 'global';
  const openFailed = widgetMode === 'project-error';

  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('tasklane-theme', next);
    setDark(!dark);
  };

  const connClass = conn === 'connected' ? 'ok' : conn === 'connecting' ? 'warn' : 'err';
  const connText =
    conn === 'connected' ? t('header.connConnected')
      : conn === 'connecting' ? t('header.connConnecting')
        : t('header.connDisconnected');

  return (
    <header className="app-header">
      <img className="logo-badge" src={liquidGlassLogoUrl} alt="" aria-hidden="true" />

      <div className="title-block">
        {openFailed ? (
          // 项目打开失败：无任何看板上下文，不渲染选择器/添加入口，也不显示旧看板名
          <div className="board-name" style={{ color: 'var(--err)' }}>
            <AlertIcon /> {t('list.projectErrorTitle')}
          </div>
        ) : projectLocked ? (
          // 项目模式：锁定当前仓库，只显示项目名称与聊天工作区路径（无选择器/添加入口）
          <>
            <div className="board-name" title={projectCtx?.projectDir ?? ''}>
              <LockIcon /> <span className="board-name-text">{board?.name ?? projectCtx?.boardName ?? 'TaskLane'}</span>
            </div>
            {projectCtx?.projectDir ? (
              <div className="repo mono" title={projectCtx.projectDir}>{projectCtx.projectDir}</div>
            ) : null}
          </>
        ) : boards.length > 0 ? (
          // 仓库选择器：suffix 槽位放置「添加仓库」入口
          <div className="board-select-wrap">
            <select
              className="board-select"
              value={boardId ?? ''}
              onChange={(e) => switchBoard(e.target.value)}
              aria-label={t('header.switchBoardAria')}
              title={board?.repo ?? t('header.switchBoardAria')}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {t('header.boardOption', { name: b.name, count: b.total })}
                </option>
              ))}
            </select>
            <span className="select-chevron" aria-hidden="true"><ChevronDownIcon /></span>
            <button
              className="icon-btn add-board-btn"
              aria-label={t('header.addBoard')}
              title={t('header.addBoard')}
              onClick={() => setAddOpen(true)}
              disabled={conn !== 'connected'}
            >
              <PlusIcon />
            </button>
          </div>
        ) : (
          <div className="board-name">TaskLane</div>
        )}
        {!projectLocked && board?.repo ? <div className="repo mono" title={board.repo}>{board.repo}</div> : null}
      </div>

      <span className={`conn ${connClass}`} role="status" aria-label={connText}>
        <span className="conn-dot" aria-hidden="true" />
        <span className="conn-text">{connText}</span>
      </span>

      {!projectLocked && boards.length === 0 ? (
        // 首次使用（尚无任何看板）：选择器未渲染，添加入口退化为独立按钮
        <button
          className="icon-btn add-board-btn"
          aria-label={t('header.addBoard')}
          title={t('header.addBoard')}
          onClick={() => setAddOpen(true)}
          disabled={conn !== 'connected'}
        >
          <PlusIcon />
        </button>
      ) : null}

      {onNew ? (
        <button className="btn primary small" onClick={onNew} disabled={conn !== 'connected' || openFailed}>
          <PlusIcon /> {t('header.new')}
        </button>
      ) : null}

      {/* 搜索：紧随「新建」之后（弹出层含搜索框与刷新，`aria-expanded` 同步） */}
      <div className="more-wrap">
        <button
          className="icon-btn"
          aria-label={t('header.searchAria')}
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <SearchIcon />
        </button>
        {searchOpen ? (
          <div className="popover" role="menu">
            <div className="search-box">
              <SearchIcon />
              <input
                placeholder={t('header.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={t('header.searchAria')}
              />
            </div>
            <button
              className="btn small"
              onClick={() => {
                setSearchOpen(false);
                void refresh();
              }}
            >
              <RefreshIcon /> {t('header.refresh')}
            </button>
          </div>
        ) : null}
      </div>

      {/* 已归档入口：大屏平铺；小屏收进 ⋯ 设置菜单 */}
      {wide ? (
        <button
          className="icon-btn archive-entry-btn"
          aria-label={t('header.archivedAria', { count: board?.archivedCount ?? 0 })}
          title={t('header.archived')}
          onClick={() => setArchiveOpen(true)}
          disabled={conn !== 'connected' || openFailed || !boardId}
        >
          <ArchiveIcon />
          {(board?.archivedCount ?? 0) > 0 ? (
            <span className="archive-badge">{board?.archivedCount}</span>
          ) : null}
        </button>
      ) : null}

      {/* 大屏：归档 → 导出 → 主题 → 语言 平铺；小屏：归档/导出/语言/主题全部收进 ⋯ 设置菜单 */}
      {wide ? (
        <>
          <ExportEntry variant="icon" />
          <button
            className="icon-btn"
            aria-label={dark ? t('header.themeLightAria') : t('header.themeDarkAria')}
            title={dark ? t('header.themeLight') : t('header.themeDark')}
            onClick={toggleTheme}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
          <LangSwitch />
        </>
      ) : (
        <HeaderSettings />
      )}

      {addOpen ? (
        <>
          <div className="backdrop" onClick={() => setAddOpen(false)} aria-hidden="true" />
          <div className="modal" role="dialog" aria-label={t('header.addBoard')}>
            <AddBoardForm onDone={() => setAddOpen(false)} />
          </div>
        </>
      ) : null}
    </header>
  );
}
