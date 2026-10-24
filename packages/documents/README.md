# 受控文档读取与生成

本包使用正式文件库实现小助手的文字资料入口和简单办公文档生成，不依赖宿主 Codex 的文档工具。文档来自可信服务明确提供的任务附件，不自动扫描用户电脑、邮箱或其他任务。

## 读取接口

```js
const result = await extractDocument({
  path: attachment.path, // 主服务通过真实文件选择器导入后的绝对路径
  allowedRoot: taskInputDirectory, // 主服务控制的当前任务资料目录
  maxChars: 18000,
  maxBytes: 16 * 1024 * 1024,
  maxPages: 40,
  timeoutMs: 15000,
  signal,
});
```

返回 `{text,source:{name,path,sha256,bytes,type},extractedChars,truncated,coverage,pageCount,pagesRead,diagnostics}`。`truncated` 和 `coverage` 应与文字一起传给后续任务；不能把有限预览描述为完整阅读。

- 文本：UTF-8 与带 BOM 的 UTF-16LE，支持 txt/md/csv/json/tex/bib/yaml/yml/log。不猜测 GBK 等未知编码，二进制文本拒绝。
- DOCX：先检查 ZIP 条目、路径、重复、宏/嵌入对象、XML 实体与展开大小，再用 mammoth 提取原始文字。不渲染样式或图片，不读取外部关系目标。外部引用有明确诊断。
- PDF：使用 PDF.js 文字层提取，带页号与实际读取页数；禁用 eval、字体加载、XFA 和 WASM。不会执行 PDF JavaScript 或点击链接；扫描页没有 OCR，不能假装已读取图片内容。
- 旧 DOC、扫描 OCR、表格图片语义和 Office 宏暂不支持。

原文件大小默认最多 16 MiB，硬上限 32 MiB。文字默认 18000 字符，硬上限 200000；PDF 默认 40 页，硬上限 200。DOCX 最多 512 条目、单展开条目 8 MiB、总展开 32 MiB。重解析在独立 worker thread 中执行，JS old-generation 上限 192 MiB，默认 15 秒后终止自有线程；这是资源边界，不是 OS 文件或网络沙箱。

## 生成接口

```js
const result = await writeOfficeDocument({
  workspace: taskOutputDirectory,
  title: '工作安排',
  blocks: [
    {type:'paragraph',text:'依据用户提供的事实形成材料。'},
    {type:'heading',level:1,text:'下一步安排'},
    {type:'bullet',text:'日期待用户确认。'},
  ],
  formats: ['docx','pdf'],
  fontPath: trustedLocalFontPath, // 可省略，由 Windows 本机字体探测
  signal,
});
```

返回 `{ok,title,artifacts:[{path,name,mime,sha256,bytes}],layout,diagnostics}`。Word 使用 docx，PDF 使用 pdf-lib。A4 页面、黑色标题和正文字体、自然段落与三级标题，适合简单报告、申请或写作草稿，不是现有合同固定模板引擎的替代品。暂不支持表格、图像、脚注、公式、演示稿、复杂模板与自动红线修订。

输出使用独立随机后缀与排他创建，原文件不会被覆盖。所有请求格式先在内存生成成功，再写出文件；随后重新读取核对类型、范围、大小和哈希。每份总文字最多 512 KiB、1000 段，PDF 最多 200 页，单个输出最多 32 MiB。

中文 PDF 需要本机 TTF/OTF 字体。Windows 默认探测 `simhei.ttf`、`Deng.ttf`、`simkai.ttf`，用字体子集生成 PDF，不将系统字体文件纳入应用分发。其他系统应由宿主显式提供合法可用字体；缺少字形会报错，不交付方块字。字体路径只能由可信服务提供，不由模型自行选择。

## 验证记录 2026-10-25

`tests/documents.test.mjs` 11 项离线测试通过，包括真实 Word/中文 PDF 生成并再次提取、哈希、来源、UTF-8/UTF-16、有界读取、路径限制、ZIP 越界/宏/压缩炸弹/XML实体、外部关系忽略、扫描 PDF、签名、取消和病理文档时限。

QA 使用 documents 和 pdf 技能要求的 bundled Node/Python 与 Poppler。`dist/document-qa` 保存合成样例、哈希记录和 PNG，不入 Git，也不是实际业务文书。最新中文 PDF 一页经 Poppler 渲染后已检查：中文可读、标题和段落层次清楚、无方块字、溢出或重叠。

已实际调用技能的 `render_docx.py`，但当前 bundled runtime 不含 LibreOffice，报 `LibreOffice soffice.exe was not found on PATH`。没有改用用户桌面安装的 LibreOffice。因此 DOCX 只有结构、正文和哈希验证，尚未完成独立视觉渲染验收。运行时返回 `docxVisualVerified:false` 和 `pdfVisualVerified:false`；一次合成 QA 不能代表每次任意材料已自动通过版面检查。

T20 的浏览器/通用文件修改与 OS 沙箱尚未完成；T24 的完整模板、视觉预览与正式材料验收尚未完成。此模块可供服务真实使用，但不能把这两项整体标为完成。

## 依赖与来源

固定依赖：docx 9.14.0、pdf-lib 1.17.1、@pdf-lib/fontkit 1.1.1、mammoth 1.13.0、pdfjs-dist 6.4.299、fflate 0.8.3。正式应用将这些依赖随产品安装；宿主的依赖不会自动赋予独立产品能力。

- [Mammoth 官方说明与外部文件安全](https://github.com/mwilliamson/mammoth.js)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/)
- [pdf-lib 字体与文档生成](https://github.com/Hopding/pdf-lib)
- [docx API](https://docx.js.org/)
- [fflate ZIP filter](https://github.com/101arrowz/fflate)
