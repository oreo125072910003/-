# -*- coding: utf-8 -*-
import os, csv, io
OUT=r'G:/小助手/清单'
os.makedirs(OUT, exist_ok=True)
rows=[]
def add(cat, path, note=''):
    try:
        if not os.path.exists(path): rows.append([cat, path.replace('/','\\'), '缺失', '', note]); return
        if os.path.isdir(path):
            total=0; files=0
            for base,dirs,fs in os.walk(path):
                for f in fs:
                    try: total+=os.path.getsize(os.path.join(base,f)); files+=1
                    except OSError: pass
            rows.append([cat, path.replace('/','\\'), '目录', '%.1f MB / %d 文件'%(total/1048576,files), note])
        else:
            rows.append([cat, path.replace('/','\\'), '文件', '%.2f MB'%(os.path.getsize(path)/1048576), note])
    except OSError as e:
        rows.append([cat, path.replace('/','\\'), 'error', str(e), note])
WS='G:/wechat-deepseek/data/workspace'
# 汇总入口
add('00-入口','G:/小助手','r')
add('00-入口','G:/小助手/README.md','')
# 主程序
add('01-主程序','G:/wechat-deepseek/app/WeChatAgent.exe','Electron 桌面客户端 (212MB)')
add('01-主程序','G:/wechat-deepseek/app/resources/project','安装包内的项目副本(deployment 校验源)')
add('01-主程序','G:/wechat-deepseek/app/resources','资源目录')
# 项目工作区
add('02-项目','G:/wechat-deepseek/data/workspace','运行中的真项目 (849MB)')
for d,n in [('config','主配置：wechatagent.json / 凭据 / 策略文件'),('roles','人格 md'),('scripts','manage.ps1、reader-api.py、hook-onebot.mjs、console-server.mjs 等'),
            ('components','qq-bridge(社交桥)、WeChat-Hook(hook源码)、weflow-cli(读库)'),('packages','dsh-social-bridge-plugin(DSH插件)、extension-runtime'),
            ('public/console','网页控制台静态资源'),('docs','项目自带 19 篇说明文档'),('extensions/skills','扩展技能(meme-search)'),
            ('state','运行状态与日志'),('state/logs','服务日志(排障首先看这里)'),('state/hook','挂载版微信客户端 4.1.10.27'),
            ('state/stickers','表情包缓存/发送记录'),('state/media','媒体缓存'),('state/text-deliveries','文本发送回执记录')]:
    add('02-项目', WS+'/'+d, n)
add('02-项目', WS+'/config/wechatagent.json','总配置：账号/白名单/授权/人格')
add('02-项目', WS+'/scripts/manage.ps1','一键启停入口')
add('02-项目', WS+'/scripts/reader-api.py','读微信数据库 API(5031)')
add('02-项目', WS+'/scripts/hook-onebot.mjs','OneBot 适配器/发送(11229/8766)')
add('02-项目', WS+'/scripts/console-server.mjs','控制台后端(WeChatAgent 内嵌)')
add('02-项目', WS+'/components/qq-bridge/src/social-bridge.js','社交桥主程序')
add('02-项目', WS+'/components/qq-bridge/src/core/social-engine.js','对话调度/群消息规则/发送纪律')
add('02-项目', WS+'/packages/dsh-social-bridge-plugin','DSH 微信插件(会话/工具/上下文)')
add('02-项目', WS+'/roles/小助手.md','小助手人格(每轮读取，改完立即生效)')
# 运行时
add('03-运行时','G:/wechat-deepseek/data/runtimes','项目 Python 3.13')
add('03-运行时','C:/Users/ADMIN/.dsh/local-fixes/powershell-7.6.5','项目自带 PowerShell 7')
# 电脑桥接
add('04-电脑桥接','F:/deepseek工作区/wechat-pc-bridge','电脑桥接 MCP(8765)')
for f,n in [('mcp_dsh_server.py','MCP 服务本体(16 个工具)'),('config.json','桥接配置(token/代理/目标)'),('send_wechat_native.ps1','微信 UI 发送脚本(文字/图片/文件)'),
            ('start_hidden.vbs','后台启动 pcbridge'),('pcbridge_watchdog_loop.ps1','看门狗循环'),('pcbridge_watchdog.vbs','看门狗隐藏启动'),
            ('restart_wx_software.ps1','软件渲染重启微信客户端'),('wx_client_watchdog.ps1','微信客户端看门狗'),('bridge.log','桥接日志'),
            ('watchdog_pcbridge.log','看门狗日志'),('README.md','桥接说明'),('README-文件发送.md','文件发送说明')]:
    add('04-电脑桥接','F:/deepseek工作区/wechat-pc-bridge/'+f,n)
add('04-电脑桥接','F:/deepseek工作区/wechat-pc-bridge/_diag_archive_20261023','诊断脚本归档(52 个历史脚本)')
# DSH
add('05-DSH','F:/deepseek harness','DSH 桌面端(1GB)')
add('05-DSH','C:/Users/ADMIN/.dsh','DSH 用户目录(1GB)')
add('05-DSH','C:/Users/ADMIN/.dsh/profiles/desktop/cordis.patch.yml','DSH 插件补丁(MCP/模型/主题)')
add('05-DSH','C:/Users/ADMIN/.dsh/sessions','DSH 会话记录')
add('05-DSH','C:/Users/ADMIN/.dsh/dsh-expression.json','表情包设置')
add('05-DSH','C:/Users/ADMIN/.dsh/meme-packs','表情包图库')
# 合同
add('06-合同助手','C:/Users/ADMIN/Documents/电脑管理/contract-helper','合同助手项目')
add('06-合同助手','C:/Users/ADMIN/Documents/电脑管理/contract-helper/desktop/成品_合同助手2.3最终版','合同助手 MCP + 桌面版')
add('06-合同助手','C:/Users/ADMIN/Documents/电脑管理/contract-helper/生成的合同','已生成合同')
# 微信数据
add('07-微信数据','F:/wx file','微信数据库/文件缓存(勿手动改)')
with io.open(os.path.join(OUT,'文件清单.csv'),'w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f); w.writerow(['类别','路径','类型','大小','说明']); w.writerows(rows)
print('CSV rows:', len(rows), '->', os.path.join(OUT,'文件清单.csv'))
for r in rows[:10]: print(r)
