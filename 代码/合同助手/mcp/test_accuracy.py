"""用合成图片验证新增转录限制，不向API发送真实合同或联系人。"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from test_mcp import Client

exe, out = Path(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 26)
def picture(name, lines):
    im = Image.new('RGB', (1400, 340), 'white'); draw = ImageDraw.Draw(im)
    for i, line in enumerate(lines): draw.text((20, 20+i*65), line, font=font, fill='black')
    path = out/name; im.save(path); return str(path)

paths = [
    picture('line-amount.png', ['产品名称       型号           数量   单位   金额(人民币元)', '测试部件       TEST-AMOUNT     2      件       25.00', '此表没有单价列，金额是该行总金额。']),
    picture('usd-price.png', ['产品名称       型号           数量   单位   单价(USD)', '测试部件       TEST-USD        2      件       12.50']),
    picture('pretax-price.png', ['产品名称       型号           数量   单位   不含税单价(人民币元)', '测试部件       TEST-PRETAX     2      件       12.50']),
    picture('supplier-one.png', ['乙方（供方）：示例甲公司', '乙方电话：021-00000001', '乙方地址：示例甲地址']),
    picture('supplier-two.png', ['乙方（供方）：示例乙公司', '乙方电话：021-00000002', '乙方地址：示例乙地址']),
]
c = Client(exe, out)
try:
    init = c.send('initialize', {'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'accuracy-check','version':'1'}})['result']
    assert '合同助手 AI 工作提示词' in init['instructions'] and '零错误' in init['instructions']
    c.send('notifications/initialized', notification=True)
    schemas = c.send('tools/list')['result']['tools']
    gen_schema = next(t['inputSchema'] for t in schemas if t['name']=='generate_contract')
    assert gen_schema['properties']['contract']['properties']['cover']['const'] is False
    guide = c.send('resources/read', {'uri':'contract-helper://guide'})['result']['contents'][0]['text']
    assert '结构示意' in guide and 'ready=true不等于事实已核验' in guide
    result = c.tool('recognize_contract_images', {'image_paths':paths})['result']
    assert len(result['goods']) == 3, result
    assert all(g['price']=='' for g in result['goods']), result
    assert all(g['qty']=='2' for g in result['goods']), result
    assert set(result['conflicts']) >= {'乙方名称','乙方电话','乙方地址'}, result
    assert not any(result['fields'].get(k) for k in ('乙方名称','乙方电话','乙方地址')), result
    data = {'fields':{'乙方名称':'本地测试公司','乙方电话':'000000','乙方地址':'本地测试地址','合同编号':'不应写入','签订日期':'不应写入'}, 'goods':[{'name':'本地部件','model':'LOCAL-001','qty':'2','unit':'件','price':'1.00','spec':''}], 'cover':True}
    preview = c.tool('preview_contract', {'contract':data,'use_common_info':False})
    assert preview['ready'] and preview['contract']['cover'] is False
    assert all(k not in preview['contract']['fields'] for k in ('合同编号','签订日期'))
    assert len(preview['warnings']) == 3, preview
    # 预览返回的合同对象可原样用于下一次工具输入，无未声明cover字段。
    generated = c.tool('generate_contract', {'contract':preview['contract'],'use_common_info':False})
    assert Path(generated['docx_path']).is_file()
    report = {'passed':True,'liveAiTested':True,'checks':['initialize使用同一工作提示词，完整说明可读','五图跨请求分组：仅金额、外币、未税价均不填写成含税人民币单价','乙方公司/电话/地址跨图冲突全部留空','实际数量原文依据保留','编号/签章日期/封面丢弃并提示','预览数据可直接复用生成且不更改固定内容'], 'ocr':result}
    (out/'accuracy-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='ocr'},ensure_ascii=True))
finally:
    c.close()
