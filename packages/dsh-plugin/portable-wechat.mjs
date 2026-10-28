import fs from 'node:fs';

// Both entry points use the same preparation and account-binding implementation.
const moduleUrl = new URL(fs.existsSync(new URL('./payload/', import.meta.url)) ? './payload/packages/wechat-bridge/portable.mjs' : '../wechat-bridge/portable.mjs', import.meta.url);
export const { createPortableWechat } = await import(moduleUrl.href);
