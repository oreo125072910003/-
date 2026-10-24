"""把用户已提供的两份合同存为本地副本，并预存已核实的官网参数；不向AI发送合同。"""
import json, subprocess, sys
from pathlib import Path
exe=Path(sys.argv[1]); output=Path(sys.argv[2])
p=subprocess.Popen([str(exe),'--output-dir',str(output)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
counter=0
def rpc(method,params=None,notify=False):
    global counter
    counter+=1
    q={'jsonrpc':'2.0','method':method,'params':params or {}}
    if not notify:q['id']=counter
    p.stdin.write(json.dumps(q,ensure_ascii=False)+'\n');p.stdin.flush()
    if not notify:
        r=json.loads(p.stdout.readline())
        if 'error' in r: raise RuntimeError(r['error'])
        return r['result']
def tool(name,args):
    r=rpc('tools/call',{'name':name,'arguments':args})
    if r.get('isError'):raise RuntimeError(r['content'][0]['text'])
    return json.loads(r['content'][0]['text'])
try:
    rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'library-setup','version':'2'}});rpc('notifications/initialized',notify=True)
    files=[Path('F:/wx file/xwechat_files/wxid_579nqogdaa5n29_b8df/temp/RWTemp/2026-10/ad7feb11c7710829b2dc549ac9a747ac/九州14.5.docx'),Path('C:/Users/ADMIN/Downloads/交大-九州19.7955.pdf')]
    imported=[]
    for f in files:
        if f.exists(): imported.append(tool('library_import',{'path':str(f)})['entry']['name'])
    records=[]
    for m in ['PBS632','PMC780-APC-2','BS1355-B']: records.append(tool('lookup_model_specs',{'model':m})['record']['model'])
    report={'imported':imported,'verified_models':records,'library_count':len(tool('library_search',{})['entries'])}
    (exe.parent/'资料库初始化.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=True))
finally:
    p.stdin.close();p.wait(timeout=10)
