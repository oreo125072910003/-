const QUOTA = Object.freeze({
  code: 'ACCOUNT_QUOTA',
  message: 'DeepSeek 账户余额或额度不足（402），当前无法生成回复。请在 DeepSeek Harness 中处理账户余额后再试。',
});
const AUTH = Object.freeze({ code: 'ACCOUNT_AUTH', message: 'DSH 当前登录已失效，请在 DeepSeek Harness 中重新登录后再试。' });
const ENDPOINT = Object.freeze({ code: 'MODEL_ENDPOINT', message: 'DSH 的模型接口地址不匹配，请在 DeepSeek Harness 中检查接口配置后再试。' });
const RATE = Object.freeze({ code: 'MODEL_RATE_LIMIT', message: 'DSH 当前请求过于频繁，请稍后再试。' });

// Only return fixed product text. Provider errors may contain account details,
// request IDs or credentials and must never become an outbound chat message.
export function knownModelFailure(error) {
  const saved = [QUOTA, AUTH, ENDPOINT, RATE].find(item => item.code === error?.code || item.message === error?.message);
  if (saved) return { ...saved };
  if (error?.code === QUOTA.code || error?.status === 402 || error?.httpStatus === 402 || error?.message === QUOTA.message) return { ...QUOTA };
  if (['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID'].includes(error?.code) || error?.status === 401) return { ...AUTH };
  if (error?.status === 404) return { ...ENDPOINT };
  if (error?.status === 429) return { ...RATE };
  return null;
}
