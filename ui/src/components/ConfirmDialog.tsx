import { useEffect, useRef } from 'react';
import { useLang } from '../i18n';

/**
 * 页面内确认弹窗（复用 backdrop + modal 既有骨架的紧凑版）：
 * 替代原生 window.confirm——宿主以 iframe 渲染面板且未授予 allow-modals 时，
 * 原生 confirm 会被静默拒绝，页面内弹窗无此限制。
 * 取消、点击背景或 Esc 均不产生任何写入；只有显式点击确认按钮才执行。
 */
export function ConfirmDialog({ title, message, confirmText, danger = false, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLang();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // 默认焦点落在取消上：误按回车不会触发危险操作
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <>
      <div className="backdrop confirm-backdrop" onClick={onCancel} aria-hidden="true" />
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-modal-title">{title}</div>
        <p className="confirm-modal-message">{message}</p>
        <div className="confirm-modal-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </>
  );
}
