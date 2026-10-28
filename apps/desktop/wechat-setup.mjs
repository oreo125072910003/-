import { createPortableWechat } from '../../packages/wechat-bridge/portable.mjs';
import { PORTABLE_WECHAT_METHODS } from '../../packages/contracts/ui-service-methods.mjs';

/** Adapt the shared first-run workflow to trusted desktop IPC. No second service. */
export function createDesktopWechatSetup({ packageRoot, payloadRoot, dataDir, getService, onChange, dependencies } = {}) {
  const portable = createPortableWechat({ packageRoot, payloadRoot, dataDir, onChange, dependencies });
  return {
    async invoke(method, args = []) {
      if (!PORTABLE_WECHAT_METHODS.includes(method)) throw Error('没有这个微信准备操作。');
      if (method === 'getPortableWechatState') {
        const current = await getService().getWechatState();
        return { ...portable.status(), connectionImported: current.settings.connectionImported === true };
      }
      if (method === 'preparePortableWechat') return portable.prepare();
      if (method === 'openPortableWechat') return portable.open();
      if (method === 'discoverPortableWechat') return portable.discover();
      return portable.bind({ accountId: args[0]?.accountId }, getService());
    },
    close: () => portable.close()
  };
}
