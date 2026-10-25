import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function within(root, filename) { const relative = path.relative(root, filename); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function text(value, label, maximum = 100000) { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) throw coded('INVALID_INPUT', `${label}无效。`); return value.trim(); }
function boundedInteger(value, fallback, min, max, label) { const selected = value ?? fallback; if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw coded('INVALID_LIMIT', `${label}超出允许范围。`); return selected; }
function abortCheck(signal) { if (signal?.aborted) throw coded('CANCELLED', '文档处理已取消。'); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function allowedFile(filename, root, maxBytes) {
  if (!path.isAbsolute(filename ?? '') || !path.isAbsolute(root ?? '')) throw coded('INVALID_PATH', '只能读取服务明确授权的任务附件完整路径。');
  const absolute = path.resolve(filename), allowed = path.resolve(root); const rootStat = fs.lstatSync(allowed), stat = fs.lstatSync(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || !within(allowed, absolute) || !within(fs.realpathSync(allowed), fs.realpathSync(absolute))) throw coded('OUTSIDE_ALLOWED_ROOT', '附件不在当前任务授权目录内，或属于目录链接。');
  if (stat.size > maxBytes) throw coded('FILE_TOO_LARGE', '附件超过本次解析的大小限制。');
  const descriptor = fs.openSync(absolute, 'r'); try { const current = fs.fstatSync(descriptor); if (!current.isFile() || current.size !== stat.size || current.size > maxBytes || !within(fs.realpathSync(allowed), fs.realpathSync(absolute))) throw coded('FILE_CHANGED', '附件在读取前发生变化。'); const buffer = Buffer.alloc(current.size); let offset = 0; while (offset < buffer.length) { const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (!count) throw coded('FILE_CHANGED', '附件在读取期间被截断。'); offset += count; } if (fs.fstatSync(descriptor).size !== current.size) throw coded('FILE_CHANGED', '附件在读取期间发生变化。'); return { absolute, bytes: buffer }; } finally { fs.closeSync(descriptor); }
}
async function isolatedExtract(bytes, kind, { maxChars, maxPages, timeoutMs, signal }) {
  abortCheck(signal); const worker = new Worker(new URL('./parse-worker.mjs', import.meta.url), { execArgv: [], workerData: { bytes: new Uint8Array(bytes), kind, maxChars, maxPages }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = async (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancelled); await worker.terminate(); if (error) reject(error); else resolve(value); };
    const cancelled = () => { void finish(coded('CANCELLED', '文档处理已取消。')); }, timer = setTimeout(() => { void finish(coded('EXTRACTION_TIMEOUT', '文档解析超时，已停止本次解析器。')); }, timeoutMs);
    signal?.addEventListener('abort', cancelled, { once: true }); worker.once('error', () => { void finish(coded('PARSER_FAILED', '隔离文档解析器异常退出，可能超过内存限制。')); }); worker.once('exit', code => { if (!done) void finish(coded('PARSER_FAILED', '文档解析器没有返回有效结果。')); }); worker.once('message', value => { if (value?.ok === true) void finish(null, value.result); else void finish(coded(value?.error?.code ?? 'EXTRACTION_FAILED', value?.error?.message ?? '文档提取失败。')); });
  });
}
/** The trusted host supplies both the selected attachment path and its task input root. */
export async function extractDocument({ path: filename, allowedRoot, maxChars, maxBytes, maxPages, timeoutMs, signal } = {}) {
  abortCheck(signal); const limits = { maxChars: boundedInteger(maxChars, 18000, 1, 200000, '文字数'), maxPages: boundedInteger(maxPages, 40, 1, 200, '页数'), maxBytes: boundedInteger(maxBytes, 16 * 1024 * 1024, 1, 32 * 1024 * 1024, '文件大小'), timeoutMs: boundedInteger(timeoutMs, 15000, 100, 60000, '解析时限') };
  const { absolute, bytes } = allowedFile(filename, allowedRoot, limits.maxBytes), extension = path.extname(absolute).toLowerCase(); let result;
  if (['.txt', '.md', '.csv', '.json', '.tex', '.bib', '.yaml', '.yml', '.log'].includes(extension)) {
    let content; try { content = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2)) : new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw coded('UNSUPPORTED_ENCODING', '文本编码不是 UTF-8 或带 BOM 的 UTF-16LE，当前没有猜测转换编码。'); }
    if (content.includes('\0')) throw coded('BINARY_CONTENT', '此附件包含二进制内容，不能作为文本读取。'); content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); result = { text: content.slice(0, limits.maxChars), truncated: content.length > limits.maxChars, diagnostics: [], pageCount: null, pagesRead: null, coverage: 'plain-text' };
  } else if (extension === '.docx') { if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw coded('INVALID_DOCX', 'DOCX 文件签名无效。'); result = await isolatedExtract(bytes, 'docx', { ...limits, signal }); }
  else if(extension==='.xlsx'){if(bytes[0]!==0x50||bytes[1]!==0x4b)throw coded('INVALID_XLSX','XLSX 文件签名无效。');result=await isolatedExtract(bytes,'xlsx',{...limits,signal});}
  else if (extension === '.pdf') { if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw coded('INVALID_PDF', 'PDF 文件签名无效。'); result = await isolatedExtract(bytes, 'pdf', { ...limits, signal }); }
  else throw coded('UNSUPPORTED_TYPE', '当前支持文本、DOCX、XLSX 和带文字层的 PDF；旧 DOC/XLS 需另存为 DOCX/XLSX，扫描件 OCR 尚未接通。');
  abortCheck(signal); return { ...result, source: { name: path.basename(absolute), path: absolute, sha256: digest(bytes), bytes: bytes.length, type: extension.slice(1) }, extractedChars: result.text.length };
}

function normalizedBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 1000) throw coded('INVALID_INPUT', '请提供 1 至 1000 个文档段落。'); let total = 0;
  return blocks.map(block => { if (!block || typeof block !== 'object' || !['heading', 'paragraph', 'bullet'].includes(block.type)) throw coded('INVALID_INPUT', '文档段落类型无效。'); const content = text(block.text, '段落文字', 20000); total += Buffer.byteLength(content); if (total > 512 * 1024) throw coded('CONTENT_TOO_LARGE', '文档总文字量超过限制。'); return { type: block.type, text: content, ...(block.type === 'heading' ? { level: boundedInteger(block.level, 1, 1, 3, '标题级别') } : {}) }; });
}
function docxBytes(title, blocks) {
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 360 }, keepNext: true })];
  for (const block of blocks) children.push(new Paragraph({ children: [new TextRun({ text: block.text, break: 0 })], ...(block.type === 'heading' ? { heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][block.level - 1], keepNext: true, spacing: { before: 240, after: 120 } } : { spacing: { after: 140, line: 360 }, ...(block.type === 'bullet' ? { bullet: { level: 0 } } : {}) }) }));
  const document = new Document({ creator: '小助手', title, description: '由用户提供的资料生成的可编辑文档', styles: { default: { document: { run: { font: { name: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' }, size: 24, color: '000000' }, paragraph: { spacing: { line: 360 } } }, title: { run: { font: 'Microsoft YaHei', size: 36, bold: true, color: '000000' } }, heading1: { run: { font: 'Microsoft YaHei', size: 30, bold: true, color: '000000' } }, heading2: { run: { font: 'Microsoft YaHei', size: 27, bold: true, color: '000000' } }, heading3: { run: { font: 'Microsoft YaHei', size: 24, bold: true, color: '000000' } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, right: 1300, bottom: 1300, left: 1300 } } }, children }] });
  return Packer.toBuffer(document);
}
export function detectLocalChineseFont() { if (process.platform !== 'win32') return null; for (const name of ['simhei.ttf', 'Deng.ttf', 'simkai.ttf']) { const filename = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts', name); if (fs.existsSync(filename)) return filename; } return null; }
function wrapText(content, font, size, width) { const lines = []; for (const paragraph of content.split('\n')) { let line = ''; for (const character of paragraph) { if (font.widthOfTextAtSize(line + character, size) > width && line) { lines.push(line); line = character; } else line += character; } lines.push(line); } return lines; }
async function pdfBytes(title, blocks, fontPath, signal) {
  const document = await PDFDocument.create(); document.setTitle(title); document.setAuthor('小助手'); document.setCreator('小助手'); let font, actualFont = null; const allText = title + blocks.map(block => block.text).join('');
  if (fontPath) { if (!path.isAbsolute(fontPath)) throw coded('INVALID_FONT', '字体必须来自宿主选择的完整本机路径。'); const stat = fs.lstatSync(fontPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || !/\.(?:ttf|otf)$/i.test(fontPath)) throw coded('INVALID_FONT', '请选择不超过 32 MiB 的 TTF/OTF 字体文件。'); document.registerFontkit(fontkit); font = await document.embedFont(fs.readFileSync(fontPath), { subset: true }); actualFont = path.basename(fontPath); }
  else { if (/[^\x20-\x7e\r\n\t]/.test(allText)) throw coded('CHINESE_FONT_REQUIRED', '中文 PDF 需要本机可用的中文字体；未将系统字体打包到应用。'); font = await document.embedFont(StandardFonts.Helvetica); }
  const glyphs = new Set(font.getCharacterSet()); if ([...allText].some(character => !/[\r\n\t]/.test(character) && !glyphs.has(character.codePointAt(0)))) throw coded('MISSING_GLYPH', '当前字体缺少文档中的部分字符，未生成包含方块字的 PDF。');
  const width = 595.28, height = 841.89, margin = 56.7, available = width - margin * 2; let page, y, pageCount = 0;
  const nextPage = () => { if (++pageCount > 200) throw coded('PAGE_LIMIT', 'PDF 超过 200 页限制。'); page = document.addPage([width, height]); y = height - margin; }; nextPage();
  const draw = (content, size, lineHeight, gap, keepLines = 0) => { const lines = wrapText(content.replace(/\t/g, '    '), font, size, available); if (keepLines && y - lineHeight * Math.min(lines.length + keepLines, 5) < margin) nextPage(); for (const line of lines) { abortCheck(signal); if (y - lineHeight < margin) nextPage(); page.drawText(line, { x: margin, y: y - size, size, font, color: rgb(0, 0, 0) }); y -= lineHeight; } y -= gap; };
  draw(title, 20, 29, 18, 2); for (const block of blocks) draw((block.type === 'bullet' ? '- ' : '') + block.text, block.type === 'heading' ? 16 - block.level : 12, block.type === 'heading' ? 24 : 20, block.type === 'heading' ? 8 : 10, block.type === 'heading' ? 2 : 0);
  return { bytes: Buffer.from(await document.save()), pages: pageCount, font: actualFont ?? 'Helvetica' };
}
/** Simple prose documents. Does not represent itself as a contract template engine. */
export async function writeOfficeDocument({ workspace, title, blocks, formats = ['docx', 'pdf'], fontPath, signal } = {}) {
  abortCheck(signal); if (!path.isAbsolute(workspace ?? '')) throw coded('INVALID_WORKSPACE', '文档输出目录必须是当前任务的完整路径。'); const root = path.resolve(workspace); fs.mkdirSync(root, { recursive: true }); if (fs.lstatSync(root).isSymbolicLink()) throw coded('INVALID_WORKSPACE', '文档输出目录不能是链接。'); const physicalRoot = fs.realpathSync(root);
  const heading = text(title, '文档标题', 160), content = normalizedBlocks(blocks); if (!Array.isArray(formats) || !formats.length || formats.length > 2 || formats.some(format => !['docx', 'pdf'].includes(format)) || new Set(formats).size !== formats.length) throw coded('INVALID_INPUT', '输出格式只支持 docx 和 pdf。');
  const buffers = [], layout = { pageSize: 'A4', pdfPages: null, pdfFont: null, docxVisualVerified: false, pdfVisualVerified: false };
  if (formats.includes('docx')) { abortCheck(signal); buffers.push({ extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: await docxBytes(heading, content) }); }
  if (formats.includes('pdf')) { abortCheck(signal); const result = await pdfBytes(heading, content, fontPath ?? detectLocalChineseFont(), signal); layout.pdfPages = result.pages; layout.pdfFont = result.font; buffers.push({ extension: 'pdf', mime: 'application/pdf', bytes: result.bytes }); }
  const base = heading.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').slice(0, 64) || '文档', suffix = randomUUID().slice(0, 8), artifacts = [];
  try { for (const item of buffers) { abortCheck(signal); if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== physicalRoot) throw coded('INVALID_WORKSPACE', '输出目录在生成期间发生变化。'); if (item.bytes.length > 32 * 1024 * 1024) throw coded('OUTPUT_TOO_LARGE', '生成的文档超过大小限制。'); const filename = path.join(root, `${base}-${suffix}.${item.extension}`); fs.writeFileSync(filename, item.bytes, { flag: 'wx', mode: 0o600 }); if (!within(physicalRoot, fs.realpathSync(filename)) || !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw coded('INVALID_ARTIFACT', '生成文件路径校验失败。'); const actual = fs.readFileSync(filename); if (digest(actual) !== digest(item.bytes)) throw coded('INVALID_ARTIFACT', '生成文件哈希校验失败。'); artifacts.push({ path: filename, name: path.basename(filename), mime: item.mime, sha256: digest(actual), bytes: actual.length }); } }
  catch (error) { for (const artifact of artifacts) if (within(root, artifact.path) && fs.existsSync(artifact.path) && !fs.lstatSync(artifact.path).isSymbolicLink()) fs.unlinkSync(artifact.path); throw error; }
  return { ok: true, title: heading, artifacts, layout, diagnostics: [{ code: 'LAYOUT_REVIEW_REQUIRED', message: '文件已生成并通过结构与哈希检查；此运行未自动进行 Word/PDF 视觉版面验收。' }] };
}
