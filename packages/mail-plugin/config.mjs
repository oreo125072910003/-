import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { boundedText, safeId } from '../contracts/index.mjs';

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label}格式无效。`);
  return value;
}

export function plain(value, label, maximum, { empty = false } = {}) {
  const text = boundedText(value, label, maximum, { empty });
  if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw Error(`${label}含有无效控制字符。`);
  return text;
}

export function email(value, label = '邮箱地址') {
  const text = plain(value, label, 320);
  const at = text.lastIndexOf('@');
  const local = text.slice(0, at), domain = domainToASCII(text.slice(at + 1)).toLowerCase();
  if (at < 1 || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain || domain.length > 253 || !domain.includes('.') || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw Error(`${label}无效，请单独填写完整邮箱地址。`);
  }
  return `${local}@${domain}`;
}

export function addresses(values, label, { required = false } = {}) {
  if (!Array.isArray(values) || values.length > 50 || (required && !values.length)) throw Error(`${label}须是最多 50 个邮箱地址的数组。`);
  return [...new Set(values.map(value => email(value, label)))];
}

function server(value, protocol, address) {
  object(value, `${protocol} 设置`);
  const rawHost = plain(value.host, `${protocol} 服务器`, 253);
  const host = isIP(rawHost) ? rawHost : domainToASCII(rawHost).toLowerCase();
  if (!host || (!isIP(host) && host.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))) throw Error(`${protocol} 服务器须是域名或 IP 地址。`);
  if (value.secure !== undefined && typeof value.secure !== 'boolean') throw Error(`${protocol} 的 secure 须为布尔值。`);
  const secure = value.secure ?? true;
  const port = value.port ?? (protocol === 'IMAP' ? secure ? 993 : 143 : secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error(`${protocol} 端口无效。`);
  const result = { host, port, secure, username: plain(value.username ?? address, `${protocol} 用户名`, 320) };
  if (protocol === 'IMAP') result.mailbox = plain(value.mailbox ?? 'INBOX', '收件文件夹', 256);
  return result;
}

function credential(value, label) {
  object(value, label);
  if (value.type === 'password') {
    plain(value.password, `${label}密码或授权码`, 8192);
    return { type: 'password', password: value.password };
  }
  if (value.type === 'oauth2') {
    const result = { type: 'oauth2', accessToken: plain(value.accessToken, `${label}访问令牌`, 16384) };
    if (value.expiresAt !== undefined) {
      const time = Date.parse(value.expiresAt);
      if (!Number.isFinite(time)) throw Error('访问令牌过期时间无效。');
      result.expiresAt = new Date(time).toISOString();
    }
    return result;
  }
  throw Error(`${label}仅支持 password 授权码或 oauth2 访问令牌。`);
}

export function accountInput(value) {
  object(value, '邮箱账号');
  const address = email(value.address), imap = server(value.imap, 'IMAP', address);
  const smtp = value.smtp ? server(value.smtp, 'SMTP', address) : null;
  const auth = credential(value.auth, '收信凭据');
  return {
    id: value.id === undefined ? null : safeId(value.id),
    name: plain(value.name ?? address, '邮箱名称', 100), address, imap, smtp,
    credentials: { imap: auth, smtp: value.smtpAuth ? credential(value.smtpAuth, '发信凭据') : auth }
  };
}

export function importInput(input) {
  let value = input;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 262144) throw Error('邮箱配置文件过大。');
    try { value = JSON.parse(value.replace(/^\uFEFF/, '')); } catch { throw Error('邮箱配置须为有效 JSON。'); }
  }
  object(value, '邮箱配置');
  if (!Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > 20) throw Error('每次可导入 1 至 20 个邮箱账号。');
  return value.accounts.map(accountInput);
}

export function runtimeAuth(account, credentials, protocol) {
  const auth = credentials?.[protocol];
  if (!auth) throw Error('邮箱凭据缺失，请重新导入账号配置。');
  if (auth.type === 'oauth2' && auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) throw Error('邮箱访问令牌已过期，请重新授权并导入。');
  const user = account[protocol].username;
  return auth.type === 'oauth2' ? protocol === 'imap' ? { user, accessToken: auth.accessToken } : { type: 'OAuth2', user, accessToken: auth.accessToken } : { user, pass: auth.password };
}
