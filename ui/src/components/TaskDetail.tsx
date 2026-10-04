import { useCallback, useEffect, useRef, useState } from 'react';
import { useBoard } from '../state/BoardContext';
import { useTaskActions } from '../state/useTaskActions';
import { creationModelRequest, executionStatusCheckReason, normalizeExecutionModel, toModelOptions, type ModelOption } from '../state/nativeExecution';
import { useLang } from '../i18n';
import { execKey, eventKey, statusKey } from '../i18n/messages';
import {
  ALLOWED_TRANSITIONS,
  STATUS_ORDER,
  agoText,
  timeAgo,
  type Priority,
  type TaskStatus,
  type WorkspaceMode,
} from '../mcp/types';
import { AlertIcon, ArchiveIcon, BotIcon, CheckIcon, CopyIcon, PauseIcon, UserIcon, XIcon } from './icons';
import { HostConnection } from './HostConnection';
import { ConfirmDialog } from './ConfirmDialog';
import { executionBlocked, executionRecoverySource, executionTarget, hasRealBinding } from '../host';
import type { ExecutionRequest } from '../mcp/types';

/** 窄栏=整页替换，宽栏=右侧 drawer，共用此组件 */
export function TaskDetail({ onClose, inDrawer = false }: { onClose: () => void; inDrawer?: boolean }) {
  const { detail, mutate, call, conn, toast, hostSnapshot } = useBoard();
  const { t } = useLang();
  const task = detail?.task;
  const hostConnected = conn === 'connected' && hostSnapshot.connected;
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  // 工作方式默认 worktree（独立 worktree 执行）；已有工作区的任务只能原样复用 existing
  const defaultWorkspace = (): WorkspaceMode => task?.worktreePath ? 'existing' : 'worktree';
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode | ''>(defaultWorkspace);
  const [modelDraft, setModelDraft] = useState({ taskId: '', id: '' });
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);
  /** 删除确认弹窗开关：切换任务时随表单一并重置 */
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [recoveryRequest, setRecoveryRequest] = useState<ExecutionRequest | null>(null);
  const [recovering, setRecovering] = useState(false);
  /** 宿主模型目录候选：未绑定任务的模型下拉经 model_list 拉取一次；失败仅保留继承宿主默认 */
  const [modelCatalog, setModelCatalog] = useState<{ status: 'idle' | 'loading' | 'ready' | 'failed'; options: ModelOption[] }>({
    status: 'idle',
    options: [],
  });
  /** 字段级编辑标记：未编辑的字段跟随服务端刷新（外部修改可见），编辑中的不被轮询覆盖 */
  const [dirty, setDirty] = useState({ title: false, desc: false });
  const changesRef = useRef<HTMLDivElement | null>(null);
  const formForTask = useRef<string | null>(null);

  const actions = useTaskActions(task ?? { id: '', boardId: '', execution: { state: 'idle' as const } });

  useEffect(() => {
    if (!task) {
      formForTask.current = null;
      return;
    }
    if (formForTask.current !== task.id) {
      // 切换任务：整体重置为服务端值
      formForTask.current = task.id;
      setTitle(task.title);
      setDesc(task.description ?? '');
      setDirty({ title: false, desc: false });
      setWorkspaceMode(defaultWorkspace());
      setModelDraft({ taskId: task.id, id: '' });
      setDeleteDialogOpen(false);
      setRecoveryRequest(null);
      return;
    }
    // 同一任务的数据刷新：未编辑字段同步外部修改；编辑中字段不动（等 blur 保存）
    if (!dirty.title) setTitle(task.title);
    if (!dirty.desc) setDesc(task.description ?? '');
  }, [task, dirty.title, dirty.desc]);

  // 未绑定任务的模型下拉需要宿主目录候选：ref 守卫每次详情会话只拉取一次。
  // 不用 effect cleanup 取消：BoardContext 轮询会持续替换 task 对象，
  // cleanup 会把在途请求误判为过期，导致响应被丢弃并永久停留在 loading。
  const catalogFetchedRef = useRef(false);
  const ensureModelCatalog = useCallback(() => {
    if (catalogFetchedRef.current) return;
    catalogFetchedRef.current = true;
    setModelCatalog({ status: 'loading', options: [] });
    call('model_list', {})
      .then((payload) => setModelCatalog({ status: 'ready', options: toModelOptions(payload) }))
      .catch(() => setModelCatalog({ status: 'failed', options: [] }));
  }, [call]);

  useEffect(() => {
    if (!task || task.executionBinding || !hostConnected) return;
    ensureModelCatalog();
  }, [task, hostConnected, ensureModelCatalog]);

  if (!task) {
    return (
      <div className={inDrawer ? 'drawer' : 'detail'}>
        <div className="detail-top">
          <span className="detail-title muted">{t('common.loading')}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label={t('detail.closeAria')}><XIcon /></button>
        </div>
        <div className="detail-scroll">
          <div className="sk-card"><div className="sk-line w90" /><div className="sk-line w60" /></div>
        </div>
      </div>
    );
  }

  const exec = task.execution;
  const currentRequest = actions.requests.find((request) => request.runId === exec.runId);
  const realBinding = hasRealBinding(task.executionBinding);
  const target = executionTarget(task);
  const isBlocked = executionBlocked(task);
  // 类型谓词需在表达式处内联使用，单独存变量无法收窄 executionBinding
  const sessionId = target?.threadId ?? exec.sessionId;
  // 内部 ID 不代表真实聊天；待创建时同样标为未绑定，并单独展示请求进度。
  const unboundTag = !target && Boolean(sessionId);
  const disabled = conn !== 'connected';
  /** 归档任务只读：编辑/流转/执行全部禁用，唯一写操作是恢复 */
  const archived = Boolean(task.archivedAt);
  const locked = disabled || archived;
  const allowedTargets = ALLOWED_TRANSITIONS[task.status];

  const saveField = (patch: Record<string, unknown>, toolLabel: string) =>
    mutate(
      () => call('task_update', { id: task.id, boardId: task.boardId, ...patch }),
      t('toast.mcpOk', { call: `task_update(${task.id} ${toolLabel})` }),
    );

  // blur 保存：只提交用户实际编辑过的字段；空标题回退为服务端值
  const blurTitle = () => {
    if (!dirty.title) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === task.title) {
      setTitle(task.title);
      setDirty((d) => ({ ...d, title: false }));
      return;
    }
    void saveField({ title: trimmed }, 'title').then((ok) => {
      if (ok) setDirty((d) => ({ ...d, title: false }));
    });
  };

  const blurDesc = () => {
    if (!dirty.desc) return;
    if (desc === (task.description ?? '')) {
      setDirty((d) => ({ ...d, desc: false }));
      return;
    }
    void saveField({ description: desc }, 'description').then((ok) => {
      if (ok) setDirty((d) => ({ ...d, desc: false }));
    });
  };

  const { move, restore } = actions;

  const highlightChanges = () => {
    changesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    changesRef.current?.classList.add('flash');
    setTimeout(() => changesRef.current?.classList.remove('flash'), 1200);
  };

  const execStateText = t(`native.status.${actions.status}`);
  const creationRequest = creationModelRequest(task);
  const recoveredCreation = executionRecoverySource(task);
  const pendingCreation = !task.executionBinding && Boolean(creationRequest);
  // 核对/恢复入口仅在请求未终结且卡住时出现：等待回执超过 5 分钟视为需要人工干预。
  // blocked/uncertain 同属等待宿主的非终态，超时同样显示；completed/failed/rejected/cancelled 不显示。
  const REQUEST_STUCK_MS = 5 * 60_000;
  const canRecover = !archived && Boolean(currentRequest &&
    ['pending', 'delivered', 'claimed', 'created', 'bound', 'uncertain', 'blocked'].includes(currentRequest.status) &&
    Date.now() - Date.parse(currentRequest.updatedAt) > REQUEST_STUCK_MS);
  const statusCheckReason = executionStatusCheckReason(hostSnapshot, task);
  const sendingStart = startingTaskId === task.id;
  const draft = modelDraft.taskId === task.id ? modelDraft : { taskId: task.id, id: '' };
  const modelId = pendingCreation ? creationRequest?.model ?? '' : draft.id;
  const selectedWorkspace = pendingCreation ? creationRequest!.workspaceMode : workspaceMode;
  let selectedModel: string | undefined;
  let modelInvalid = false;
  if (!task.executionBinding && modelId) {
    try { selectedModel = normalizeExecutionModel(modelId); } catch { modelInvalid = true; }
  }
  const continueExisting = Boolean(task.executionBinding || isBlocked);
  const blocked = actions.reason(continueExisting ? 'continue' : 'start', selectedWorkspace || undefined);
  const startExecution = async () => {
    if (!selectedWorkspace || modelInvalid || sendingStart) return;
    const startedTaskId = task.id;
    setStartingTaskId(startedTaskId);
    try { await actions.start(selectedWorkspace, selectedModel); }
    finally { setStartingTaskId((current) => current === startedTaskId ? null : current); }
  };
  const confirmRecovery = async () => {
    const request = recoveryRequest;
    setRecoveryRequest(null);
    if (!request || recovering || locked) return;
    setRecovering(true);
    try { await actions.recover(request); }
    finally { setRecovering(false); }
  };
  // 删除（仅 backlog）：页面内 ConfirmDialog 二次确认，取消/背景/Esc 均不写入；
  // 服务端守卫兜底（非 backlog / 已进入执行链拒绝），失败经 mutate 弹错误 toast
  const requestDelete = () => setDeleteDialogOpen(true);
  const confirmDelete = () => {
    setDeleteDialogOpen(false);
    void mutate(
      () => call('task_delete', { id: task.id, boardId: task.boardId }),
      t('detail.deleteDone', { id: task.id }),
    ).then((ok) => { if (ok) onClose(); });
  };
  const primaryCta = archived ? (
    <div className="cta-row"><button className="btn primary" onClick={restore} disabled={disabled}>{t('detail.restoreToDone')}</button></div>
  ) : task.status === 'review' ? (
    <div className="cta-row">
      <button className="btn" onClick={highlightChanges}>{t('card.reviewChanges')}</button>
      <button className="btn primary" onClick={() => move('done')} disabled={disabled}>{t('detail.markDone')}</button>
    </div>
  ) : task.status === 'done' ? (
    // 重新打开与归档同行：归档仅对已完成未归档任务可用（与卡片入口、core 规则一致）；
    // 重新打开会让本轮完成结果退回待审查，用 danger 红色提醒
    <div className="cta-row">
      <button className="btn danger" onClick={() => move('review')} disabled={disabled}>{t('detail.reopen')}</button>
      <button className="btn" onClick={() => void actions.archive()} disabled={disabled}>
        <ArchiveIcon /> {t('archive.action')}
      </button>
    </div>
  ) : null;

  return (
    <div className={inDrawer ? 'drawer' : 'detail'}>
      <div className="detail-top">
        <span className="tid mono">{task.id}</span>
        <span className={`status-pill ${task.status}`}>{t(statusKey(task.status))}</span>
        {archived ? <span className="status-pill archived">{t('archive.archivedChip')}</span> : null}
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label={t('detail.copyIdAria')}
          onClick={() => { void navigator.clipboard.writeText(task.id); toast('ok', t('detail.idCopied', { id: task.id })); }}
        >
          <CopyIcon />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label={t('detail.closeAria')}><XIcon /></button>
      </div>

      <div className="detail-scroll">
        {disabled ? <div className="banner-warn" role="alert">{t('banner.disconnected')}</div> : null}
        {archived ? (
          <div className="archived-note" role="status">
            <ArchiveIcon />
            <span>{t('detail.archivedBanner', { time: agoText(task.archivedAt) })}</span>
          </div>
        ) : null}
        <input
          className="title-input"
          value={title}
          onChange={(e) => { setTitle(e.target.value); setDirty((d) => ({ ...d, title: true })); }}
          onBlur={blurTitle}
          disabled={locked}
          aria-label={t('detail.titleAria')}
        />

        <div className="field-row">
          <label className="field">
            <span className="field-label">{t('detail.fieldStatus')}</span>
            <select
              value={task.status}
              onChange={(e) => void move(e.target.value as TaskStatus)}
              disabled={locked}
              aria-label={t('detail.statusAria')}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s} disabled={s !== task.status && !allowedTargets.includes(s)}>
                  {t(statusKey(s))}
                  {s !== task.status && !allowedTargets.includes(s) ? t('detail.notDirect') : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('detail.fieldPriority')}</span>
            <select
              value={task.priority}
              onChange={(e) => void saveField({ priority: e.target.value as Priority }, 'priority')}
              disabled={locked}
              aria-label={t('detail.priorityAria')}
            >
              {(['P0', 'P1', 'P2', 'P3'] as Priority[]).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">{t('detail.fieldDescription')}</span>
          <textarea
            rows={3}
            value={desc}
            placeholder={t('detail.descPlaceholder')}
            onChange={(e) => { setDesc(e.target.value); setDirty((d) => ({ ...d, desc: true })); }}
            onBlur={blurDesc}
            disabled={locked}
          />
        </label>

        <section className="sec exec-sec">
          <div className="sec-head">{t('detail.assignedTo')}</div>
          <div className="exec-main">
            <span className={`exec-chip ${task.assignee === 'agent' ? 'agent' : 'human'} ${exec.state}`}>
              {task.assignee === 'agent' ? <BotIcon /> : <UserIcon />}
              {task.assignee === 'agent' ? `${actions.agentName} · ${execStateText}` : t('card.human')}
            </span>
          </div>
          {task.archivedAt ? (
            <div className="kv"><span className="k">{t('archive.archivedChip')}</span><span className="v mono" title={task.archivedAt}>{task.archivedAt}</span></div>
          ) : null}
          {task.assignee === 'agent' && exec.activity ? (
            <div className="kv"><span className="k">{t('detail.currentActivity')}</span><span className="v">{exec.activity}</span></div>
          ) : null}
          {exec.startedAt ? (
            <div className="kv"><span className="k">{t('detail.started')}</span><span className="v">{agoText(exec.startedAt)}</span></div>
          ) : null}
          {actions.status === 'failed' ? (
            <div className="fail-note" role="alert"><AlertIcon /><span>{exec.activity ? t('detail.failNoteWithActivity', { activity: exec.activity }) : t('detail.failNote')}</span></div>
          ) : null}
          {actions.status === 'waiting' ? (
            <div className="wait-note"><PauseIcon /><span>{t('detail.waitNote')}</span></div>
          ) : null}
          {/* 阻塞详情不再在此重复：与「当前活动」全文一致，完整内容由下方执行区状态 alert 承载 */}
        </section>

        <section className="sec native-execution">
          <div className="sec-head">{t(hostConnected ? 'native.workspace' : 'native.session')}</div>
          {!unboundTag ? (() => {
            // 执行状态提示条（alert 样式）置于会话行上方；按状态配色并配语义图标。
            // 阻塞时展示完整原因（即当前活动/投递错误），不重复指派对象区的「当前活动」。
            const blockedReason = exec.activity ?? currentRequest?.deliveryError ?? t('native.blocked.unknown');
            const note = actions.status === 'failed' ? { cls: 'err', icon: <AlertIcon />, text: execStateText }
              : actions.status === 'blocked' ? { cls: 'err', icon: <AlertIcon />, text: t('native.blocked.reason', { reason: blockedReason }) }
              : actions.status === 'waiting' ? { cls: 'warn', icon: <PauseIcon />, text: execStateText }
              : actions.status === 'uncertain' ? { cls: 'warn', icon: <AlertIcon />, text: execStateText }
              : actions.status === 'completed' ? { cls: 'ok', icon: <CheckIcon />, text: execStateText }
              : actions.status === 'running' ? { cls: 'ok', icon: null, text: execStateText }
              : { cls: 'info', icon: null, text: execStateText };
            return <div className={`status-note ${note.cls}`} role="status">{note.icon}<span>{note.text}</span></div>;
          })() : null}
          {/* 会话恢复入口紧随状态 alert：阻塞时用户第一眼就能看到恢复操作 */}
          {canRecover ? (
            <div className="cta-row">
              <button className="btn" disabled={locked || !hostConnected || Boolean(statusCheckReason) || recovering}
                title={statusCheckReason ? t(`native.reason.${statusCheckReason}`) : undefined}
                onClick={() => currentRequest && setRecoveryRequest(structuredClone(currentRequest))}>
                {t(recovering ? 'native.recovery.sending' : 'native.recovery.action')}
              </button>
            </div>
          ) : null}
          {sessionId ? (
            <div className="kv">
              <span className="k">{t('native.session')}</span>
              <span className="v mono" title={sessionId}>{sessionId}</span>
              {unboundTag ? <span className="exec-chip">{t('native.status.unbound')}</span> : null}
            </div>
          ) : null}
          {target && !realBinding ? <>
            <p className="native-reason">{t('native.createdUnbound')}</p>
            <div className="kv"><span className="k">{t('detail.worktree')}</span><span className="v mono">{target.workspacePath}</span></div>
          </> : null}
          {/* 工作区/方式：有绑定显示工作区路径；本轮运行已发起（请求待回执）则方式随运行固定，
              只读文本展示（与模型一致，无论 Codex 与否）；仅未发起时显示可编辑选择表单（需 Codex） */}
          {task.executionBinding ? (
            <div className="kv"><span className="k">{t('detail.worktree')}</span><span className="v mono">{task.executionBinding.workspacePath}</span></div>
          ) : pendingCreation ? (
            <div className="kv"><span className="k">{t('native.mode')}</span>
              <span className="v">{t(`native.${creationRequest!.workspaceMode}`)}</span></div>
          ) : hostConnected ? (
            <>
              <label className="field">
                <select aria-label={t('native.workspace')} value={selectedWorkspace} disabled={locked || sendingStart}
                  onChange={(e) => setWorkspaceMode(e.target.value as WorkspaceMode | '')}>
                  {task.worktreePath ? <option value="existing">{t('native.existing')}</option> : <>
                    <option value="project">{t('native.project')}</option>
                    <option value="worktree">{t('native.worktree')}</option>
                  </>}
                </select>
              </label>
              <p className="native-reason">{t('native.ownership')}</p>
            </>
          ) : null}
          {/* 模型区按宿主与选择状态分流：
              ① 非 Codex 宿主且选择未确认 → 完全不显示（无可操作表单）；
              ② Codex 宿主且选择未确认 → 显示可编辑模型表单；
              ③ 选择已确认（有绑定或请求已提交锁定模型）→ 无论 Codex 与否一律只读文本，
                 按钮可用性只在 Codex 宿主中控制 */}
          {task.executionBinding || pendingCreation ? (
            <div className="kv"><span className="k">{t('native.model.created')}</span>
              <span className="v mono">{creationRequest ? creationRequest.model ?? t('native.model.default') : t('native.model.unknown')}</span>
            </div>
          ) : hostConnected ? (
            <>
              <label className="field">
                <span className="field-label">{t('native.model.label')}</span>
                <select aria-label={t('native.model.label')} value={modelId}
                  disabled={locked || sendingStart}
                  aria-describedby="execution-model-help"
                  onChange={(e) => setModelDraft({ ...draft, id: e.target.value })}>
                  <option value="">{t('native.model.default')}</option>
                  {modelCatalog.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label !== option.id ? `${option.label} (${option.id})` : option.id}
                    </option>
                  ))}
                </select>
              </label>
              <p id="execution-model-help" className="native-reason">{t('native.model.help')}</p>
              {modelCatalog.status === 'loading' ? (
                <p className="native-reason" role="status">{t('native.model.catalogLoading')}</p>
              ) : modelCatalog.status === 'failed' ? (
                <p className="native-reason" role="status">{t('native.model.catalogFailed')}</p>
              ) : modelCatalog.status === 'ready' && modelCatalog.options.length > 0 ? (
                <p className="native-reason" role="status">{t('native.model.catalogCount', { count: modelCatalog.options.length })}</p>
              ) : null}
              {modelInvalid ? <p className="native-reason" role="alert">{t('native.model.invalid')}</p> : null}
            </>
          ) : null}
          {hostConnected || target ? <div className="cta-row">
            {hostConnected ? (
              <button className="btn primary" disabled={locked || Boolean(blocked) || modelInvalid || sendingStart}
                title={blocked ? t(`native.reason.${blocked}`) : undefined}
                onClick={() => continueExisting ? void actions.continueExecution() : void startExecution()}>
                {t(isBlocked ? 'native.blocked.continue' : recoveredCreation ? 'native.recovery.reuse' : continueExisting ? 'native.continue' : 'native.start', { agent: actions.agentName })}
              </button>
            ) : null}
            {/* 打开会话不可用时隐藏而非禁用 */}
            {target && !disabled && !actions.openReason ? (
              <button className="btn" onClick={() => void actions.openSession()}>
                {t('native.open', { agent: actions.agentName })}
              </button>
            ) : null}
          </div> : null}
          {hostConnected && blocked ? <p className="native-reason" role="status">{t(`native.reason.${blocked}`)}</p> : null}
          {isBlocked && !target ? <p className="native-reason" role="status">{t('native.blocked.noTarget')}</p> : null}
          {/* 核对结果只对仍在流转的请求有意义：终态（历史遗留数据）不回显过期异常消息 */}
          {currentRequest?.recoveryCheck && !['completed', 'failed', 'rejected', 'cancelled'].includes(currentRequest.status) ?
            <p className="native-reason" role="status">
              {t(`native.recovery.check.${currentRequest.recoveryCheck.status}`)}
              {currentRequest.recoveryCheck.message ? ` · ${currentRequest.recoveryCheck.message}` : ''}
            </p> : null}
          {currentRequest?.status === 'cancelled' ? <p className="native-reason" role="status">{t('native.recovery.done')}</p> : null}
          {recoveredCreation?.result ? <p className="native-reason">{t('native.recovery.preserved', { threadId: recoveredCreation.result.threadId })}</p> : null}
          {actions.requests.length ? <div className="kv"><span className="k">{t('native.request')}</span>
            <span className="v mono">{currentRequest?.requestId}</span></div> : null}
          {currentRequest?.deliveryError && ['rejected', 'uncertain'].includes(currentRequest.status) ? (
            <div className={currentRequest.status === 'rejected' ? 'fail-note' : 'wait-note'}
              role={currentRequest.status === 'rejected' ? 'alert' : 'status'}>
              {t('native.deliveryError', { error: currentRequest.deliveryError })}
            </div>
          ) : null}
        </section>

        <HostConnection />

        {detail && detail.timeline.length > 0 ? (
          <section className="sec">
            <div className="sec-head">{t('detail.timeline')}</div>
            <ul className="timeline">
              {[...detail.timeline].reverse().map((ev, i) => {
                const kindKey = eventKey(ev.kind);
                return (
                  <li key={i} className={ev.kind}>
                    <span className="tl-time mono">{timeAgo(ev.at)}</span>
                    <span className="tl-kind">{kindKey ? t(kindKey) : ev.kind}</span>
                    {ev.detail ? <span className="tl-detail" title={ev.detail}>{ev.detail}</span> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {task.repo || task.branch || task.worktreePath ? (
          <section className="sec">
            <div className="sec-head">{t('detail.gitContext')}</div>
            {task.repo ? <div className="kv"><span className="k">{t('detail.repo')}</span><span className="v mono">{task.repo}</span></div> : null}
            {task.baseBranch ? <div className="kv"><span className="k">{t('detail.base')}</span><span className="v mono">{task.baseBranch}</span></div> : null}
            {task.branch ? <div className="kv"><span className="k">{t('detail.branch')}</span><span className="v mono">{task.branch}</span></div> : null}
            {task.worktreePath ? <div className="kv"><span className="k">{t('detail.worktree')}</span><span className="v mono">{task.worktreePath}</span></div> : null}
          </section>
        ) : null}

        <section className="sec" ref={changesRef}>
          <div className="sec-head">{t('detail.changeSummary')}</div>
          {task.changes && task.changes.filesChanged > 0 ? (
            <>
              <div className="changes-stat mono">
                {t('detail.filesChanged', { count: task.changes.filesChanged })}
                <span className="add"> +{task.changes.additions}</span>
                <span className="del"> −{task.changes.deletions}</span>
                <span className={`test-pill ${task.changes.testStatus}`}>
                  {task.changes.testStatus === 'passing' ? t('detail.testsPassing') : task.changes.testStatus === 'failing' ? t('detail.testsFailing') : t('detail.testsUnknown')}
                </span>
              </div>
              <ul className="file-list">
                {task.changes.files.map((f) => (
                  <li key={f.name} className="mono">
                    <span className="file-name" title={f.name}>{f.name}</span>
                    <span className="add">+{f.added}</span>
                    <span className="del">−{f.removed}</span>
                  </li>
                ))}
              </ul>
              <button
                className="btn small"
                onClick={() => {
                  if (task.worktreePath) {
                    void navigator.clipboard.writeText(task.worktreePath);
                    toast('ok', t('detail.worktreeCopied'));
                  } else {
                    toast('ok', t('detail.noGitContext'));
                  }
                }}
              >
                {t('detail.openDiff')}
              </button>
            </>
          ) : (
            <div className="muted">{t('detail.noChanges')}</div>
          )}
        </section>

        {primaryCta}

        {/* 删除入口固定在详情最底部：仅 backlog 且未归档时展示，页面内弹窗二次确认 */}
        {task.status === 'backlog' && !archived ? (
          <div className="cta-row">
            <button className="btn danger" disabled={disabled} onClick={requestDelete}>
              {t('detail.delete')}
            </button>
          </div>
        ) : null}
        {recoveryRequest ? (
          <ConfirmDialog
            title={t('native.recovery.action')}
            message={t('native.recovery.confirm')}
            confirmText={t('native.recovery.action')}
            onConfirm={() => void confirmRecovery()}
            onCancel={() => setRecoveryRequest(null)}
          />
        ) : null}
        {deleteDialogOpen ? (
          <ConfirmDialog
            title={t('detail.delete')}
            message={t('detail.deleteConfirm')}
            confirmText={t('detail.delete')}
            danger
            onConfirm={confirmDelete}
            onCancel={() => setDeleteDialogOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
