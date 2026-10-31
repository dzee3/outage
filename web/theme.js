// Applied before the page paints so a light-theme reload never flashes dark.
try {
  if (localStorage.getItem('theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  /* storage blocked: dark */
}
