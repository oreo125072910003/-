import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runHostedTask } from '../packages/runtime-harness/hosted.mjs';

// Explicit local diagnostic: only generated text images go to the existing DSH
// model. No WeChat send, personal image, external worker or tool grant is used.
const root = fileURLToPath(new URL('../', import.meta.url));
const install = JSON.parse(fs.readFileSync(path.join(root, 'config/desktop-install.local.json'), 'utf8'));
const locations = JSON.parse(fs.readFileSync(path.join(root, 'config/wechat-locations.json'), 'utf8'));
const legacy = JSON.parse(fs.readFileSync(path.join(locations.workspace, 'config/wechatagent.json'), 'utf8'));
const output = path.join(root, 'dist/image-quality-verification', String(Date.now()));
fs.mkdirSync(output, { recursive: true });
const script = String.raw`
import sys,io,json,base64,hashlib,pathlib
from PIL import Image,ImageDraw,ImageFont
sys.path.insert(0,sys.argv[1])
from wechat_image_normalize import normalize_image
out=pathlib.Path(sys.argv[2])
image=Image.new('RGB',(1080,6000),'white')
draw=ImageDraw.Draw(image)
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',24)
for y in range(40,5970,54):
    draw.text((28,y),'图像清晰度测试 / 普通明细行 / 数量 37 / 单价 128.50',font=font,fill=(70,70,70))
for label,value,y in [('顶部校验码','AX7-4821',180),('中部校验码','MD3-9164',3000),('底部校验码','ZK8-7532',5800)]:
    draw.rectangle((10,y-6,1050,y+46),fill='white',outline='black')
    draw.text((28,y),label+'：'+value,font=font,fill='black')
raw=io.BytesIO();image.save(raw,format='PNG')
new=normalize_image(raw.getvalue(), include_details=True)
old=image.copy();old.thumbnail((1280,1280));buffer=io.BytesIO();old.save(buffer,format='JPEG',quality=85,optimize=True)
data=buffer.getvalue()
old={'b64':base64.b64encode(data).decode(),'mime':'image/jpeg','width':old.width,'height':old.height,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
for name,item in [('before',old),('after',new)]:
    (out/(name+'.json')).write_text(json.dumps(item),encoding='utf-8')
    (out/(name+('.png' if item['mime']=='image/png' else '.jpg'))).write_bytes(base64.b64decode(item['b64']))
`;
const generated = spawnSync(legacy.runtime.python, ['-B', '-c', script, path.join(root, '代码/项目/scripts'), output], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
if (generated.status !== 0) throw Error(generated.error?.message || generated.stderr);
const expected = { top: 'AX7-4821', middle: 'MD3-9164', bottom: 'ZK8-7532' };
const report = { generatedOnly: true, wechatSend: false, personalImages: false, expected, samples: [] };
for (const name of ['before', 'after']) {
  const source = JSON.parse(fs.readFileSync(path.join(output, name + '.json'), 'utf8'));
  const image = { id: source.sha256, sha256: source.sha256, mime: source.mime, b64: source.b64, bytes: source.bytes, name: '合成长截图' + (source.mime === 'image/png' ? '.png' : '.jpg') };
  const images = [image, ...(source.details ?? []).map((detail, index) => ({ id: detail.sha256, sha256: detail.sha256, mime: detail.mime, b64: detail.b64, bytes: detail.bytes, name: `同图局部${index + 1}.png` }))];
  const workspace = path.join(install.dataHome, 'tasks', 'image-check-' + randomUUID());
  fs.mkdirSync(workspace, { recursive: true });
  console.log(JSON.stringify({ stage: name, width: source.width, height: source.height, bytes: source.bytes }));
  const started = Date.now();
  const result = await runHostedTask({
    prompt: '这是合成识图校验。第一张是总览，如有后续图片，它们是同一张图从上到下的重叠局部，小字以局部图为准。只读取图片中“顶部校验码”“中部校验码”“底部校验码”后面对应的字符串。只返回 JSON，字段 top、middle、bottom；确实看不清的字段用 null，不根据上下文补字。',
    workspace, images, settings: { hostedConfigFile: path.join(install.dataHome, 'harness-host/client.json'), hostedOwnerGrants: { skills: [], tools: [] }, timeoutMs: 150000 },
  });
  let observed;
  try { observed = JSON.parse(result.finalText.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { observed = {}; }
  const matches = Object.keys(expected).filter(key => observed[key] === expected[key]).length;
  const sample = { name, width: source.width, height: source.height, bytes: source.bytes, imageCount: images.length, elapsedMs: Date.now() - started, ok: result.ok, matches, reply: result.finalText, error: result.error, sessionId: result.sessionId };
  report.samples.push(sample);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(sample));
}
console.log(JSON.stringify({ report: path.join(output, 'report.json'), afterPassed: report.samples[1].matches === 3 }));
if (report.samples[1].matches !== 3) process.exitCode = 1;
