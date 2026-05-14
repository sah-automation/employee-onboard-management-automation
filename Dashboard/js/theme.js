// ── Theme management ──────────────────────────────────────
const STORAGE_KEY = 'tanisitech-theme';

export function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  const theme = saved || (systemDark ? 'dark' : 'light');
  setTheme(theme);
}

export function setTheme(theme) {
  if (theme === 'light') {
    document.documentElement.classList.add('light-theme');
  } else {
    document.documentElement.classList.remove('light-theme');
  }
  localStorage.setItem(STORAGE_KEY, theme);
}

export function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light-theme');
  setTheme(isLight ? 'dark' : 'light');
}

export function getTheme() {
  return document.documentElement.classList.contains('light-theme') ? 'light' : 'dark';
}
