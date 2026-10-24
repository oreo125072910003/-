# -*- coding: utf-8 -*-
import os, json, glob, hashlib, subprocess, time
ROOT='G:/小助手'
os.makedirs(os.path.join(ROOT,'docs'), exist_ok=True)
out={}
def tree_size(path, maxdepth=1):
    total=0; files=0
    try:
        for base, dirs, fs in os.walk(path):
            rel=os.path.relpath(base,path)
            depth=0 if rel=='.' else rel.count(os.sep)+1
            if depth>maxdepth: dirs[:]=[]; continue
            for f in fs:
                try: total+=os.path.getsize(os.path.join(base,f)); files+=1
                except OSError: pass
    except OSError: pass
    return total, files
def dirs_of(path,maxdepth=1):
    res=[]
    try:
        for base, dirs, fs in os.walk(path):
            rel=os.path.relpath(base,path)
            depth=0 if rel=='.' else rel.count(os.sep)+1
            if depth>maxdepth: dirs[:]=[]; continue
            n=depth
            res.append((os.path.relpath(base,path), n, sum(os.path.getsize(os.path.join(base,f)) for f in fs if os.path.isfile(os.path.join(base,f)))))
    except OSError: pass
    return res
roots={
 'wechat_app':'G:/wechat-deepseek/app',
 'workspace':'G:/wechat-deepseek/data/workspace',
 'runtimes':'G:/wechat-deepseek/data/runtimes',
 'pcbridge':'F:/deepseek工作区/wechat-pc-bridge',
 'dsh_profile':'C:/Users/ADMIN/.dsh',
 'contract':'C:/Users/ADMIN/Documents/电脑管理/contract-helper',
 'wechat_data':'F:/wx file',
 'consolidated':'G:/小助手',
 'dsh_ws':'F:/deepseek工作区',
}
for k,p in roots.items():
    s,f=tree_size(p,4)
    out[k]={'path':p.replace('/','\\'),'size_bytes':s,'files':f}
# top level of key roots
def top(p,limit=40):
    try:
        items=[]
        for e in os.listdir(p):
            fp=os.path.join(p,e)
            try:
                if os.path.isdir(fp):
                    s,f=tree_size(fp,2); items.append([e,'dir',s,f])
                else:
                    items.append([e,'file',os.path.getsize(fp),1])
            except OSError: pass
        items.sort(key=lambda x:-x[2])
        return items[:limit]
    except OSError: return []
out['top_workspace']=top('G:/wechat-deepseek/data/workspace')
out['top_pcbridge']=top('F:/deepseek工作区/wechat-pc-bridge')
out['top_dsh']=top('F:/deepseek工作区',30)
out['top_dshprofile']=top('C:/Users/ADMIN/.dsh',30)
out['top_app']=top('G:/wechat-deepseek/app',30)
# config snapshot
def js(p):
    try:
        import io
        return json.load(io.open(p,encoding='utf-8-sig'))
    except Exception: return None
cfg=js('G:/wechat-deepseek/data/workspace/config/wechatagent.json') or {}
out['wechatagent_config']={
 'runtime':cfg.get('runtime'), 'ports':cfg.get('ports'),
 'whitelist':(cfg.get('wechat') or {}).get('whitelist'),
 'persona_default':(cfg.get('persona') or {}).get('default'),
 'persona_chats':list(((cfg.get('persona') or {}).get('chats') or {}).keys()),
 'dshAccess_chats':{k:len(v) for k,v in (((cfg.get('wechat') or {}).get('dshAccess') or {}).get('chats') or {}).items()},
 'chatModes':(cfg.get('wechat') or {}).get('chatModes'),
 'sender':(cfg.get('runtime') or {}).get('sender'),
}
pcfg=js('F:/deepseek工作区/wechat-pc-bridge/config.json') or {}
out['pcbridge_config']={k:pcfg.get(k) for k in ('host','port','workspace_root','allow_shell','allow_outside_workspace','proxy','wechat_target_wxid','wechat_ui_chat_title','wechat_ui_switch_chat','job_notify')}
out['pcbridge_config'].pop('token',None)
# pcbridge tools from source
try:
    src=open('F:/deepseek工作区/wechat-pc-bridge/mcp_dsh_server.py',encoding='utf-8').read()
    import re
    tools=re.findall(r'"name":\s*"([a-z_]+)"', src)
    out['pcbridge_tools']=sorted(set(tools))
except Exception: out['pcbridge_tools']=None
# roles
def lens():
    res=[]
    for p in glob.glob('G:/wechat-deepseek/data/workspace/roles/*.md'):
        res.append([os.path.basename(p), os.path.getsize(p)])
    return res
out['roles']=lens()
# DSH profile plugin patch
try:
    out['dsh_patch']=open('C:/Users/ADMIN/.dsh/profiles/desktop/cordis.patch.yml',encoding='utf-8').read()[:4000]
except Exception: out['dsh_patch']=''
# scheduled tasks related
try:
    r=subprocess.run(['schtasks','/query','/fo','csv'],capture_output=True,text=True,timeout=60)
    rows=[l for l in r.stdout.splitlines() if 'pcbridge' in l.lower() or 'wechat' in l.lower() or 'deepseek' in l.lower() or 'dsh' in l.lower()]
    out['schtasks']=rows[:20]
except Exception as e: out['schtasks']=str(e)
# workspace dirs with sizes
out['ws_dirs']=[(d,n,s) for d,n,s in dirs_of('G:/wechat-deepseek/data/workspace',2)]
json.dump(out, open(os.path.join(ROOT,'docs','_inventory.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('saved _inventory.json')
for k in ('wechat_app','workspace','pcbridge','dsh_profile','contract','wechat_data'):
    v=out[k]; print(k, round(v['size_bytes']/1024/1024,1),'MB', v['files'],'files')
print('tools:', len(out['pcbridge_tools'] or []), out['pcbridge_tools'])
print('roles:', out['roles'])
print('dshAccess chats:', out['wechatagent_config']['dshAccess_chats'])
print('ports:', out['wechatagent_config']['ports'])
