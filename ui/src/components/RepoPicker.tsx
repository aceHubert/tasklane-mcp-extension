import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { ArrowUpIcon, FolderIcon, GitBranchIcon } from './icons';

/** dir_list 返回的目录条目 */
export interface DirEntry {
  name: string;
  path: string;
  isRepo: boolean;
  /** 检测的基线分支：优先 main、其次 master，无提交时取当前分支，其余默认 'main' */
  baseBranch: string;
}

/**
 * 文件夹选择器：经 dir_list 逐级浏览本机目录，Git 仓库高亮并可直接选用。
 * 浏览器安全模型不向 iframe 暴露真实路径，因此走 MCP server（本地有文件系统访问权）。
 * 上次浏览目录记在 localStorage（失效自动回退主目录）；每次进入目录都即时拉取最新列表。
 */

const CWD_STORAGE_KEY = 'tl-picker-cwd';

function readSavedCwd(): string | null {
  try {
    const v = localStorage.getItem(CWD_STORAGE_KEY);
    return v && v.startsWith('/') ? v : null;
  } catch {
    return null;
  }
}
export function RepoPicker({
  onPick,
  onCancel,
}: {
  onPick: (repo: string, baseBranch: string) => void;
  onCancel: () => void;
}) {
  const { call } = useBoard();
  const { t } = useLang();
  const [cwd, setCwd] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: string | undefined) => {
      setLoading(true);
      setError(null);
      try {
        const res = await call<{ path: string; parent: string | null; home: string; entries: DirEntry[] }>('dir_list', target ? { path: target } : {});
        setHome(res.home);
        // 以用户主目录为基线：恢复的路径越过 home 时钳制回 home
        if (res.home && res.path !== res.home && !res.path.startsWith(res.home + '/')) {
          await load(undefined);
          return;
        }
        setCwd(res.path);
        setParent(res.parent);
        setEntries(res.entries ?? []);
        try {
          localStorage.setItem(CWD_STORAGE_KEY, res.path);
        } catch {
          // 存储不可用只影响记忆，不影响浏览
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [call],
  );

  // 面包屑以用户主目录为基线：~/Desktop/projects → [{~},{Desktop},{projects}]，点击直达对应层级
  const crumbs = (() => {
    if (!cwd) return [] as { label: string; path: string }[];
    if (!home) return [{ label: cwd, path: cwd }];
    if (cwd === home) return [{ label: '~', path: home }];
    if (!cwd.startsWith(home + '/')) return [{ label: cwd, path: cwd }];
    const rest = cwd.slice(home.length + 1).split('/').filter(Boolean);
    return [
      { label: '~', path: home },
      ...rest.map((part, i) => ({ label: part, path: `${home}/${rest.slice(0, i + 1).join('/')}` })),
    ];
  })();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = readSavedCwd();
      if (saved) {
        try {
          await load(saved);
          return;
        } catch {
          // 上次目录已被删除/不可读：清掉记忆，回退主目录
          try {
            localStorage.removeItem(CWD_STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }
      }
      if (!cancelled) void load(undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="repo-picker">
      <div className="detail-top">
        <span className="detail-title">{t('picker.title')}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onCancel} aria-label={t('picker.cancelAria')}>×</button>
      </div>

      <div className="dir-cwd mono" title={cwd ?? ''}>
        {parent !== null && cwd !== home ? (
          <button className="icon-btn" onClick={() => void load(parent!)} aria-label={t('picker.upAria')} title={t('picker.upTitle')}>
            <ArrowUpIcon />
          </button>
        ) : null}
        <span className="dir-cwd-path mono">
          {crumbs.map((c) => (
            <span className="dir-seg" key={c.path} role="button" tabIndex={0}
              onClick={() => void load(c.path)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void load(c.path); }}
              title={t('picker.jumpTo', { path: c.path })}>
              {c.label}
            </span>
          )  ).reduce<ReactNode[]>((acc, el) => [...acc, el, '/'], [])}
          {!cwd ? t('common.loading') : ''}
        </span>
      </div>

      {error ? <div className="fail-note">{t('picker.readFailed', { error })}</div> : null}

      <div className="dir-list" role="listbox" aria-label={t('picker.subdirsAria')}>
        {loading ? (
          <div className="hint-note subtle">{t('picker.reading')}</div>
        ) : entries.length === 0 && !error ? (
          <div className="hint-note subtle">{t('picker.noSubdirs')}</div>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              className={`dir-row${e.isRepo ? ' repo' : ''}`}
              onClick={() => (e.isRepo ? onPick(e.path, e.baseBranch) : void load(e.path))}
              title={e.isRepo ? t('picker.useRepo', { path: e.path, branch: e.baseBranch }) : t('picker.enter', { name: e.name })}
            >
              <span className="dir-row-icon">{e.isRepo ? <GitBranchIcon /> : <FolderIcon />}</span>
              <span className="dir-row-name">{e.name}</span>
              {e.isRepo ? <span className="dir-row-branch mono">{e.baseBranch}</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="hint-note subtle">{t('picker.hint')}</div>
    </div>
  );
}
