import { useLang, type Lang } from '../i18n';

const OPTIONS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中' },
  { value: 'en', label: 'EN' },
];

/** Header 右上角的中英文切换：分段控件，选择持久化在 localStorage */
export function LangSwitch() {
  const { lang, setLang, t } = useLang();
  return (
    <div className="segmented lang-switch" role="radiogroup" aria-label={t('lang.aria')}>
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={lang === opt.value}
          className={`seg${lang === opt.value ? ' active' : ''}`}
          onClick={() => setLang(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
