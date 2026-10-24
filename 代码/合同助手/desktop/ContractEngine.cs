using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;
using System.Xml.Linq;

namespace ContractHelper
{
    public class Good { public string name { get; set; } public string model { get; set; } public string brand { get; set; } public string qty { get; set; } public string unit { get; set; } public string price { get; set; } public string spec { get; set; } }
    public class Payment { public string condition { get; set; } public string ratio { get; set; } }
    public class TemplateData { public string name { get; set; } public string base64 { get; set; } }
    public class ContractData
    {
        public int version { get; set; }
        public Dictionary<string, string> fields { get; set; }
        public bool cover { get; set; }
        public List<Good> goods { get; set; }
        public List<Payment> payments { get; set; }
        public TemplateData template { get; set; }
        public string template_id { get; set; }
        public string reference_id { get; set; }
        public ContractData() { version = 1; fields = new Dictionary<string, string>(); goods = new List<Good>(); payments = new List<Payment>(); }
        public string Get(string key) { return fields.ContainsKey(key) ? fields[key] ?? "" : ""; }
    }
    public static class ContractEngine
    {
        public static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        static readonly Regex Token = new Regex(@"\{\{([^{}]+)\}\}");
        public static readonly string[] GoodKeys = { "货物序号", "货物名称", "品牌型号", "数量", "单位", "单价", "小计", "货物技术指标" };
        public static readonly string[] PayKeys = { "付款期数", "付款条件", "付款比例", "付款金额" };
        public static readonly string[] FieldKeys = { "合同名称", "项目概况", "交货天数", "交货地点", "质保年限", "回复小时", "到场小时", "技术补充", "采购用途", "合同总额", "大写金额", "技术指标", "甲方名称", "甲方代表", "甲方电话", "甲方地址", "乙方名称", "乙方简称", "乙方代表", "乙方电话", "乙方地址" };
        public static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 40 * 1024 * 1024 }; }
        public static byte[] Resource(string name)
        {
            using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            using (var output = new MemoryStream()) { if (input == null) throw new Exception("内置资源缺失：" + name); input.CopyTo(output); return output.ToArray(); }
        }
        public static ContractData Sample() { return Json().Deserialize<ContractData>(Encoding.UTF8.GetString(Resource("sample.json"))); }
        public static string Text(XElement p) { return string.Concat(p.Descendants(W + "t").Select(t => t.Value)); }
        static XDocument ReadXml(Stream stream)
        {
            using (var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 50 * 1024 * 1024 })) return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        }
        public static decimal Number(string value, int digits, string label)
        {
            value = (value ?? "").Trim(); decimal number;
            if (!Regex.IsMatch(value, @"^\d{1,12}(?:\.\d{1," + digits + @"})?$") || !decimal.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out number)) throw new Exception(label + "须为非负数字，最多" + digits + "位小数。");
            return number;
        }
        public static string Money(decimal n) { return n.ToString("0.00", CultureInfo.InvariantCulture); }
        public static decimal Subtotal(Good g)
        {
            decimal q = Number(g.qty, 4, "数量"), p = Number(g.price, 2, "单价");
            if (q <= 0) throw new Exception("货物数量须大于0。");
            return Math.Round(q * p, 2, MidpointRounding.AwayFromZero);
        }
        public static decimal Total(ContractData d)
        {
            decimal total = d.goods.Sum(g => Subtotal(g)); if (total > 999999999999.99m) throw new Exception("合同总额过大，请检查数量和单价。"); return total;
        }
        public static string ChineseMoney(decimal n)
        {
            string digits = "零壹贰叁肆伍陆柒捌玖", result = ""; long fen = (long)Math.Round(n * 100, 0, MidpointRounding.AwayFromZero), yuan = fen / 100; bool gap = false;
            for (int i = 2; i >= 0; i--)
            {
                int group = (int)(yuan / (long)Math.Pow(10000, i) % 10000);
                if (group == 0) { if (result.Length > 0) gap = true; continue; }
                if (result.Length > 0 && (gap || group < 1000)) result += "零";
                string block = ""; bool zero = false;
                for (int j = 3; j >= 0; j--) { int x = group / (int)Math.Pow(10, j) % 10; if (x == 0) { if (block.Length > 0) zero = true; } else { if (zero) block += "零"; block += digits[x] + new[] { "", "拾", "佰", "仟" }[j]; zero = false; } }
                result += block + new[] { "", "万", "亿" }[i]; gap = false;
            }
            result = (result.Length == 0 ? "零" : result) + "元"; int angle = (int)(fen / 10 % 10), cent = (int)(fen % 10);
            if (angle == 0 && cent == 0) return result + "整";
            if (angle > 0) result += digits[angle] + "角"; else if (cent > 0 && yuan > 0) result += "零";
            if (cent > 0) result += digits[cent] + "分"; return result;
        }
        public static List<decimal> PaymentAmounts(ContractData d)
        {
            decimal total = Total(d), used = 0; var amounts = new List<decimal>();
            for (int i = 0; i < d.payments.Count; i++) { decimal n = i == d.payments.Count - 1 ? total - used : Math.Round(total * Number(d.payments[i].ratio, 2, "付款比例") / 100, 2, MidpointRounding.AwayFromZero); if (n < 0) throw new Exception("分期金额出现负数，请调整付款比例。"); amounts.Add(n); used += n; } return amounts;
        }
        public static void ValidateData(ContractData d)
        {
            if (d == null || d.fields == null || d.goods == null || d.payments == null || d.goods.Count == 0 || d.goods.Count > 500 || d.payments.Count == 0 || d.payments.Count > 100 || d.goods.Any(g => g == null) || d.payments.Any(p => p == null)) throw new Exception("合同数据不完整，货物和付款安排都至少需要一行。");
            foreach (string k in new[] { "合同名称", "项目概况", "甲方名称", "甲方代表", "甲方电话", "甲方地址", "乙方名称", "乙方电话", "乙方地址", "交货地点" }) if (string.IsNullOrWhiteSpace(d.Get(k))) throw new Exception("请填写：" + k);
            foreach (Good g in d.goods) { if (string.IsNullOrWhiteSpace(g.name) || string.IsNullOrWhiteSpace(g.model) || string.IsNullOrWhiteSpace(g.unit)) throw new Exception("请补全货物名称、品牌型号和单位。"); Subtotal(g); }
            if (d.payments.Any(p => string.IsNullOrWhiteSpace(p.condition)) || d.payments.Sum(p => Number(p.ratio, 2, "付款比例")) != 100) throw new Exception("请填写付款条件，付款比例合计须为100%。");
            foreach (string k in new[] { "交货天数", "回复小时", "到场小时" }) if (!Regex.IsMatch(d.Get(k), @"^\d+$") || Number(d.Get(k), 1, k) <= 0) throw new Exception(k + "须为大于0的整数。");
            Number(d.Get("质保年限"), 1, "质保年限"); Total(d); PaymentAmounts(d);
            foreach (string s in d.fields.Values.Concat(d.goods.SelectMany(g => new[] { g.name, g.model, g.qty, g.unit, g.price, g.spec })).Concat(d.payments.Select(p => p.condition))) if ((s ?? "").Contains("{{") || (s ?? "").Contains("}}")) throw new Exception("填写内容不能包含模板标记 {{ 或 }}。");
        }
        public static byte[] AdaptTemplate(byte[] bytes)
        {
            string hash; using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            return hash == TemplateRules.ReferenceHash || hash == "620568880dfd06d2c5cc6c1791f1a65239a8aaf784de9e941675335b191eabe2" || hash == "7ac3ba1cab24f97b5310ead486dfc650c32e88993ed18c37caefaae41b754dd7" ? Resource("template.docx") : bytes;
        }
        static bool IsPart(string name) { return Regex.IsMatch(name, @"^word/(document|header\d+|footer\d+)\.xml$"); }
        public static void ValidateTemplate(byte[] bytes)
        {
            var allowed = new HashSet<string>(FieldKeys.Concat(GoodKeys).Concat(PayKeys)); int count = 0;
            using (var input = new MemoryStream(bytes)) using (var zip = new ZipArchive(input, ZipArchiveMode.Read))
            {
                if (zip.GetEntry("word/document.xml") == null) throw new Exception("请选择 .docx Word 模板。");
                foreach (var entry in zip.Entries.Where(e => IsPart(e.FullName))) using (var stream = entry.Open())
                {
                    XDocument x = ReadXml(stream);
                    foreach (var p in x.Descendants(W + "p"))
                    {
                        string s = Text(p); foreach (Match m in Token.Matches(s)) { string key = m.Groups[1].Value; if (!allowed.Contains(key)) throw new Exception("模板标记不支持：" + key); count++; if (GoodKeys.Contains(key) || PayKeys.Contains(key)) { var row = p.Ancestors(W + "tr").FirstOrDefault(); if (row == null || row.Ancestors(W + "tr").Any()) throw new Exception("货物或付款标记须放在普通表格的数据行中。"); string t = Text(row); if (GoodKeys.Any(k => t.Contains("{{" + k + "}}")) && PayKeys.Any(k => t.Contains("{{" + k + "}}"))) throw new Exception("货物和付款标记不能放在同一行。"); } }
                        string left = Token.Replace(s, ""); if (left.Contains("{{") || left.Contains("}}")) throw new Exception("模板有不完整的填写标记。");
                    }
                }
            }
            if (count == 0) throw new Exception("未识别到填写标记。请用内置模板，或先在其他模板中加入 {{甲方名称}} 等标记。");
        }
        static void PutText(XElement node, string value)
        {
            string[] lines = (value ?? "").Replace("\r\n", "\n").Split('\n'); node.Value = lines[0]; node.SetAttributeValue(XNamespace.Xml + "space", "preserve"); XElement anchor = node;
            foreach (string line in lines.Skip(1)) { var br = new XElement(W + "br"); var t = new XElement(W + "t", new XAttribute(XNamespace.Xml + "space", "preserve"), line); anchor.AddAfterSelf(br, t); anchor = t; }
        }
        static void ReplaceSpan(XElement p, int start, int end, string value)
        {
            int offset = 0; var texts = p.Descendants(W + "t").Select(t => { int at = offset; offset += t.Value.Length; return new { Node = t, Start = at, End = offset }; }).ToList();
            var first = texts.First(t => t.End > start); var last = texts.Last(t => t.Start < end); string before = first.Node.Value.Substring(0, start - first.Start), after = last.Node.Value.Substring(end - last.Start);
            if (first.Node == last.Node) PutText(first.Node, before + value + after);
            else { for (int i = texts.IndexOf(first) + 1; i < texts.IndexOf(last); i++) texts[i].Node.Value = ""; last.Node.Value = after; PutText(first.Node, before + value); }
        }
        static void ReplaceTokens(XContainer x, Dictionary<string, string> values)
        {
            foreach (var p in x.Descendants(W + "p").ToList()) foreach (Match m in Token.Matches(Text(p)).Cast<Match>().Reverse()) { string key = m.Groups[1].Value; if (!values.ContainsKey(key)) throw new Exception("未填写的模板标记：" + key); ReplaceSpan(p, m.Index, m.Index + m.Length, values[key]); }
        }
        static void CloneRows(XDocument x, string[] keys, List<Dictionary<string, string>> rows, Dictionary<string, string> values)
        {
            foreach (var row in x.Descendants(W + "tr").Where(r => keys.Any(k => Text(r).Contains("{{" + k + "}}"))).ToList())
            {
                foreach (var data in rows) { var copy = new XElement(row); var all = new Dictionary<string, string>(values); foreach (var kv in data) all[kv.Key] = kv.Value; ReplaceTokens(copy, all); row.AddBeforeSelf(copy); } row.Remove();
            }
        }
        static void FillPaymentSlots(XDocument x, List<Dictionary<string, string>> payments, Dictionary<string, string> values)
        {
            var slots = x.Descendants(W + "tr").Where(r => Text(r).Contains("{{付款期数}}")).ToList();
            if (payments.Count > slots.Count) throw new Exception("这份模板最多支持" + slots.Count + "期付款。");
            for (int i = 0; i < slots.Count; i++) { var all = new Dictionary<string, string>(values); var data = i < payments.Count ? payments[i] : new Dictionary<string, string> { { "付款期数", (i + 1).ToString() }, { "付款条件", "" }, { "付款比例", "/" }, { "付款金额", "/" } }; foreach (var kv in data) all[kv.Key] = kv.Value; ReplaceTokens(slots[i], all); }
        }
        static void ExpandTechnical(XDocument x, string value)
        {
            foreach (var p in x.Descendants(W + "p").Where(p => Text(p) == "{{技术指标}}").ToList())
            {
                foreach (string block in Regex.Split(value, @"\n\s*\n").Where(s => s.Length > 0)) { var copy = new XElement(p); ReplaceSpan(copy, 0, Text(copy).Length, block); var pr = copy.Element(W + "pPr"); if (pr == null) { pr = new XElement(W + "pPr"); copy.AddFirst(pr); } if (pr.Element(W + "keepLines") == null) pr.Add(new XElement(W + "keepLines")); var spacing = pr.Element(W + "spacing"); if (spacing != null) spacing.SetAttributeValue(W + "after", "160"); p.AddBeforeSelf(copy); } p.Remove();
            }
        }
        public static byte[] Build(ContractData d, byte[] template)
        {
            d = Json().Deserialize<ContractData>(Json().Serialize(d)); bool school = TemplateRules.IsSchool(template); TemplateRules.Prepare(d, school);
            ValidateData(d); template = AdaptTemplate(template); ValidateTemplate(template); decimal total = Total(d); var values = new Dictionary<string, string>(); foreach (string k in FieldKeys) values[k] = d.Get(k);
            values["合同总额"] = "￥" + Money(total); values["大写金额"] = ChineseMoney(total);
            values["技术指标"] = string.Join("\n\n", d.goods.Select((g, i) => (i + 1) + ". " + g.name + "（" + g.model + "）\n" + (string.IsNullOrWhiteSpace(g.spec) ? "材料名称和型号按所提供采购清单填写。" : g.spec.Trim())).Concat(new[] { d.Get("技术补充") }).Where(s => !string.IsNullOrWhiteSpace(s)));
            var goods = d.goods.Select((g, i) => new Dictionary<string, string> { { "货物序号", (i + 1).ToString() }, { "货物名称", g.name }, { "品牌型号", g.model }, { "数量", g.qty }, { "单位", g.unit }, { "单价", g.price }, { "小计", Money(Subtotal(g)) }, { "货物技术指标", string.IsNullOrWhiteSpace(g.spec) ? g.name + "；型号：" + g.model + "。" : g.spec } }).ToList();
            var amounts = PaymentAmounts(d); var payments = d.payments.Select((p, i) => new Dictionary<string, string> { { "付款期数", (i + 1).ToString() }, { "付款条件", p.condition }, { "付款比例", p.ratio }, { "付款金额", Money(amounts[i]) } }).ToList();
            using (var input = new MemoryStream(template)) using (var source = new ZipArchive(input, ZipArchiveMode.Read)) using (var output = new MemoryStream())
            {
                using (var target = new ZipArchive(output, ZipArchiveMode.Create, true)) foreach (var entry in source.Entries)
                {
                    var newEntry = target.CreateEntry(entry.FullName, CompressionLevel.Optimal); using (var from = entry.Open()) using (var to = newEntry.Open())
                    {
                        if (IsPart(entry.FullName)) { var x = ReadXml(from); bool hasTokens = x.Descendants(W + "p").Any(p => Token.IsMatch(Text(p))); if (!hasTokens) { using (var again = entry.Open()) again.CopyTo(to); continue; } CloneRows(x, GoodKeys, goods, values); if (school) FillPaymentSlots(x, payments, values); else CloneRows(x, PayKeys, payments, values); ExpandTechnical(x, values["技术指标"]); ReplaceTokens(x, values); x.Save(to, SaveOptions.DisableFormatting); }
                        else from.CopyTo(to);
                    }
                }
                return output.ToArray();
            }
        }
    }
}
