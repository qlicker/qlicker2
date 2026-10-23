import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English is bundled synchronously: it is the fallback language, so it must be
// available immediately for any missing key in another locale. Every other
// locale is loaded on demand (see lazyBackend below) so users only download the
// language they actually use instead of all of them up front.
import en from './locales/en.json';

// Dynamic import() calls, one per lazily-loaded locale. Each becomes its own
// async chunk that Vite only fetches when the locale is first selected.
const localeLoaders = {
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  it: () => import('./locales/it.json'),
  pir: () => import('./locales/pir.json'),
  ru: () => import('./locales/ru.json'),
  zh: () => import('./locales/zh.json'),
};

// Minimal i18next backend that resolves a locale's messages by dynamic import.
// Using a backend (rather than loading manually) means i18next drives the load
// automatically for both the initially detected language and any later
// changeLanguage() call, so existing callers need no changes.
const lazyBackend = {
  type: 'backend',
  init: () => {},
  read: (language, namespace, callback) => {
    if (language === 'en') {
      callback(null, en);
      return;
    }
    const loader = localeLoaders[language];
    if (!loader) {
      // Unknown locale: fall back to English rather than erroring.
      callback(null, en);
      return;
    }
    loader()
      .then((module) => callback(null, module.default))
      .catch((error) => callback(error, null));
  },
};

// The init promise resolves once the initial (detected) language has loaded.
// main.jsx awaits this before the first render so non-English users do not see
// a flash of English while their locale chunk is fetched.
export const i18nReady = i18n
  .use(lazyBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Only English is bundled; the backend supplies the rest on demand.
    resources: {
      en: { translation: en },
    },
    partialBundledLanguages: true,
    fallbackLng: 'en',
    showSupportNotice: false,
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'qlicker_locale',
      caches: ['localStorage'],
    },
    react: {
      // We await i18nReady before the initial render and keep showing the
      // previous language until a newly selected one loads, so Suspense is
      // unnecessary and would otherwise crash without a boundary on switch.
      useSuspense: false,
    },
  });

export default i18n;

/**
 * Supported locales with human-readable labels.
 * Used by the admin panel locale selector and anywhere locale choices are presented.
 */
export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'zh', label: '中文' },
  { code: 'pir', label: 'Pirate' },
];

/**
 * Available date-format presets.
 * The `key` is stored in Settings; the `example` shows a sample rendering.
 */
export const DATE_FORMATS = [
  { key: 'DD-MMM-YYYY', example: '11-Jan-2026' },
  { key: 'MMM-DD-YYYY', example: 'Jan-11-2026' },
  { key: 'YYYY-MM-DD', example: '2026-01-11' },
];

export const TIME_FORMATS = [
  { key: '24h', example: '14:30' },
  { key: '12h', example: '2:30 PM' },
];

/**
 * Default date format key. DD-MMM-YYYY gives "11-Jan-2026".
 */
export const DEFAULT_DATE_FORMAT = 'DD-MMM-YYYY';

/**
 * Default locale.
 */
export const DEFAULT_LOCALE = 'en';
