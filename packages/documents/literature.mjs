import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';

const DEFAULT_ENDPOINTS = Object.freeze({ crossref: 'https://api.crossref.org/works', arxiv: 'https://export.arxiv.org/api/query', openalex: 'https://api.openalex.org/works' });
const PROVIDERS = Object.freeze(Object.keys(DEFAULT_ENDPOINTS));
function coded(code, message) { return Object.assign(new Error(message), { code }); }
function simpleText(value, max = 4096) { return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''; }
function integer(value, fallback, minimum, maximum, label) { const selected = value ?? fallback; if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw coded('INVALID_INPUT', `${label}无效。`); return selected; }
function doiOf(value) { if (typeof value !== 'string') return null; let doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, ''); try { doi = decodeURIComponent(doi); } catch {} return /^10\.\d{4,9}\/[^\s<>"{}]+$/i.test(doi) && doi.length <= 512 ? doi.toLowerCase() : null; }
function urlOf(value) { if (typeof value !== 'string' || value.length > 2048) return null; try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function yearOf(value) { const year = Number(value); return Number.isSafeInteger(year) && year >= 1500 && year <= 2200 ? year : null; }
function authorsOf(values) { return Array.isArray(values) ? values.slice(0, 100).map(author => { if (typeof author === 'string') return { name: simpleText(author, 256) }; const given = simpleText(author?.given, 128), family = simpleText(author?.family, 128), name = simpleText(author?.name, 256) || [given, family].filter(Boolean).join(' '); return { name, ...(given ? { given } : {}), ...(family ? { family } : {}) }; }).filter(author => author.name) : []; }
function normalizeArxivId(value) { if (typeof value !== 'string') return null; const match = value.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)(?:\.pdf)?$/i); return match ? match[1] : null; }
function source(provider, recordId, url, queriedAt) { return { provider, recordId, url, retrievedAt: queriedAt }; }
function crossrefItem(item, queriedAt) {
  const doi = doiOf(item.DOI), title = simpleText(Array.isArray(item.title) ? item.title[0] : item.title); if (!doi || !title) return null; const url = `https://doi.org/${doi}`, date = item.published?.['date-parts']?.[0] ?? item['published-print']?.['date-parts']?.[0] ?? item['published-online']?.['date-parts']?.[0] ?? item.issued?.['date-parts']?.[0];
  const abstract = simpleText(item.abstract, 16000);
  return { id: `doi:${doi}`, doi, arxivId: null, openalexId: null, title, authors: authorsOf(item.author), year: yearOf(date?.[0]), venue: simpleText(item['container-title']?.[0], 512) || null, type: simpleText(item.type, 80) || 'unknown', url, abstract: abstract || null, evidenceLevel: abstract ? 'abstract' : 'metadata', fullTextRetrieved: false, sources: [source('crossref', doi, url, queriedAt)], metadataConflicts: [], warnings: [] };
}
function xmlChildren(parent, name) { return Array.from(parent.childNodes ?? []).filter(node => node.nodeType === 1 && node.localName === name); }
function xmlText(parent, name) { return simpleText(xmlChildren(parent, name)[0]?.textContent, 16000); }
function parseArxiv(xml, queriedAt) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw coded('UNSAFE_XML', '学术接口返回了不支持的 XML 实体声明。');
  let document; try { document = new DOMParser({ onError: () => { throw coded('INVALID_RESPONSE', 'arXiv 返回的 XML 格式无效。'); } }).parseFromString(xml, 'application/xml'); } catch { throw coded('INVALID_RESPONSE', 'arXiv 返回的 XML 格式无效。'); }
  const feed = document.documentElement; if (feed?.localName !== 'feed') throw coded('INVALID_RESPONSE', 'arXiv 没有返回标准 Atom feed。');
  const entries = xmlChildren(feed, 'entry'); if (entries.length > 100) throw coded('RESPONSE_LIMIT', 'arXiv 单页结果数量超过限制。');
  const items = [];
  for (const entry of entries) {
    const rawId = xmlText(entry, 'id'), arxivId = normalizeArxivId(rawId), title = xmlText(entry, 'title'); if (!arxivId || !title) { if (/api\/errors/i.test(rawId)) throw coded('SOURCE_REJECTED_QUERY', 'arXiv 拒绝了本次查询。'); continue; }
    const doi = doiOf(xmlText(entry, 'doi')), url = `https://arxiv.org/abs/${arxivId}`, abstract = xmlText(entry, 'summary');
    items.push({ id: doi ? `doi:${doi}` : `arxiv:${arxivId.replace(/v\d+$/, '')}`, doi, arxivId, openalexId: null, title, authors: authorsOf(xmlChildren(entry, 'author').map(author => xmlText(author, 'name'))), year: yearOf(xmlText(entry, 'published').slice(0, 4)), venue: xmlText(entry, 'journal_ref') || null, type: 'preprint', url, abstract: abstract || null, evidenceLevel: abstract ? 'abstract' : 'metadata', fullTextRetrieved: false, sources: [source('arxiv', arxivId, url, queriedAt)], metadataConflicts: [], warnings: [] });
  }
  const totalText = xmlText(feed, 'totalResults'), total = /^\d+$/.test(totalText) ? Number(totalText) : null; return { items, total, rawCount: entries.length };
}
function invertedAbstract(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return null; const words = new Map();
  for (const [word, positions] of Object.entries(index).slice(0, 3000)) { if (word.length > 128 || !Array.isArray(positions) || positions.length > 1000) continue; for (const position of positions) if (Number.isSafeInteger(position) && position >= 0 && position < 4000) words.set(position, word); }
  return simpleText([...words.entries()].sort((a, b) => a[0] - b[0]).map(([, word]) => word).join(' '), 16000) || null;
}
function openalexItem(item, queriedAt) {
  const openalexId = typeof item.id === 'string' ? item.id.match(/^https:\/\/openalex\.org\/(W\d+)$/)?.[1] : null, doi = doiOf(item.doi), title = simpleText(item.title ?? item.display_name); if (!openalexId || !title) return null; const url = doi ? `https://doi.org/${doi}` : `https://openalex.org/${openalexId}`, abstract = invertedAbstract(item.abstract_inverted_index);
  return { id: doi ? `doi:${doi}` : `openalex:${openalexId}`, doi, arxivId: null, openalexId, title, authors: authorsOf(item.authorships?.slice(0, 100).map(value => value.author?.display_name)), year: yearOf(item.publication_year), venue: simpleText(item.primary_location?.source?.display_name, 512) || null, type: simpleText(item.type, 80) || 'unknown', url, abstract, evidenceLevel: abstract ? 'abstract' : 'metadata', fullTextRetrieved: false, sources: [source('openalex', openalexId, `https://openalex.org/${openalexId}`, queriedAt)], metadataConflicts: [], warnings: [] };
}
function titleKey(title) { return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function mergeRecords(items) {
  const merged = new Map();
  for (const item of items) {
    const key = item.doi ? `doi:${item.doi}` : item.arxivId ? `arxiv:${item.arxivId.replace(/v\d+$/, '')}` : item.id; const existing = merged.get(key);
    if (!existing) { merged.set(key, structuredClone(item)); continue; }
    for (const field of ['title', 'year']) { const old = existing[field], value = item[field]; if (old !== null && value !== null && (field === 'title' ? titleKey(old) !== titleKey(value) : old !== value)) existing.metadataConflicts.push({ field, values: [old, value], sources: [existing.sources[0].provider, item.sources[0].provider] }); }
    for (const entry of item.sources) if (!existing.sources.some(source => source.provider === entry.provider && source.recordId === entry.recordId)) existing.sources.push(entry);
    existing.arxivId ??= item.arxivId; existing.openalexId ??= item.openalexId; existing.abstract ??= item.abstract; existing.evidenceLevel = existing.abstract ? 'abstract' : 'metadata'; if (!existing.authors.length) existing.authors = item.authors; existing.year ??= item.year; existing.venue ??= item.venue;
  }
  return [...merged.values()];
}
function signalPause(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) { reject(coded('CANCELLED', '文献检索已取消。')); return; } const abort = () => { clearTimeout(timer); reject(coded('CANCELLED', '文献检索已取消。')); }, timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms); signal?.addEventListener('abort', abort, { once: true }); }); }

export function createLiteratureClient({ fetchImpl = globalThis.fetch, clock = () => new Date(), timeoutMs = 10000, maxResponseBytes = 2 * 1024 * 1024, pageSize = 20, maxPages = 5, openalexApiKey, endpoints, allowLoopbackForTests = false, arxivIntervalMs = 3000 } = {}) {
  const selectedEndpoints = { ...DEFAULT_ENDPOINTS }; timeoutMs = integer(timeoutMs, 10000, 50, 30000, '请求时限'); maxResponseBytes = integer(maxResponseBytes, 2 * 1024 * 1024, 1024, 4 * 1024 * 1024, '响应大小'); pageSize = integer(pageSize, 20, 1, 50, '每页数量'); maxPages = integer(maxPages, 5, 1, 10, '分页数量'); arxivIntervalMs = integer(arxivIntervalMs, 3000, 0, 30000, 'arXiv请求间隔');
  if (arxivIntervalMs < 3000 && !allowLoopbackForTests) throw coded('INVALID_ENDPOINT', '生产 arXiv 请求间隔不得低于三秒。');
  if (endpoints) for (const [provider, value] of Object.entries(endpoints)) { if (!PROVIDERS.includes(provider)) throw coded('INVALID_ENDPOINT', '不支持此学术来源。'); const url = new URL(value); if (!allowLoopbackForTests || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw coded('INVALID_ENDPOINT', '仅测试配置可以显式使用 loopback 学术接口。'); selectedEndpoints[provider] = url.href; }
  if (typeof fetchImpl !== 'function') throw coded('INVALID_ADAPTER', '当前环境没有可用的 HTTP 客户端。'); if (openalexApiKey !== undefined && (typeof openalexApiKey !== 'string' || /[\r\n\0]/.test(openalexApiKey))) throw coded('INVALID_CREDENTIAL', 'OpenAlex 安全凭据无效。');
  let lastArxivRequest = 0, arxivLock = Promise.resolve();
  async function get(url, provider, signal) {
    const controller = new AbortController(); let rejectTimeout; const parentAbort = () => controller.abort(); signal?.addEventListener('abort', parentAbort, { once: true }); if (signal?.aborted) parentAbort(); let timedOut = false;
    const timeout = new Promise((resolve, reject) => { rejectTimeout = reject; }); const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(coded('TIMEOUT', '学术来源响应超时。')); }, timeoutMs);
    const operation = (async () => {
      if (controller.signal.aborted) throw coded('CANCELLED', '文献检索已取消。');
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: provider === 'arxiv' ? 'application/atom+xml, application/xml' : 'application/json', 'User-Agent': 'XiaoZhuShou-Literature/0.1 (metadata search)', ...(provider === 'openalex' && openalexApiKey ? { Authorization: `Bearer ${openalexApiKey}` } : {}) } });
      if (response.status === 429) throw coded('RATE_LIMITED', '学术来源限制请求频率，请稍后重试。'); if ([401, 403].includes(response.status)) throw coded('AUTH_REQUIRED', '此学术来源需要有效授权或接口密钥。'); if (!response.ok) throw coded('SOURCE_HTTP_ERROR', '学术来源返回了 HTTP 错误。');
      const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > maxResponseBytes) { await response.body?.cancel(); throw coded('RESPONSE_TOO_LARGE', '学术来源返回内容超过大小限制。'); }
      if (!response.body) throw coded('INVALID_RESPONSE', '学术来源没有返回可读取的数据。'); const reader = response.body.getReader(); let total = 0; const chunks = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxResponseBytes) throw coded('RESPONSE_TOO_LARGE', '学术来源返回内容超过大小限制。'); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); } catch { throw coded('INVALID_RESPONSE', '学术来源没有返回有效 UTF-8 数据。'); }
    })();
    try { return await Promise.race([operation, timeout]); } catch (error) { if (timedOut) throw coded('TIMEOUT', '学术来源响应超时。'); if (signal?.aborted) throw coded('CANCELLED', '文献检索已取消。'); if (error.code && /^[A-Z_]+$/.test(error.code)) throw error; throw coded('NETWORK_FAILED', '无法连接学术来源，没有生成替代引文。'); } finally { clearTimeout(timer); signal?.removeEventListener('abort', parentAbort); controller.abort(); }
  }
  async function retrieve(provider, query, limit, years, queriedAt, signal) {
    const items = [], cursors = new Set(); let cursor = '*', pages = 0, invalidRecords = 0, lastCount = 0, hasMore = false;
    for (let page = 0; page < maxPages && items.length < limit; page++) {
      if (signal?.aborted) throw coded('CANCELLED', '文献检索已取消。'); const rows = Math.min(pageSize, limit - items.length), url = new URL(selectedEndpoints[provider]);
      if (provider === 'crossref') { url.searchParams.set('query.bibliographic', query); url.searchParams.set('rows', String(rows)); url.searchParams.set('cursor', cursor); const filter = [years.from ? `from-pub-date:${years.from}-01-01` : '', years.to ? `until-pub-date:${years.to}-12-31` : ''].filter(Boolean); if (filter.length) url.searchParams.set('filter', filter.join(',')); }
      if (provider === 'arxiv') { url.searchParams.set('search_query', `all:${JSON.stringify(query)}${years.from || years.to ? ` AND submittedDate:[${years.from ?? 1500}01010000 TO ${years.to ?? 2200}12312359]` : ''}`); url.searchParams.set('start', String(page * pageSize)); url.searchParams.set('max_results', String(rows)); url.searchParams.set('sortBy', 'relevance'); }
      if (provider === 'openalex') { url.searchParams.set('search', query); url.searchParams.set('per_page', String(rows)); url.searchParams.set('cursor', cursor); const filter = [years.from ? `from_publication_date:${years.from}-01-01` : '', years.to ? `to_publication_date:${years.to}-12-31` : ''].filter(Boolean); if (filter.length) url.searchParams.set('filter', filter.join(',')); }
      let payload;
      if (provider === 'arxiv') { const previous = arxivLock; let release; arxivLock = new Promise(resolve => { release = resolve; }); await previous; try { await signalPause(Math.max(0, arxivIntervalMs - (Date.now() - lastArxivRequest)), signal); lastArxivRequest = Date.now(); payload = await get(url, provider, signal); } finally { release(); } }
      else payload = await get(url, provider, signal);
      pages++; let pageItems, nextCursor, total;
      if (provider === 'arxiv') { const parsed = parseArxiv(payload, queriedAt); pageItems = parsed.items; lastCount = parsed.rawCount; total = parsed.total; }
      else { let parsed; try { parsed = JSON.parse(payload); } catch { throw coded('INVALID_RESPONSE', '学术来源没有返回有效 JSON。'); } const message = provider === 'crossref' ? parsed.message : parsed; const raw = provider === 'crossref' ? message?.items : message?.results; if (!Array.isArray(raw) || raw.length > 100) throw coded('INVALID_RESPONSE', '学术来源的结果结构无效。'); lastCount = raw.length; pageItems = raw.map(item => provider === 'crossref' ? crossrefItem(item, queriedAt) : openalexItem(item, queriedAt)).filter(Boolean); invalidRecords += raw.length - pageItems.length; nextCursor = provider === 'crossref' ? message['next-cursor'] : message.meta?.next_cursor; total = provider === 'crossref' ? message['total-results'] : message.meta?.count; }
      items.push(...pageItems.filter(item => (!years.from || item.year === null || item.year >= years.from) && (!years.to || item.year === null || item.year <= years.to)));
      hasMore = lastCount >= rows && (!Number.isSafeInteger(total) || (page + 1) * pageSize < total); if (!hasMore) break;
      if (provider !== 'arxiv') { if (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8192) break; if (cursors.has(nextCursor)) throw coded('INVALID_PAGINATION', '学术来源返回了重复分页游标。'); cursors.add(nextCursor); cursor = nextCursor; }
    }
    return { provider, items: items.slice(0, limit), report: { provider, status: 'ok', received: items.length, pages, invalidRecords, truncated: hasMore && (pages >= maxPages || items.length >= limit), queriedAt } };
  }
  return {
    providers: () => PROVIDERS.map(id => ({ id, metadataOnly: true, fullTextDownload: false, configured: id !== 'openalex' || !!openalexApiKey, accountRequired: false })),
    async search({ query, sources = ['crossref', 'arxiv'], limit = 20, yearFrom, yearTo, signal } = {}) {
      query = simpleText(query, 1001); if (!query || query.length > 1000 || /[\0]/.test(query)) throw coded('INVALID_INPUT', '请填写不超过 1000 字符的文献检索词。'); if (!Array.isArray(sources) || !sources.length || sources.length > 3 || sources.some(provider => !PROVIDERS.includes(provider)) || new Set(sources).size !== sources.length) throw coded('INVALID_INPUT', '请选择受支持的学术来源。');
      limit = integer(limit, 20, 1, 50, '结果数量'); const from = yearFrom === undefined ? null : integer(yearFrom, 0, 1500, 2200, '开始年份'), to = yearTo === undefined ? null : integer(yearTo, 0, 1500, 2200, '截止年份'); if (from && to && from > to) throw coded('INVALID_INPUT', '开始年份不能晚于截止年份。'); if (signal?.aborted) throw coded('CANCELLED', '文献检索已取消。'); const queriedAt = clock().toISOString();
      const responses = await Promise.all(sources.map(async provider => { try { return await retrieve(provider, query, limit, { from, to }, queriedAt, signal); } catch (error) { return { provider, items: [], report: { provider, status: error.code === 'CANCELLED' ? 'cancelled' : 'failed', error: { code: error.code ?? 'SOURCE_FAILED', message: ['RATE_LIMITED', 'AUTH_REQUIRED', 'TIMEOUT', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'INVALID_PAGINATION', 'UNSAFE_XML', 'SOURCE_REJECTED_QUERY', 'NETWORK_FAILED', 'CANCELLED'].includes(error.code) ? error.message : '学术来源检索失败。' }, queriedAt } }; } }));
      const items = mergeRecords(responses.flatMap(response => response.items)).slice(0, limit); return { query, queriedAt, years: { from, to }, items, sourceReports: responses.map(response => response.report), partial: responses.some(response => response.report.status !== 'ok'), cancelled: !!signal?.aborted, evidence: 'metadata-and-source-abstracts-only', fullTextRetrieved: false, diagnostics: [{ code: 'NO_FULLTEXT', message: '本次返回的是来源元数据及来源提供的摘要，没有下载或精读论文全文。' }, ...(items.some(item => item.metadataConflicts.length) ? [{ code: 'METADATA_CONFLICT', message: '不同来源对同一标识的题名或年份有差异，已保留冲突供核对。' }] : [])] };
    },
  };
}

function bibEscape(value) { return String(value).replace(/[\\{}%&#_$~^]/g, match => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' })[match] ?? `\\${match}`).replace(/[\r\n]+/g, ' '); }
export function recordsToBibtex(records) { if (!Array.isArray(records) || records.length > 100) throw coded('INVALID_INPUT', '引用记录数量无效。'); return records.map((record, index) => { if (!record || !simpleText(record.title) || !doiOf(record.doi) && !normalizeArxivId(record.arxivId) && !/^W\d+$/.test(record.openalexId ?? '')) throw coded('INVALID_REFERENCE', '引用缺少可解析的真实来源标识。'); const key = `assistant${index + 1}_${record.year ?? 'undated'}`, fields = { title: record.title, author: record.authors?.map(author => author.name).join(' and '), year: record.year, doi: doiOf(record.doi), url: urlOf(record.url), journal: record.venue, ...(record.arxivId ? { eprint: record.arxivId, archivePrefix: 'arXiv' } : {}) }; return `@${record.type === 'journal-article' || record.type === 'article' ? 'article' : 'misc'}{${key},\n${Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([name, value]) => `  ${name} = {${bibEscape(value)}}`).join(',\n')}\n}`; }).join('\n\n') + '\n'; }
export function writeLiteratureExports({ workspace, searchResult } = {}) {
  if (!path.isAbsolute(workspace ?? '') || !searchResult || !Array.isArray(searchResult.items)) throw coded('INVALID_INPUT', '请选择当前任务输出目录并提供实际检索结果。'); const root = path.resolve(workspace); fs.mkdirSync(root, { recursive: true }); if (fs.lstatSync(root).isSymbolicLink()) throw coded('INVALID_PATH', '文献输出目录不能是链接。'); const suffix = randomUUID().slice(0, 8), bib = recordsToBibtex(searchResult.items), json = JSON.stringify(searchResult, null, 2); if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw coded('OUTPUT_TOO_LARGE', '文献导出内容超过限制。');
  const artifacts = []; for (const [name, mime, content] of [[`文献检索-${suffix}.json`, 'application/json', json], [`参考文献-${suffix}.bib`, 'application/x-bibtex', bib]]) { const filename = path.join(root, name); fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 }); const bytes = fs.readFileSync(filename); artifacts.push({ path: filename, name, mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); } return { artifacts };
}
