// Node derives navigator.language from the host locale on Windows, ignoring
// LANG/LC_ALL. Pin only the browser-facing default; i18n tests can override it.
Object.defineProperty(globalThis.navigator, 'language', {
  configurable: true,
  enumerable: true,
  value: 'en-US',
});
