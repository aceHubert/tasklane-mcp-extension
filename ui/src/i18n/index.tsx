import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyLang,
  getCurrentLang,
  translate,
  type Lang,
  type MessageKey,
  type MessageParams,
} from './messages';

export type { Lang, MessageKey, MessageParams };

interface LangContextValue {
  lang: Lang;
  setLang(lang: Lang): void;
  /** 组件内取词：订阅语言变化，切换后随重渲染刷新 */
  t(key: MessageKey, params?: MessageParams): string;
}

const LangContext = createContext<LangContextValue | null>(null);

/** 语言提供者：挂在 BoardProvider 之外，保证状态层 toast 也能取词 */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(getCurrentLang);

  // 挂载即同步 <html lang>：index.html 的静态 zh-CN 只防闪白，真实语言以检测/存储为准
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    applyLang(next);
    setLangState(next);
  }, []);

  // applyLang 在 setState 前同步更新模块级语言，hook 版 t 直接委托即可；
  // 闭包捕获 lang 只为让 value 随语言变化生成新引用，驱动消费组件重渲染
  const value = useMemo<LangContextValue>(
    () => ({ lang, setLang, t: translate }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
