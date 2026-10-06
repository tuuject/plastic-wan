import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import i18n, { LANGUAGE_KEY, resolveInitialLanguage, setLanguage } from './i18n.ts';

/**
 * Default language resolved when this module was imported; the vitest setup
 * pins `navigator.language` to `en-US`, so this is `en` on every machine.
 */
const initialLanguage = i18n.language;

function setBrowserLanguage(language: string): void {
  Object.defineProperty(globalThis.navigator, 'language', { configurable: true, value: language });
}

/** Minimal localStorage stand-in; `vi.unstubAllGlobals()` restores the real globals. */
function stubStorage(entries: Record<string, string> = {}): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries[key] ?? null,
    setItem: vi.fn(),
  });
}

beforeEach(() => {
  setBrowserLanguage('en-US');
});

afterEach(async () => {
  await i18n.changeLanguage(initialLanguage);
  vi.unstubAllGlobals();
  setBrowserLanguage('en-US');
});

describe('resolveInitialLanguage', () => {
  test('a stored preference wins over the browser language', () => {
    stubStorage({ [LANGUAGE_KEY]: 'zh-CN' });
    expect(resolveInitialLanguage()).toBe('zh-CN');

    setBrowserLanguage('zh-CN');
    stubStorage({ [LANGUAGE_KEY]: 'en' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  test('a Chinese browser language selects zh-CN', () => {
    stubStorage();
    setBrowserLanguage('zh-CN');
    expect(resolveInitialLanguage()).toBe('zh-CN');

    setBrowserLanguage('zh-TW');
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });

  test('any other browser language falls back to English', () => {
    stubStorage();
    setBrowserLanguage('en-US');
    expect(resolveInitialLanguage()).toBe('en');

    setBrowserLanguage('fr-FR');
    expect(resolveInitialLanguage()).toBe('en');
  });

  test('an unrecognized stored value is ignored', () => {
    setBrowserLanguage('zh-CN');
    stubStorage({ [LANGUAGE_KEY]: 'de-AT' });
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });

  test('unavailable storage falls through to the browser language', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    });

    expect(resolveInitialLanguage()).toBe('en');

    setBrowserLanguage('zh-CN');
    expect(resolveInitialLanguage()).toBe('zh-CN');
  });
});

describe('language switching', () => {
  test('setLanguage persists the choice, marks the document and switches translations', () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    });
    vi.stubGlobal('document', { documentElement: { lang: '' } });

    setLanguage('zh-CN');
    expect(entries.get(LANGUAGE_KEY)).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(i18n.t('common.requestFailed')).toBe('请求失败');

    setLanguage('en');
    expect(entries.get(LANGUAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(i18n.t('common.requestFailed')).toBe('Request failed');
  });

  test('a chosen language is what a reload resolves from storage', () => {
    const entries = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    });
    vi.stubGlobal('document', { documentElement: { lang: '' } });

    setLanguage('zh-CN');
    expect(resolveInitialLanguage()).toBe('zh-CN');

    setLanguage('en');
    expect(resolveInitialLanguage()).toBe('en');
  });

  test('unavailable storage does not break setLanguage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    });
    vi.stubGlobal('document', { documentElement: { lang: '' } });

    expect(() => setLanguage('zh-CN')).not.toThrow();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  test('the Chinese catalog still mirrors the English keys these tests rely on', async () => {
    expect(i18n.t('common.requestFailed')).toBe('Request failed');
    expect(i18n.t('pages.memories.ttlUnitDays')).toBe('d');

    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('common.requestFailed')).toBe('请求失败');
    expect(i18n.t('pages.memories.ttlUnitDays')).toBe('天');
  });
});
