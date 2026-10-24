"""测试MCP协议和合同流程。只有--live-ai才用合成资料调用已配置的API。"""
from pathlib import Path
import argparse, copy, json, queue, re, subprocess, threading, zipfile
from PIL import Image, ImageDraw, ImageFont

class Client:
    def __init__(self, executable, output):
        self.process = subprocess.Popen([str(executable), '--output-dir', str(output), '--data-dir', str(output/'isolated-data')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', bufsize=1, creationflags=subprocess.CREATE_NO_WINDOW)
        self.messages = queue.Queue()
        self.counter = 0
        self.raw = []
        def read():
            for line in self.process.stdout:
                self.raw.append(line)
                try: self.messages.put(json.loads(line))
                except Exception: self.messages.put({'bad_stdout': True})
        threading.Thread(target=read, daemon=True).start()

    def send(self, method, parameters=None, notification=False):
        self.counter += 1
        request = {'jsonrpc': '2.0', 'method': method}
        if not notification: request['id'] = self.counter
        if parameters is not None: request['params'] = parameters
        self.process.stdin.write(json.dumps(request, ensure_ascii=False)+'\n')
        self.process.stdin.flush()
        if notification: return None
        response = self.messages.get(timeout=160)
        assert response.get('id') == self.counter, response
        return response

    def tool(self, name, arguments=None, error=False):
        response = self.send('tools/call', {'name': name, 'arguments': arguments or {}})
        assert 'result' in response, response
        result = response['result']
        assert result.get('isError', False) == error, result
        parsed = json.loads(result['content'][0]['text'])
        assert result.get('structuredContent', parsed) == parsed
        return parsed

    def close(self):
        self.process.stdin.close()
        assert self.process.wait(timeout=8) == 0
        assert not self.process.stderr.read().strip()
        assert not re.search(r'sk-[A-Za-z0-9]{32,}', ''.join(self.raw))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--live-ai', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    c = Client(args.executable, args.output)
    checks = []
    try:
        assert c.send('tools/list')['error']['code'] == -32000
        assert c.send('server/discover')['error']['code'] == -32601
        init = c.send('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'contract-qa', 'version': '1'}})
        assert init['result']['protocolVersion'] == '2025-11-25'
        c.send('notifications/initialized', notification=True)
        assert c.send('ping')['result'] == {}
        listed = c.send('tools/list')['result']['tools']
        assert len(listed) == 17 and len({t['name'] for t in listed}) == 17
        assert c.send('unknown/method')['error']['code'] == -32601
        assert c.send('tools/call', {'name': 'unknown', 'arguments': {}})['error']['code'] == -32602
        checks.append('MCP握手、工具发现、通知、ping和标准错误响应')
        resources = c.send('resources/list')['result']['resources']
        assert len(resources) == 2
        assert c.send('resources/read', {'uri': resources[0]['uri']})['result']['contents'][0]['text']
        info = c.tool('get_contract_schema')
        assert info['locked_fields']['甲方名称'] == '上海交通大学'
        assert info['locked_fields']['交货天数'] == '30'
        common = c.tool('get_common_info')
        assert 'fields' in common and not any('key' in key.lower() for key in common['fields'])
        status = c.tool('get_api_status')
        assert set(status) == {'url','model','vision_model','key_configured'}
        checks.append('模板字段、固定规则、MCP资源和不暴露密钥的设置状态')
        data = {'version': 1, 'fields': {'甲方代表':'测试经办人','甲方电话':'021-00000000','乙方名称':'测试供应商','乙方电话':'021-00000001','乙方地址':'测试地址','采购用途':'实验室通用部件采购','交货天数':'999','甲方名称':'不得覆盖模板的名称','apiKey':'do-not-return-this'}, 'goods': [
            {'name':'测试支架','model':'TEST-A001','qty':'2','unit':'件','price':'12.50','spec':''},
            {'name':'测试接头','model':'TEST-B002','qty':'3','unit':'件','price':'20.00','spec':''}
        ]}
        parameters = {'contract':data,'use_common_info':False}
        preview = c.tool('preview_contract', parameters)
        assert preview['ready'] and preview['total'] == '85.00'
        assert preview['contract']['fields']['甲方名称'] == '上海交通大学'
        assert preview['contract']['fields']['交货天数'] == '30'
        assert 'apiKey' not in preview['contract']['fields']
        assert [p['amount'] for p in preview['payment_amounts']] == ['85.00']
        assert len(preview['warnings']) == 2
        checks.append('货物金额、人民币大写和验收后一次付清，固定字段防覆盖')
        missing = copy.deepcopy(parameters)
        missing['contract']['fields'] = {}
        result = c.tool('preview_contract', missing)
        assert not result['ready'] and any('乙方名称' in item for item in result['errors'])
        c.tool('generate_contract', missing, error=True)
        invalid = copy.deepcopy(parameters)
        invalid['contract']['goods'][0]['qty'] = '-1'
        c.tool('generate_contract', invalid, error=True)
        c.tool('generate_contract', dict(parameters, output_name='../../outside'), error=True)
        c.tool('generate_contract', dict(parameters, output_name='CON'), error=True)
        checks.append('缺失乙方资料、非法金额、路径越界和设备名拦截')
        generated = c.tool('generate_contract', parameters)
        docx, progress = Path(generated['docx_path']), Path(generated['progress_path'])
        assert re.match(r'\d{8}_测试供应商_85\.00元\.docx', docx.name)
        assert docx.parent == args.output and docx.exists() and progress.exists()
        with zipfile.ZipFile(docx) as archive:
            xml = archive.read('word/document.xml').decode('utf-8')
        assert 'TEST-A001' in xml and '85.00' in xml and '999个日历天' not in xml and '不得覆盖模板的名称' not in xml
        saved = json.loads(progress.read_text(encoding='utf-8-sig'))
        assert saved['version'] == 1 and 'apiKey' not in saved['fields'] and 'do-not-return-this' not in progress.read_text(encoding='utf-8-sig')
        loaded = c.tool('read_contract_progress', {'progress_path':str(progress)})
        assert loaded['contract']['goods'][0]['model'] == 'TEST-A001'
        second = c.tool('generate_contract', parameters)
        assert second['docx_path'] != str(docx) and docx.exists()
        template = Path(c.tool('export_contract_template')['template_path'])
        assert template.exists()
        custom = c.tool('preview_contract', dict(parameters, template_path=str(template)))
        assert custom['contract']['fields']['甲方名称'] == '上海交通大学'
        entry = c.tool('library_search', {'query':'TEST-A001'})['entries']
        assert entry and c.tool('library_read', {'id':entry[0]['id']})['entry']['progress']
        imported = c.tool('library_import', {'path':str(docx)})
        assert imported['entry']['id'] == entry[0]['id']
        c.tool('lookup_model_specs', {'model':'TEST-UNKNOWN-000'}, error=True)
        for model in ['PBS632','PMC780-APC-2','BS1355-B']:
            record = c.tool('lookup_model_specs', {'model':model})['record']
            assert record['facts'] and record['source'].startswith('https://www.lbtek.com/')
            assert '单价' not in record['facts'] and record['page_hash']
        assert len(c.tool('list_model_specs')['records']) == 3
        checks.append('Word生成、默认命名、进度恢复、重名保护、文件库检索关联、三个官网型号实查及未知型号不猜填')
        if args.live_ai:
            picture = Image.new('RGB', (1100,270), 'white')
            draw = ImageDraw.Draw(picture)
            font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 27)
            draw.text((20,20),'产品名称          型号              数量    单位    含税单价(元)',fill='black',font=font)
            draw.text((20,100),'测试支架        TEST-A001              2      件       12.50',fill='black',font=font)
            draw.text((20,180),'测试接头        TEST-B002              3      件       20.00',fill='black',font=font)
            image_path = args.output/'synthetic-table.png'
            picture.save(image_path)
            recognized = c.tool('recognize_goods_image', {'image_path':str(image_path)})
            assert len(recognized['goods']) == 2 and recognized['requires_review']
            assert any(g['model'] == 'TEST-A001' and float(g['price']) == 12.5 and float(g['qty']) == 2 for g in recognized['goods'])
            party = Image.new('RGB', (1100,300), 'white')
            d = ImageDraw.Draw(party)
            d.text((20,20),'乙方（供方）：测试供应商',fill='black',font=font)
            d.text((20,90),'乙方代表：测试联系人',fill='black',font=font)
            d.text((20,160),'乙方电话：021-00000001',fill='black',font=font)
            d.text((20,230),'乙方地址：测试地址',fill='black',font=font)
            party_path = args.output/'synthetic-party.png'; party.save(party_path)
            batch = c.tool('recognize_contract_images', {'image_paths':[str(image_path),str(party_path)]})
            assert batch['requires_review'] and len(batch['result']['goods']) == 2
            assert batch['result']['fields']['乙方名称'] == '测试供应商'
            assert batch['result']['fields']['乙方电话'] == '021-00000001'
            draft = c.tool('draft_contract_description', parameters)
            assert all(draft['draft'][key] for key in ('title','overview','technical'))
            checks.append('MCP实连DeepSeek：合成表格与乙方资料多图批量识别、采购说明生成')
        report = {'passed': True, 'liveAiTested': args.live_ai, 'checks': checks, 'generatedProgress': str(progress)}
        (args.output/'mcp-test-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2), encoding='utf-8')
        print(json.dumps(report,ensure_ascii=True))
    finally:
        c.close()

if __name__ == '__main__': main()
