window.__ModuleLoader__.load({
  id: 'xiaozhushou-harness-host',
  factory: function (require) {
    const React = require('react'), h = React.createElement;
    function apply(ctx) {
      const listeners = new Set(); let opened = false;
      function toggle(value) { opened = value; for (const listener of listeners) listener(value); }
      function Button() { return h('button', { type: 'button', title: '打开小助手与微信', onClick: () => toggle(true), style: { border: '1px solid #bbd1c5', borderRadius: 8, padding: '5px 12px', color: '#22533c', background: '#f1f7f2', cursor: 'pointer' } }, '小助手 · 微信'); }
      function Overlay() {
        const [open, setOpen] = React.useState(opened);
        const button = React.useRef(null);
        React.useEffect(() => { listeners.add(setOpen); return () => listeners.delete(setOpen); }, []);
        React.useEffect(() => {
          if (!open) return;
          const previous = document.activeElement;
          button.current?.focus();
          const keydown = event => { if (event.key === 'Escape') toggle(false); };
          document.addEventListener('keydown', keydown);
          return () => { document.removeEventListener('keydown', keydown); previous?.focus?.(); };
        }, [open]);
        if (!open) return null;
        return h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '小助手与微信', style: { position: 'fixed', inset: 16, zIndex: 10000, display: 'flex', flexDirection: 'column', background: '#f8f7f2', border: '1px solid #cbd7ce', borderRadius: 12, boxShadow: '0 15px 60px #0003', overflow: 'hidden' } },
          h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 16px', borderBottom: '1px solid #dce3dd' } }, h('strong', null, '小助手 · 微信与工作台'), h('button', { type: 'button', ref: button, onClick: () => toggle(false), style: { cursor: 'pointer', border: 0, background: 'transparent', padding: 8 } }, '返回 DSH ×')),
          h('iframe', { title: '小助手工作台', src: '/xiaozhushou/', style: { flex: 1, border: 0, width: '100%', minHeight: 0 } }));
      }
      function Settings() { return h('div', { style: { padding: 24 } }, h('h2', null, '小助手与微信'), h('p', null, '微信连接、持续会话、任务、邮箱与技能，统一在 DSH 内使用。'), h(Button)); }
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'xiaozhushou:open', order: 22 }, Button));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'xiaozhushou:panel', order: 1100 }, Overlay));
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'xiaozhushou', order: 47, label: () => '小助手与微信' }, Settings));
      ctx.effect(() => () => { opened = false; listeners.clear(); }, 'xiaozhushou: panel lifecycle');
    }
    return { name: 'xiaozhushou', inject: ['slots'], apply };
  }
});
