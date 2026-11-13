/**
 * English and Chinese, as inline pairs: `t("Saved", "已保存")`. The language is picked once per
 * run, from `--lang`, then CC_REMOTE_LANG, then the locale; anything starting with `zh` is Chinese.
 */
export type Lang = "en" | "zh";

let current: Lang = "en";

/** The language for these flags and this environment. */
export function detectLang(env: Record<string, string | undefined>, flag?: string): Lang {
  // The first non-empty of these decides, as the C library does for LC_MESSAGES.
  const locale = [flag, env.CC_REMOTE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v?.trim());
  return locale && /^zh/i.test(locale.trim()) ? "zh" : "en";
}

export const setLang = (lang: Lang) => {
  current = lang;
};

export const lang = () => current;

/** The text in the current language. */
export const t = (en: string, zh: string) => (current === "zh" ? zh : en);
