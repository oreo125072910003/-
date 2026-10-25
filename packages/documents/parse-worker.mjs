import { parentPort, workerData } from 'node:worker_threads';
import { unzipSync } from 'fflate';
import mammoth from 'mammoth';
import {DOMParser} from '@xmldom/xmldom';
import path from 'node:path';

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function preflightDocx(bytes, excel=false) {
  let total = 0, count = 0; const seen = new Set(), diagnostics = [];
  const xml = unzipSync(bytes, { filter(entry) {
    count++; total += entry.originalSize;
    if (count > 512 || total > 32 * 1024 * 1024 || entry.originalSize > 8 * 1024 * 1024 || !Number.isSafeInteger(entry.originalSize)) throw coded('ARCHIVE_LIMIT', 'Word 压缩包展开大小或文件数量超过限制。');
    if (seen.has(entry.name) || entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name) || entry.name.includes('\\') || entry.name.split('/').some(part => part === '..')) throw coded('UNSAFE_ARCHIVE', 'Word 压缩包包含重复或越界文件名。'); seen.add(entry.name);
    if (/vbaProject|\.exe$|\.dll$|activeX|embeddings\//i.test(entry.name)) throw coded('ACTIVE_CONTENT', '此 Word 包含宏、嵌入对象或活动内容，当前不予解析。');
    return entry.name.endsWith('.rels') || entry.name.endsWith('.xml');
  } });
  if (!seen.has('[Content_Types].xml') || !seen.has(excel?'xl/workbook.xml':'word/document.xml')) throw coded(excel?'INVALID_XLSX':'INVALID_DOCX', '文件不是有效的标准 Office 文档。');
  for (const [name, data] of Object.entries(xml)) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw coded('UNSAFE_XML', 'Word XML 包含不支持的实体声明。');
    if (name.endsWith('.rels') && /TargetMode\s*=\s*["']External["']/i.test(source)) diagnostics.push({ code: 'EXTERNAL_RELATIONSHIP_IGNORED', message: '文档包含外部引用；提取过程不会读取网络或外部文件。' });
  }
  return excel?{diagnostics,xml}:diagnostics;
}
function sheetXml(bytes){
  const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let malformed=false;
  const doc=new DOMParser({onError:()=>{malformed=true;}}).parseFromString(source,'text/xml');
  if(malformed)throw coded('INVALID_XLSX','Excel XML 无法解析。');return doc;
}
const nodes=(node,name)=>Array.from(node.getElementsByTagName('*')).filter(item=>item.localName===name);
async function extractXlsx(bytes,maxChars){
  const {diagnostics,xml}=preflightDocx(bytes,true),strings=[];
  if(xml['xl/sharedStrings.xml'])for(const entry of nodes(sheetXml(xml['xl/sharedStrings.xml']),'si')){
    if(strings.length>=25000)throw coded('ARCHIVE_LIMIT','Excel 共享文本超过解析上限。');
    strings.push(nodes(entry,'t').map(item=>item.textContent).join(''));
  }
  if(!xml['xl/_rels/workbook.xml.rels'])throw coded('INVALID_XLSX','Excel 工作表映射缺失。');
  const relationships=new Map(nodes(sheetXml(xml['xl/_rels/workbook.xml.rels']),'Relationship').filter(item=>item.getAttribute('TargetMode')!=='External').map(item=>{
    const target=item.getAttribute('Target')??'',name=target.startsWith('/')?path.posix.normalize(target.slice(1)):path.posix.normalize('xl/'+target);
    return[item.getAttribute('Id'),/^xl\/worksheets\/[^/]+\.xml$/.test(name)?name:''];
  }));
  const sheets=nodes(sheetXml(xml['xl/workbook.xml']),'sheet').map(item=>({name:relationships.get(item.getAttribute('r:id')),title:item.getAttribute('name')||'工作表'}));
  if(sheets.some(sheet=>!sheet.name||!xml[sheet.name]))throw coded('INVALID_XLSX','Excel 工作表映射无效。');
  if(!sheets.length)throw coded('INVALID_XLSX','Excel 没有可读取的工作表。');
  let content='',count=0,truncated=sheets.length>20,formula=false;
  for(const {name,title}of sheets.slice(0,20)){
    const lines=[`[工作表：${title}]`];
    for(const cell of nodes(sheetXml(xml[name]),'c')){
      if(++count>10000){truncated=true;break;}
      const type=cell.getAttribute('t'),ref=cell.getAttribute('r')||'?';
      let value=nodes(cell,'v')[0]?.textContent??'';
      if(type==='s'){const id=Number(value);if(!Number.isInteger(id)||id<0||id>=strings.length)throw coded('INVALID_XLSX','Excel 共享文本索引无效。');value=strings[id];}
      else if(type==='inlineStr')value=nodes(cell,'t').map(item=>item.textContent).join('');
      else if(type==='b')value=value==='1'?'TRUE':value==='0'?'FALSE':value;
      const expression=nodes(cell,'f')[0]?.textContent;
      if(expression!==undefined){formula=true;value=`${value||'[无缓存结果]'}（公式：${expression}；未重新计算）`;}
      if(value)lines.push(`${ref}: ${value}`);
      if(lines.join('\n').length+content.length>maxChars){truncated=true;break;}
    }
    const part=(content?'\n\n':'')+lines.join('\n');content+=part.slice(0,maxChars-content.length);
    if(content.length>=maxChars||count>10000){truncated=true;break;}
  }
  if(formula)diagnostics.push({code:'FORMULA_CACHED_VALUES_ONLY',message:'公式未执行或重新计算；仅提供文件内保存的结果与公式文字。'});
  return{text:content,truncated,diagnostics,pageCount:null,pagesRead:null,coverage:'xlsx-cell-values-no-macros-or-recalculation'};
}
async function extractDocx(bytes, maxChars) {
  const diagnostics = preflightDocx(bytes), result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const content = result.value.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  if (result.messages.length) diagnostics.push({ code: 'DOCX_PARSER_WARNINGS', message: `Word 解析器产生 ${result.messages.length} 条诊断；仅提取可读取的正文。` });
  return { text: content.slice(0, maxChars), truncated: content.length > maxChars, diagnostics, pageCount: null, pagesRead: null, coverage: 'docx-text-only-no-layout-or-images' };
}
async function extractPdf(bytes, maxChars, maxPages) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, enableXfa: false, useWasm: false, maxImageSize: 0, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true, verbosity: 0 });
  let document;
  try {
    document = await task.promise; const pages = [], total = Math.min(document.numPages, maxPages); let content = '', truncated = document.numPages > maxPages, pagesRead = 0, empty = 0;
    for (let number = 1; number <= total; number++) {
      const page = await document.getPage(number), data = await page.getTextContent({ disableNormalization: false, includeMarkedContent: false }); const pieces = [];
      for (const item of data.items) if (typeof item.str === 'string') pieces.push(item.str + (item.hasEOL ? '\n' : ' '));
      const text = pieces.join('').replace(/\u0000/g, '').trim(); if (!text) empty++; pagesRead++; const remaining = maxChars - content.length;
      if (remaining <= 0) { truncated = true; page.cleanup(); break; }
      const prefix = `${content ? '\n\n' : ''}[第 ${number} 页]\n`, chunk = text ? prefix + text : ''; content += chunk.slice(0, remaining); pages.push({ number, extractedChars: Math.min(chunk.length, remaining) }); page.cleanup();
      if (chunk.length > remaining || content.length >= maxChars && number < document.numPages) { truncated = true; break; }
    }
    const diagnostics = []; if (empty) diagnostics.push({ code: 'NO_TEXT_LAYER', message: `${empty} 页未提取到文字；扫描页和图片尚未接通 OCR。` });
    return { text: content, truncated, diagnostics, pageCount: document.numPages, pagesRead, pages, coverage: 'pdf-text-layer-only-no-ocr-or-layout' };
  } finally { await task.destroy(); }
}
try {
  const { bytes, kind, maxChars, maxPages } = workerData;
  const result = kind === 'docx' ? await extractDocx(bytes, maxChars) : kind==='xlsx'?await extractXlsx(bytes,maxChars):await extractPdf(bytes, maxChars, maxPages);
  parentPort.postMessage({ ok: true, result });
} catch (error) { parentPort.postMessage({ ok: false, error: { code: typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : error.name === 'PasswordException' ? 'PASSWORD_REQUIRED' : 'EXTRACTION_FAILED', message: ['ARCHIVE_LIMIT', 'UNSAFE_ARCHIVE', 'ACTIVE_CONTENT', 'INVALID_DOCX', 'UNSAFE_XML'].includes(error.code) ? error.message : '文档无法安全提取文字，可能损坏、加密或使用了尚未支持的格式。' } }); }
