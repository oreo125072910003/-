using System;
using System.IO;
using System.Text;

namespace ContractHelper
{
    // Development resources are generated from synthetic data. Real templates
    // remain local user imports and are never embedded in a public build.
    public static class EmbeddedContent
    {
        public static readonly string[] Titles = { "使用说明", "AI接入说明", "模板和示例", "AI工作提示词" };
        public static string Prompt(string resource) { return Encoding.UTF8.GetString(ContractEngine.Resource(resource)).TrimStart('\uFEFF').Replace("\r\n", "\n").Replace("\n", "\r\n"); }
        public static string Read(int topic)
        {
            if (topic == 3) return Prompt("agent-prompt.txt");
            if (topic == 2) return "本开发版只内置脱敏合成的采购模板与参考样例。它们用于验证填写、金额和文件生成，未经法律或业务审定。真实合同、采购清单、联系人和银行资料没有从旧项目复制。请通过模板库导入经确认的业务模板。历史学校模板的识别规则保留用于用户自行导入时兼容。";
            return Prompt(topic == 1 ? "mcp-help.txt" : "user-help.txt");
        }
        public static void EnsureLibrary()
        {
            Store.Locked(() => {
                string folder = Path.Combine(AppStorage.Root, "Builtin"); Directory.CreateDirectory(folder);
                string[] names = { "脱敏开发采购模板.docx", "脱敏开发参考.docx", "脱敏开发说明.pdf" };
                string[] resources = { "template.docx", "reference.docx", "reference.pdf" };
                for (int i = 0; i < names.Length; i++)
                {
                    byte[] bytes = ContractEngine.Resource(resources[i]); string path = Path.Combine(folder, names[i]);
                    if (!File.Exists(path) || AppStorage.Hash(File.ReadAllBytes(path)) != AppStorage.Hash(bytes)) Store.Write(path, bytes);
                }
                string marker = Path.Combine(AppStorage.Root, "seed-library-assistant-dev-1.done");
                if (!File.Exists(marker)) {
                    var entry = ContractLibrary.Import(Path.Combine(folder, names[0]), null, "template", "fillable");
                    for (int i = 1; i < names.Length; i++) ContractLibrary.Import(Path.Combine(folder, names[i]), null, "template", "reference", entry.id);
                    Store.Write(marker, "assistant-dev-1");
                }
                MaterialCatalog.EnsureSeed(); return true;
            });
        }
    }
}
