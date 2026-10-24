"""把界面、逻辑、ZIP 库和原始模板合成一个可双击运行的 HTML 文件。"""
from pathlib import Path
import base64
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / 'assets/原始合同模板.docx'
ZIP_LIBRARY = ROOT / 'assets/jszip.min.js'

def build():
    output = ROOT / '成品'
    output.mkdir(exist_ok=True)
    html = (ROOT / 'src/index.html').read_text(encoding='utf-8')
    js = (ROOT / 'src/app.js').read_text(encoding='utf-8')
    sample = json.loads((ROOT / 'src/sample.json').read_text(encoding='utf-8'))
    js = js.replace('__SAMPLE_JSON__', json.dumps(sample, ensure_ascii=False).replace('</', '<\\/'))
    js = js.replace('__TEMPLATE_BASE64__', base64.b64encode(TEMPLATE.read_bytes()).decode('ascii'))
    html = html.replace('<!-- BUNDLE -->', '<script>\n'+ZIP_LIBRARY.read_text(encoding='utf-8')+'\n</script>\n<script>\n'+js+'\n</script>')
    app = output / '合同填写小助手.html'
    app.write_text(html, encoding='utf-8')
    shutil.copyfile(ROOT / '使用说明.txt', output / '使用说明.txt')
    print(str(app))
    print('SHA256:', hashlib.sha256(app.read_bytes()).hexdigest())

if __name__ == '__main__':
    build()
