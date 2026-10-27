// Adapter for the existing product UI. Only the transport changes from IPC.
const base = new URL('./', location.href);
async function rpc(name, args = []) {
  const response = await fetch(new URL('rpc/' + name, base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaozhushou-UI': '1' }, body: JSON.stringify(args), credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Error(result.error || '小助手暂时不可用。');
  return result.value;
}
const methods = METHODS_PLACEHOLDER;
const api = Object.fromEntries(methods.map(name => [name, (...args) => rpc(name, args)]));
api.onChange = callback => {
  let revision, stopped = false, timer;
  async function poll() {
    if (stopped) return;
    try {
      const response = await fetch(new URL('state', base), { headers: { 'X-Xiaozhushou-UI': '1' }, cache: 'no-store' });
      if (response.ok) { const current = await response.json(); if (revision !== undefined && current.revision !== revision) callback(); revision = current.revision; }
    } catch {}
    if (!stopped) timer = setTimeout(poll, document.hidden ? 5000 : 1000);
  }
  void poll();
  const stop = () => { stopped = true; clearTimeout(timer); };
  window.addEventListener('pagehide', stop, { once: true });
  return stop;
};
window.assistant = Object.freeze(api);
