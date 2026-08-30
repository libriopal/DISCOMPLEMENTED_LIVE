// No-flash theme initialization — runs before React loads.
//
// The stored value is a PREFERENCE and may be the literal 'system'; the
// attribute stamped on <html> is always a concrete theme id. Those are not the
// same thing and conflating them is the bug this file exists to avoid.
//
// "System" cannot be implemented by leaving the attribute off. `generated-tokens.css`
// gives the bare `:root` the DARK app tokens (`[data-theme='dark'], :root { … }`)
// while `dual-theme.css` gives the bare `:root` the LIGHT parchment palette — an
// unstamped document is therefore a mix of the two, not a theme. So the system
// preference is RESOLVED here and re-resolved on change (see ThemeToggle), rather
// than delegated to the cascade.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('bicameral-theme');
  } catch (e) {
    /* privacy mode; fall through to the system preference */
  }

  // Absent has always meant "follow the system"; 'system' is the same state made
  // explicit, so a reader who has chosen can get back to it.
  if (!stored || stored === 'system') {
    stored =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
  }
  document.documentElement.setAttribute('data-theme', stored);
})();
