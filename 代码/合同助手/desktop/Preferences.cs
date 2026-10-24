using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace ContractHelper
{
    public static class Store
    {
        public static T Locked<T>(Func<T> action)
        {
            string key = AppStorage.Hash(Encoding.UTF8.GetBytes(Path.GetFullPath(AppStorage.Root).ToUpperInvariant())).Substring(0, 24);
            using (var gate = new Mutex(false, "Global\\ContractHelper-" + key))
            {
                bool entered = false;
                try { try { entered = gate.WaitOne(30000); } catch (AbandonedMutexException) { entered = true; } if (!entered) throw new Exception("资料库正在保存，请稍后重试。"); return action(); }
                finally { if (entered) gate.ReleaseMutex(); }
            }
        }
        public static void Write(string path, string text) { Write(path, Encoding.UTF8.GetBytes(text)); }
        public static void Write(string path, byte[] bytes)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
            string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                File.WriteAllBytes(temp, bytes);
                for (int attempt = 0; ; attempt++) {
                    try { if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path); break; }
                    catch (IOException) { if (attempt >= 3) throw; Thread.Sleep(new[] { 60, 180, 450 }[attempt]); }
                }
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        public static string Owned(string folder, string id)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(id ?? "", "^[a-f0-9]{32,64}$")) throw new Exception("资料记录编号无效。");
            string root = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string result = Path.GetFullPath(Path.Combine(root, id));
            if (!result.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("资料路径无效。"); return result;
        }
    }
    public class AppPreferences
    {
        public string output_directory = Path.Combine(AppStorage.Root, "Outputs");
        public string amount_unit = "万";
        public Dictionary<string, string> supplier_aliases = new Dictionary<string, string> { { "北京东方中科集成科技股份有限公司", "北京东方中科" } };
    }
    public static class Preferences
    {
        static string FilePath { get { return Path.Combine(AppStorage.Root, "preferences.json"); } }
        public static AppPreferences Load()
        {
            if (!File.Exists(FilePath)) return new AppPreferences();
            var p = ContractEngine.Json().Deserialize<AppPreferences>(File.ReadAllText(FilePath, Encoding.UTF8)); Validate(p); return p;
        }
        public static void Validate(AppPreferences p)
        {
            if (p == null || string.IsNullOrWhiteSpace(p.output_directory) || !Path.IsPathRooted(p.output_directory)) throw new Exception("请选择完整的输出文件夹路径。");
            p.output_directory = Path.GetFullPath(p.output_directory);
            if (p.amount_unit != "万" && p.amount_unit != "元") throw new Exception("文件名金额单位只能为万或元。");
            if (p.supplier_aliases == null) p.supplier_aliases = new Dictionary<string, string>();
        }
        public static void Save(AppPreferences p) { Validate(p); Store.Locked(() => { Store.Write(FilePath, ContractEngine.Json().Serialize(p)); return true; }); }
    }
}
