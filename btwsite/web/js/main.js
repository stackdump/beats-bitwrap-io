import { App } from './app.js';

const app = new App();
window.__app = app;
app.start().catch((e) => {
  console.error('btw: start failed', e);
  const t = document.getElementById('toasts');
  if (t) t.textContent = `btw could not start: ${e && e.message ? e.message : e}`;
});
