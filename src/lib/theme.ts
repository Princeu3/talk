export type Theme = 'system' | 'light' | 'dark'

// Matches --color-bg; the status bar takes its color from theme-color.
const BG = { light: '#e8e9df', dark: '#12170f' }

// Per-device choice, so localStorage is enough; it can throw in private modes.
export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem('theme')
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') localStorage.removeItem('theme')
    else localStorage.setItem('theme', t)
  } catch {
    // still applies for this visit
  }
  applyTheme(t)
}

// index.html sets data-theme before first paint; this also keeps the two
// media-scoped theme-color tags in step with a pinned choice.
export function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'system') delete root.dataset.theme
  else root.dataset.theme = t
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    m.content = BG[t === 'system' ? (m.media.includes('dark') ? 'dark' : 'light') : t]
}
