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

从 1.0.7 开始，默认桌面构建和独立安装器都包含专用微信 4.1.10.27、匹配连接组件、Python 与 reader，不再要求另下 DSH 完整插件才有微信。组件仅放在应用 `resources/companions` 外置目录，逐文件摘要在 `manifest.json`，不会重复塞入 `app.asar`。安装器构建默认拒绝缺少任一必需组件、缺少组件清单、摘要不一致或混入个人数据的程序包。开发者可运行 `npm run package -- --without-wechat` 明确生成轻量应用目录，但该目录不能用默认完整版安装器发布。

GitHub 下载名使用 `xiaozhushou-Setup-<产品版本>.exe`，本地中文名保持不变。发布脚本通过 `--asset-name 小助手-Setup-<版本>.exe=xiaozhushou-Setup-<版本>.exe` 明确映射，SHA256 清单使用远端下载名；不依赖 GitHub 对特殊字符的重命名。

编译使用 [官方 NSIS 3.13 ZIP](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/)，下载工具在 `scripts/ensure-nsis.py` 固定版本与 SHA256，并逐文件核验提取后的编译器和包含文件。只解压到忽略的 `dist/installer-tools`，不会全局安装编译器。需要 Windows x64、Node.js、项目依赖、Python 和首次下载时的网络；不增加产品运行依赖。

安装器以当前 Windows 用户运行，默认安装到 `LocalAppData/Programs/XiaoZhuShou`，创建当前用户的桌面和开始菜单快捷方式及卸载注册。DSH 仍需按原产品要求安装并登录；安装器不复制或更换 DSH。

安装目录必须为空，或有本产品安装标记。安装和卸载均在占用文件时停止并提示正常退出，不强杀小助手进程。卸载使用编译时明确列出的程序文件，非递归移除空目录，保留不属于程序的文件及程序目录外的全部个人数据、微信和 DSH。

验收脚本运行同一安装器的 `/S /ISOLATED` 模式：只省略真实快捷方式和注册表写入，实际安装/卸载程序文件照常执行。它在独立临时目录检查安装后 SHA、实际微信/Python/reader 全部外置组件摘要、占用时拒绝升级、安装后的应用离线 smoke 与真实组件准备、卸载结果和合成用户文件保留。卸载后还会逐项确认应用生成的个人 `wechat-environment` 保持完整。不打开个人数据库、不启动微信登录或重启日常 DSH。验收报告位于 `dist/installer-verification/<版本>/report.json`，临时保留文件用于核对，不提交 Git。

实现依据为 [NSIS 官方脚本参考](https://nsis.sourceforge.io/Docs/Chapter4.html)，包含当前用户安装、HKCU 注册、静默模式和明确文件删除指令。
