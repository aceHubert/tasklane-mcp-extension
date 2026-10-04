import { useLang } from '../i18n';
import { useBoard } from '../state/BoardContext';
import { hostBlockReason } from '../host';

/** 展示本次真实握手，实际原生能力由具体任务请求核对。 */
export function HostConnection() {
  const { hostSnapshot: snapshot } = useBoard();
  const { t } = useLang();
  const reason = hostBlockReason(snapshot) ?? (!snapshot.capabilities.message?.text ? 'message' : null);
  const absent = t('native.connection.notProvided');

  return (
    <details className="sec host-connection">
      <summary>{t('native.connection.title')}</summary>
      <dl className="host-connection-facts">
        <dt>{t('native.connection.appsName')}</dt><dd>{snapshot.info?.name ?? absent}</dd>
        <dt>{t('native.connection.appsVersion')}</dt><dd>{snapshot.info?.version ?? absent}</dd>
        <dt>{t('native.connection.clientName')}</dt><dd>{snapshot.mcpClient?.name ?? absent}</dd>
        <dt>{t('native.connection.clientVersion')}</dt><dd>{snapshot.mcpClient?.version ?? absent}</dd>
        <dt>{t('native.connection.identity')}</dt>
        <dd>{t(snapshot.identity === 'codex' ? 'native.connection.codex' : 'native.connection.unknown')}</dd>
        <dt>{t('native.connection.handshake')}</dt>
        <dd>{t(snapshot.connected ? 'native.connection.connected' : 'native.connection.disconnected')}</dd>
      </dl>
      <p className="native-reason">{t(reason ? `native.reason.${reason}` : 'native.connection.ready')}</p>
    </details>
  );
}
