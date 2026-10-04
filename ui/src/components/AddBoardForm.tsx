import { useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { RepoPicker } from './RepoPicker';
import { AlertIcon, FolderIcon, XIcon } from './icons';

/**
 * 添加仓库表单（board_create）：本机绝对路径 + 名称 + 基线分支。
 * 提交期间防重复请求；失败保留输入并内联展示错误，不切换看板；
 * 成功或仓库已存在时由 addBoard 切换到目标看板并关闭表单。
 */
export function AddBoardForm({ onDone }: { onDone: () => void }) {
  const { addBoard, conn } = useBoard();
  const { t } = useLang();
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // 选中仓库后基线由检测接管：main 优先，其次 master，无提交时取当前分支，其余默认 main。
  const [picked, setPicked] = useState<{ baseBranch: string } | null>(null);

  const submit = async () => {
    const repoTrimmed = repo.trim();
    if (!repoTrimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await addBoard({
      repo: repoTrimmed,
      name: name.trim() || undefined,
      baseBranch: baseBranch.trim() || 'main',
    });
    if (result.ok) {
      onDone();
      return;
    }
    // 失败：保留全部输入，展示具体错误，不切换看板
    setError(result.error);
    setSubmitting(false);
  };

  return (
    <div className="detail add-board">
      <div className="detail-top">
        <span className="detail-title">{t('header.addBoard')}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onDone} aria-label={t('add.closeAria')}><XIcon /></button>
      </div>
      <div className="detail-scroll">
        {browsing ? (
          <RepoPicker
            onPick={(path, baseBranch) => {
              setRepo(path);
              setBaseBranch(baseBranch);
              setPicked({ baseBranch });
              if (!name.trim()) setName(path.split('/').filter(Boolean).pop() ?? '');
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
          />
        ) : (
        <>
        <label className="field">
          <span className="field-label">{t('add.repoPathLabel')}</span>
          <span className="input-row">
            <input
              className="mono"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setPicked(null); // 手动改动路径时恢复分支可编辑
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && repo.trim()) void submit();
              }}
              placeholder={t('add.repoPathPlaceholder')}
              autoFocus
            />
            <button
              className="btn small"
              onClick={() => setBrowsing(true)}
              disabled={conn !== 'connected'}
              title={t('add.browseTitle')}
            >
              <FolderIcon /> {t('add.browse')}
            </button>
          </span>
        </label>

        <label className="field">
          <span className="field-label">{t('add.nameLabel')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('add.namePlaceholder')}
          />
        </label>

        <label className="field">
          <span className="field-label">{t('add.baseLabel')}</span>
          <input
            value={picked ? picked.baseBranch : baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            disabled={picked !== null}
            placeholder={
              picked ? t('add.basePickedPlaceholder', { branch: picked.baseBranch }) : t('add.basePlaceholder')
            }
            title={picked ? t('add.basePickedTitle') : t('add.baseTitle')}
          />
        </label>

        <div className="hint-note subtle">
          {t('add.hint')}
        </div>

        {error ? <div className="fail-note" role="alert"><AlertIcon /><span>{error}</span></div> : null}

        <div className="cta-row">
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={!repo.trim() || conn !== 'connected' || submitting}
          >
            {submitting ? t('add.registering') : t('add.submit')}
          </button>
          <button className="btn" onClick={onDone}>{t('common.cancel')}</button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
