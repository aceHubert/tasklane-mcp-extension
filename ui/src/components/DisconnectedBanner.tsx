import { useBoard } from '../state/BoardContext';
import { useLang } from '../i18n';
import { AlertIcon } from './icons';

export function DisconnectedBanner() {
  const { conn } = useBoard();
  const { t } = useLang();
  if (conn === 'connected') return null;
  const text = conn === 'connecting' ? t('banner.connecting') : t('banner.disconnected');
  return (
    <div className="banner-warn" role="alert">
      <AlertIcon />
      <span>{text}</span>
      <span className="banner-note">{t('banner.note')}</span>
    </div>
  );
}
