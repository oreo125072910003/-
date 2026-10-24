using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace ContractHelper
{
    // 只固定原模板确实给出的信息，不把示例金额、供应商或经办人当作固定内容。
    public static class TemplateRules
    {
        public const string Name = "通用采购合同（脱敏开发模板）";
        public const string ReferenceHash = "47cafae7f1c644e6a6f3216abfb733111ca3fc53e29b58c968594fba522418a3";
        public const string TemplateHash = "f9a977216ff82b3f560b94283165e51343d61e2936fcb5c15e1d749a5f147c37";
        public static readonly string[] ForbiddenFields = { "合同编号", "流水号", "合同序列号", "序列号", "签订日期" };
        public static readonly Dictionary<string, string> FixedFields = new Dictionary<string, string> {
            { "甲方名称", "上海交通大学" }, { "甲方地址", "上海市闵行区东川路800号" },
            { "交货天数", "30" }, { "交货地点", "上海交通大学指定地点" },
            { "质保年限", "2" }, { "回复小时", "4" }, { "到场小时", "24" }
        };
        public static bool IsSchool(byte[] bytes)
        {
            string hash; using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            return hash == ReferenceHash || hash == TemplateHash || hash == "620568880dfd06d2c5cc6c1791f1a65239a8aaf784de9e941675335b191eabe2" || hash == "7ac3ba1cab24f97b5310ead486dfc650c32e88993ed18c37caefaae41b754dd7";
        }
        public static List<Payment> DefaultPayments()
        {
            return new List<Payment> { new Payment { condition = "标的物验收合格后10个工作日内", ratio = "100" } };
        }
        public static Dictionary<string, string> Defaults() { return ContractEngine.Json().Deserialize<Dictionary<string, string>>(Encoding.UTF8.GetString(ContractEngine.Resource("defaults.json"))); }
        public static string FileBase(ContractData data, DateTime date)
        {
            string supplier = data.Get("乙方名称").Trim(); if (supplier == "") throw new Exception("请填写乙方名称后生成文件名。");
            var preferences = Preferences.Load(); string alias = data.Get("乙方简称").Trim();
            if (alias == "") preferences.supplier_aliases.TryGetValue(supplier, out alias);
            if (!string.IsNullOrWhiteSpace(alias)) supplier = alias;
            else supplier = System.Text.RegularExpressions.Regex.Replace(supplier, "(?:股份有限公司|有限责任公司|有限公司)$", "");
            foreach (char c in Path.GetInvalidFileNameChars()) supplier = supplier.Replace(c, '_'); if (supplier.Length > 70) supplier = supplier.Substring(0, 70);
            decimal total = ContractEngine.Total(data);
            string money = preferences.amount_unit == "万" ? (total / 10000m).ToString("0.######", System.Globalization.CultureInfo.InvariantCulture) + "万" : ContractEngine.Money(total) + "元";
            return date.ToString("yyyyMMdd") + "_" + supplier.TrimEnd('.', ' ') + "_" + money;
        }
        public static string AvailableBase(string folder, string name)
        { string result = Path.Combine(folder, name); for (int i = 2; File.Exists(result + ".docx") || File.Exists(result + ".json"); i++) result = Path.Combine(folder, name + "（" + i + "）"); return result; }
        public static void Prepare(ContractData d, bool school)
        {
            if (d == null || d.fields == null) return;
            d.cover = false; foreach (string key in ForbiddenFields) d.fields.Remove(key);
            if (school) { foreach (var kv in Defaults()) if (!d.fields.ContainsKey(kv.Key)) d.fields[kv.Key] = kv.Value; foreach (var kv in FixedFields) d.fields[kv.Key] = kv.Value; }
            if (d.goods == null) return;
            var goods = d.goods.Where(g => g != null && !string.IsNullOrWhiteSpace(g.name)).ToList(); if (goods.Count == 0) return;
            if (string.IsNullOrWhiteSpace(d.Get("合同名称"))) d.fields["合同名称"] = goods[0].name + (goods.Count > 1 ? "等" + goods.Count + "项货物" : "") + "采购合同";
            if (string.IsNullOrWhiteSpace(d.Get("项目概况"))) {
                string purpose = d.Get("采购用途").Trim(); string names = string.Join("、", goods.Take(3).Select(g => g.name));
                d.fields["项目概况"] = (purpose == "" ? "根据项目采购需求，" : "为满足" + purpose.TrimEnd('。', '，', '；') + "的需要，") + "采购" + names + (goods.Count > 3 ? "等" + goods.Count + "项货物" : "") + "。";
            }
        }
    }
    public static class CommonInfoStore
    {
        public static readonly string[] Keys = { "甲方代表", "甲方电话", "甲方税号", "甲方开户行", "甲方账号", "乙方名称", "乙方简称", "乙方代表", "乙方电话", "乙方地址", "乙方税号", "乙方开户行", "乙方账号" };
        public static string DefaultPath { get { return Path.Combine(AppStorage.Root, "common.json"); } }
        public static Dictionary<string, string> Load(string path)
        {
            if (!File.Exists(path)) return new Dictionary<string, string>(); var all = ContractEngine.Json().Deserialize<Dictionary<string, string>>(File.ReadAllText(path, Encoding.UTF8)); return (all ?? new Dictionary<string, string>()).Where(kv => Keys.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value ?? "");
        }
        public static void Save(ContractData d, string path)
        {
            var fields = Load(path); foreach (string key in Keys) if (d.fields.ContainsKey(key)) fields[key] = d.Get(key); Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))); File.WriteAllText(path, ContractEngine.Json().Serialize(fields), Encoding.UTF8);
        }
    }
}
