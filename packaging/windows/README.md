# Windows 安装包

先使用发行模式构建桌面程序，再构建安装包：

```powershell
$env:XIAOZHUSHOU_DISTRIBUTION='1'
npm run package
Remove-Item Env:XIAOZHUSHOU_DISTRIBUTION
npm run package:installer
python scripts/verify-installer.py
```

产物在 `dist/releases/<产品版本>/小助手-Setup-<产品版本>.exe`，SHA256 和编译工具来源记录在同目录 `installer.json`。安装器必须使用稳定的三段产品版本，拒绝包含本机运行路径配置的应用包。

编译使用 [官方 NSIS 3.13 ZIP](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/)，下载工具在 `scripts/ensure-nsis.py` 固定版本与 SHA256，并逐文件核验提取后的编译器和包含文件。只解压到忽略的 `dist/installer-tools`，不会全局安装编译器。需要 Windows x64、Node.js、项目依赖、Python 和首次下载时的网络；不增加产品运行依赖。

安装器以当前 Windows 用户运行，默认安装到 `LocalAppData/Programs/XiaoZhuShou`，创建当前用户的桌面和开始菜单快捷方式及卸载注册。DSH 仍需按原产品要求安装并登录；安装器不复制或更换 DSH。

安装目录必须为空，或有本产品安装标记。安装和卸载均在占用文件时停止并提示正常退出，不强杀小助手进程。卸载使用编译时明确列出的程序文件，非递归移除空目录，保留不属于程序的文件及程序目录外的全部个人数据、微信和 DSH。

验收脚本运行同一安装器的 `/S /ISOLATED` 模式：只省略真实快捷方式和注册表写入，实际安装/卸载程序文件照常执行。它在独立临时目录检查安装后 SHA、占用时拒绝升级、安装后的应用离线 smoke、卸载结果和合成用户文件保留，不打开个人数据库或重启日常 DSH。验收报告位于 `dist/installer-verification/<版本>/report.json`，临时保留文件用于核对，不提交 Git。

实现依据为 [NSIS 官方脚本参考](https://nsis.sourceforge.io/Docs/Chapter4.html)，包含当前用户安装、HKCU 注册、静默模式和明确文件删除指令。
