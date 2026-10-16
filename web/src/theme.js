// Dark by default. The choice is remembered on this device only.
const KEY = 'theme';

const read = () => {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

export function applyTheme(theme = read()) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f6fb' : '#0b0d1a');
  return theme;
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be blocked; the theme still applies for this visit.
  }
  return applyTheme(theme);
}

export const currentTheme = read;
