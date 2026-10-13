// 在 styles.css 加载前同步设置主题，避免页面首帧先使用默认深色变量。
(() => {
  const params = new URLSearchParams(window.location.search);
  const mode = ['dark', 'light', 'system'].includes(params.get('theme'))
    ? params.get('theme')
    : 'dark';
  const resolved = mode === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : mode;
  const root = document.documentElement;
  root.dataset.themeMode = mode;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
})();
