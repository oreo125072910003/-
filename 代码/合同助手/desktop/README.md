# 合同源码恢复开发版

2026-10-25 从本机旧合同项目的 **2.3 源码快照** 恢复。原主工程 `mcp/McpServer.cs` 与该快照的对应文件 SHA-256 完全相同，详见 `source-origin.json`。没有修改旧项目或正在运行的合同软件。

恢复范围包含 MCP 所需九个核心类、完整原生桌面程序及构建脚本。内置 DOCX、PDF、XLSX、JSON 全部为本工程生成的合成开发资源，未复制旧真实合同、采购表、联系人、账户、API 配置、日志或生成结果。OCR 与起草提示词保留原版的输出契约；历史学校模板的严格识别规则保留，以兼容用户自行导入。该规则不作用于通用开发模板。

## 构建和离线验证

在本目录的上一级 `代码/合同助手` 执行：

```powershell
& ./mcp/build.ps1
python -X utf8 ./mcp/test_offline.py --exe ./desktop/out/development/合同助手MCP.exe
python -X utf8 ./desktop/test_native_args.py --exe ./desktop/out/development/合同填写小助手.exe
```

构建使用 Windows 自带 .NET Framework 4.x C# 编译器，默认产物位于已忽略的 `desktop/out/development`。生成开发资源使用 Python 标准库：`python -X utf8 ./desktop/generate_dev_assets.py`；常规构建直接读取仓库内已生成的资源，不依赖 Python。

原生程序的 `--self-test <目录>` 只执行合成数据检查，不打开 GUI、不调用模型。它与 MCP stdio 测试分别验证金额、分期舍入、Word 内部 XML、模板身份、输出不覆盖和数据目录隔离。它们没有验证实际 Word 排版、OCR/AI、真实业务模板或真实账号。

## 接入小助手

MCP 启动时必须由产品传入自己的目录：

```text
合同助手MCP.exe --data-dir <产品数据目录/contract> --output-dir <产品成果目录>
```

`api.json`、常用双方信息、合同库与偏好都跟随 `--data-dir`，不再读取旧 `ContractHelper` 用户目录。独立打开原生程序时默认使用 `%LOCALAPPDATA%/Xiaozhushou/ContractHelper`。需要旧业务模板或资料时应执行显式迁移或导入。

原生 `合同填写小助手.exe` 同样接受 `--data-dir <绝对目录>`，可以与 `--self-test` / `--open-progress` 组合；在任何资料库和配置读取前设置目录。未知参数、目录缺值、相对目录、重复目录参数均在启动 GUI 前返回退出码2。离线参数测试只走 `--self-test` 和无效参数分支，没有启动窗口。两个 EXE 的文档和说明资源均内嵌，部署无需复制旧 `assets` 或个人配置。

当前模板名会明确标为“脱敏开发模板”。它能生成真实 DOCX 文件，但不是审定业务模板，不能作为正式合同验收通过的证明。T23 仍需真实模板、成果展示和来源核对。旧 `mcp/test_accuracy.py` 等历史测试依赖模型/业务原件，本轮没有运行，不能计为通过。

## 回退

本次没有改写旧运行目录，没有切换真实服务。停止新开发进程后可直接回到原入口。新建数据目录可保留用于复核；不应把它覆盖回旧产品数据目录。
