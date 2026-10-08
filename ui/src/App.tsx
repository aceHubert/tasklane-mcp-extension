import { useEffect, useState } from 'react';
import { BoardProvider, useBoard } from './state/BoardContext';
import { LangProvider, useLang } from './i18n';
import { AppHeader } from './components/AppHeader';
import { StatusTabs } from './components/StatusTabs';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { NewTaskForm } from './components/NewTaskForm';
import { BoardWide } from './components/BoardWide';
import { DisconnectedBanner } from './components/DisconnectedBanner';
import { ArchivedView } from './components/ArchivedView';
import { Toasts } from './components/Toasts';
import { PlusIcon } from './components/icons';
import { ExecutionReportCard } from './components/ExecutionReportCard';

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** 窄栏（<760px）：状态 Tabs + 单列卡片；Task Detail 整页替换（设计文档 §6） */
function NarrowApp() {
  const { detailId, openDetail, conn, widgetMode } = useBoard();
  const { t } = useLang();
  const [view, setView] = useState<'list' | 'new'>('list');

  if (detailId) return <TaskDetail onClose={() => openDetail(null)} />;
  if (view === 'new') return <NewTaskForm onDone={() => setView('list')} />;

  return (
    <div className="frame narrow">
      <DisconnectedBanner />
      <AppHeader />
      <StatusTabs />
      <main className="task-scroll">
        <TaskList />
      </main>
      <footer className="sticky-cta">
        <button
          className="btn primary block"
          onClick={() => setView('new')}
          disabled={conn !== 'connected' || widgetMode === 'project-error'}
        >
          <PlusIcon /> {t('header.newTask')}
        </button>
      </footer>
    </div>
  );
}

/**
 * 以 boardId 为 key：切换仓库看板时整棵视图树重挂载，
 * 新建表单、搜索输入、拖拽状态与打开中的抽屉全部重置，避免残留状态写入新仓库。
 */
function BoardView({ wide }: { wide: boolean }) {
  const { boardId } = useBoard();
  if (wide) return <BoardWide key={boardId ?? 'none'} />;
  return <NarrowApp key={boardId ?? 'none'} />;
}

/**
 * 已归档视图层：挂在窄/宽两种形态之外，随 BoardContext 开关；
 * 切换看板时由 loadBoardTasks 关闭并清空，不随视图树重挂载丢失。
 */
function ArchiveLayer() {
  const { archiveOpen, setArchiveOpen } = useBoard();
  if (!archiveOpen) return null;
  return <ArchivedView onClose={() => setArchiveOpen(false)} />;
}

function AppContent({ wide }: { wide: boolean }) {
  const { reportCardVisible } = useBoard();
  useEffect(() => {
    document.documentElement.toggleAttribute('data-report-card', reportCardVisible);
  }, [reportCardVisible]);
  if (reportCardVisible) return <ExecutionReportCard />;
  return <><BoardView wide={wide} /><ArchiveLayer /><Toasts /></>;
}

export default function App() {
  const wide = useMedia('(min-width: 760px)');
  return (
    <LangProvider>
      <BoardProvider>
        <AppContent wide={wide} />
      </BoardProvider>
    </LangProvider>
  );
}
