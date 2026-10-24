using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace ContractHelper
{
    public class PartyCandidate { public string field, value, quote; public int image; }
    public class GoodsEvidence { public int row, image; public string qty_quote, price_quote, price_kind, currency, currency_quote, tax_included; }
    public class BatchResult
    {
        public List<Good> goods = new List<Good>();
        public List<PartyCandidate> candidates = new List<PartyCandidate>();
        public List<string> warnings = new List<string>();
        public Dictionary<string, string> fields = new Dictionary<string, string>();
        public List<string> conflicts = new List<string>();
        public List<GoodsEvidence> evidence = new List<GoodsEvidence>();
    }
    public static class BatchImport
    {
        public static readonly string[] PartyKeys = { "乙方名称", "乙方代表", "乙方电话", "乙方地址" };
        public static byte[] Png(Image image)
        {
            if (image.Width > 14000 || image.Height > 14000 || (long)image.Width * image.Height > 45000000) throw new Exception("图片过大，请裁剪至需要识别的区域。");
            using (var bitmap = new Bitmap(image)) using (var memory = new MemoryStream()) { bitmap.Save(memory, ImageFormat.Png); if (memory.Length > 15 * 1024 * 1024) throw new Exception("单张图片请小于15MB。"); return memory.ToArray(); }
        }
        public static byte[] Load(string path) { if (new FileInfo(path).Length > 20L * 1024 * 1024) throw new Exception("单张图片请小于20MB。"); using (var image = Image.FromFile(path)) return Png(image); }
        static string Comparable(string value) { return Regex.Replace(value ?? "", @"[\s\-（）()：:]", ""); }
        static bool NumberQuoted(string quote, string value, int digits)
        {
            decimal expected; try { expected = ContractEngine.Number(value, digits, "识别数值"); } catch { return false; }
            foreach (Match m in Regex.Matches(quote ?? "", @"(?<![A-Za-z0-9.])\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9.])"))
            { decimal actual; if (decimal.TryParse(m.Value.Replace(",", ""), System.Globalization.NumberStyles.AllowDecimalPoint, System.Globalization.CultureInfo.InvariantCulture, out actual) && actual == expected) return true; }
            return false;
        }
        public static BatchResult Review(BatchResult result)
        {
            if (result == null || result.goods == null || result.candidates == null || result.goods.Count > 500 || result.candidates.Count > 500 || result.goods.Any(g => g == null) || result.candidates.Any(c => c == null)) throw new Exception("截图返回格式有误。");
            result.warnings = result.warnings ?? new List<string>(); result.fields = new Dictionary<string, string>(); result.conflicts = new List<string>(); result.evidence = result.evidence ?? new List<GoodsEvidence>();
            result.candidates = result.candidates.Where(c => PartyKeys.Contains(c.field) && !string.IsNullOrWhiteSpace(c.value)).ToList();
            foreach (var c in result.candidates.ToArray()) if (string.IsNullOrWhiteSpace(c.quote) || !Comparable(c.quote).Contains(Comparable(c.value))) { result.warnings.Add(c.field + "缺少可核对原文，未自动填入。"); result.candidates.Remove(c); }
            foreach (string key in PartyKeys)
            {
                var choices = result.candidates.Where(c => c.field == key).GroupBy(c => Comparable(c.value)).Select(g => g.First().value.Trim()).ToArray();
                if (choices.Length == 1) result.fields[key] = choices[0];
                if (choices.Length > 1) { result.conflicts.Add(key); result.warnings.Add(key + "在图片中有不同内容，已留空，请在下方选择或手动填写。"); }
            }
            for (int i = 0; i < result.goods.Count; i++)
            {
                var g = result.goods[i]; g.name = g.name ?? ""; g.model = g.model ?? ""; g.unit = g.unit ?? ""; g.spec = g.spec ?? "";
                try { if (ContractEngine.Number(g.qty, 4, "数量") <= 0) throw new Exception(); } catch { g.qty = ""; result.warnings.Add("第" + (i + 1) + "项数量不清楚，需核对。"); }
                try { ContractEngine.Number(g.price, 2, "单价"); } catch { g.price = ""; result.warnings.Add("第" + (i + 1) + "项单价不清楚，需核对。"); }
                var sources = result.evidence.Where(e => e != null && e.row == i + 1 && e.image > 0).ToArray(); var evidence = sources.Length == 1 ? sources[0] : null;
                if (!string.IsNullOrWhiteSpace(g.qty) && (evidence == null || !NumberQuoted(evidence.qty_quote, g.qty, 4))) { g.qty = ""; result.warnings.Add("第" + (i + 1) + "项数量缺少对应原文依据，已留空。"); }
                bool cny = evidence != null && evidence.currency == "CNY" && Regex.IsMatch(evidence.currency_quote ?? "", @"人民币|CNY|RMB|(?<![美日港澳欧])元", RegexOptions.IgnoreCase) && !Regex.IsMatch(evidence.currency_quote ?? "", @"美元|日元|港元|澳元|欧元|USD|JPY|HKD|AUD|EUR", RegexOptions.IgnoreCase);
                bool unitPrice = evidence != null && evidence.price_kind == "unit_price" && Regex.IsMatch(evidence.price_quote ?? "", @"单价|unit[\s_-]*price", RegexOptions.IgnoreCase) && NumberQuoted(evidence.price_quote, g.price, 2);
                if (!string.IsNullOrWhiteSpace(g.price) && (!unitPrice || !cny || evidence.tax_included == "no")) { g.price = ""; result.warnings.Add("第" + (i + 1) + "项单价列、对应数值、人民币币种或含税口径未确认，已留空；不倒推、不换汇、不加税。"); }
                else if (!string.IsNullOrWhiteSpace(g.price) && evidence.tax_included != "yes") result.warnings.Add("第" + (i + 1) + "项未明确是否含税，请对照报价确认后再用于含税单价。");
            }
            foreach (var group in result.goods.Where(g => !string.IsNullOrWhiteSpace(g.model)).GroupBy(g => Comparable(g.model))) if (group.Count() > 1) result.warnings.Add("型号“" + group.First().model + "”出现多次，请核对是否为重复截图；未自动合并数量。");
            result.warnings = result.warnings.Distinct().ToList(); return result;
        }
        public static async Task<BatchResult> Recognize(ApiSettings api, IList<byte[]> images, CancellationToken cancel, IProgress<string> progress = null)
        {
            if (images == null || images.Count == 0 || images.Count > 60 || images.Any(p => p == null || p.Length == 0 || p.Length > 15 * 1024 * 1024)) throw new Exception("请添加1至60张图片，单张不超过15MB。");
            string prompt = EmbeddedContent.Prompt("ocr-prompt.txt");
            var merged = new BatchResult(); int start = 0;
            while (start < images.Count)
            {
                var content = new List<object>(); long size = 0; int end = start;
                while (end < images.Count && end - start < 4 && (end == start || size + images[end].Length < 16 * 1024 * 1024)) { content.Add(new { type = "text", text = "图片编号 " + (end + 1) }); content.Add(new { type = "image_url", image_url = new { url = "data:image/png;base64," + Convert.ToBase64String(images[end]) } }); size += images[end].Length; end++; }
                if (progress != null) progress.Report("正在识别第" + (start + 1) + "至" + end + "张，共" + images.Count + "张…");
                string answer = await AiService.Complete(api, prompt, content.ToArray(), true, cancel, true).ConfigureAwait(false);
                int first = answer.IndexOf('{'), last = answer.LastIndexOf('}'); BatchResult part;
                try { part = ContractEngine.Json().Deserialize<BatchResult>(answer.Substring(first, last - first + 1)); } catch { throw new Exception("图片识别返回格式有误，尚未填入合同，请重试。"); }
                if (part == null || part.goods == null || part.candidates == null || part.warnings == null) throw new Exception("图片识别返回格式有误，尚未填入合同。");
                foreach (var c in part.candidates) if (c != null && (c.image < start + 1 || c.image > end)) c.quote = "";
                foreach (var e in part.evidence ?? new List<GoodsEvidence>()) if (e != null && e.row >= 1 && e.row <= part.goods.Count) { if (e.image < start + 1 || e.image > end) { e.qty_quote = e.price_quote = ""; } e.row += merged.goods.Count; merged.evidence.Add(e); }
                merged.goods.AddRange(part.goods); merged.candidates.AddRange(part.candidates); merged.warnings.AddRange(part.warnings); start = end;
            }
            return Review(merged);
        }
    }
}
