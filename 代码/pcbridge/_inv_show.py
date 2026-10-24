# -*- coding: utf-8 -*-
import json, io
d=json.load(io.open(r'G:/小助手/docs/_inventory.json',encoding='utf-8'))
def show(name, rows, n=25):
    print('==',name)
    for r in rows[:n]:
        if isinstance(r,list) and len(r)==4:
            print('  %-38s %-4s %8.1f MB %6d files' % (r[0], r[1], r[2]/1048576, r[3]))
        else:
            print('  ', r)
print('== sizes')
for k in ('wechat_app','workspace','runtimes','pcbridge','dsh_profile','contract','wechat_data','consolidated','dsh_ws'):
    v=d[k]; print('  %-12s %9.1f MB %6d files  %s'%(k, v['size_bytes']/1048576, v['files'], v['path']))
show('top_workspace', d['top_workspace'], 30)
show('ws_dirs', [x for x in d['ws_dirs']], 40)
show('top_pcbridge', d['top_pcbridge'], 20)
show('top_dshprofile', d['top_dshprofile'], 20)
show('top_dsh', d['top_dsh'], 25)
show('top_app', d['top_app'], 20)
show('schtasks', d['schtasks'], 10)
print('== wechatagent_config')
print(json.dumps(d['wechatagent_config'], ensure_ascii=False, indent=1)[:2500])
print('== pcbridge_config')
print(json.dumps(d['pcbridge_config'], ensure_ascii=False))
