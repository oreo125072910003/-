using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace ContractHelper
{
    public class MaterialRecord
    {
        public string id, name, brand, category, status, notes, updated_at;
        public string model, source, checked_at, page_hash, specification;
        public Dictionary<string, string> facts = new Dictionary<string, string>();
        public List<MaterialEvidence> evidence = new List<MaterialEvidence>();
    }
    public class MaterialEvidence { public string source, location, status, specification, date; }
    public static class MaterialCatalog
    {
        static string Folder { get { return Path.Combine(AppStorage.Root, "Materials"); } }
        public static string Normalize(string model) { string value = Regex.Replace((model ?? "").Trim().ToUpperInvariant(), @"^(?:麓邦\s*|LBTEK\s+)", ""); return Regex.Replace(value, @"\s+", ""); }
        static string Brand(string brand) { return string.Equals((brand ?? "").Trim(), "LBTEK", StringComparison.OrdinalIgnoreCase) ? "麓邦" : (brand ?? "").Trim(); }
        static string Id(string model) { return AppStorage.Hash(Encoding.UTF8.GetBytes(Normalize(model))); }
        static string Plain(string html) { return WebUtility.HtmlDecode(Regex.Replace(html, "<[^>]+>", " ")).Replace("\u00a0", " ").Trim(); }
        public static List<MaterialRecord> List()
        {
            return Store.Locked(() => ReadRecords());
        }
        static List<MaterialRecord> ReadRecords()
        {
            var result = new List<MaterialRecord>(); if (!Directory.Exists(Folder)) return result;
            foreach (string file in Directory.GetFiles(Folder, "*.json")) try { var r = ContractEngine.Json().Deserialize<MaterialRecord>(File.ReadAllText(file, Encoding.UTF8)); if (r != null && !string.IsNullOrWhiteSpace(r.model)) {
                r.id = Path.GetFileNameWithoutExtension(file); r.facts = r.facts ?? new Dictionary<string, string>(); r.evidence = r.evidence ?? new List<MaterialEvidence>();
                if (string.IsNullOrWhiteSpace(r.brand)) r.brand = (r.source ?? "").Contains("lbtek.com") ? "麓邦" : (r.source ?? "").Contains("thorlabs.") ? "Thorlabs" : "未分类";
                if (string.IsNullOrWhiteSpace(r.status)) r.status = ((r.source ?? "").StartsWith("https://www.lbtek.com/") || (r.source ?? "").StartsWith("https://www.thorlabs.")) && r.facts.Count > 0 && (r.page_hash ?? "").Length == 64 ? "官网核验" : "来源待核对";
                if (string.IsNullOrWhiteSpace(r.category)) r.category = "未分类";
                result.Add(r);
            } } catch { }
            return result.OrderBy(r => r.brand).ThenBy(r => r.model).ToList();
        }
        public static List<MaterialRecord> Search(string query, string brand = "", string category = "", bool exact = false)
        {
            var words = (query ?? "").Split(new[] { ' ', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            return List().Where(r => (brand == "" || string.Equals(Brand(r.brand), Brand(brand), StringComparison.OrdinalIgnoreCase)) && (category == "" || r.category == category) &&
                (exact ? Normalize(r.model) == Normalize(query) : words.All(t => ((r.model ?? "") + " " + r.name + " " + r.brand + " " + r.category + " " + r.specification).IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0))).ToList();
        }
        public static MaterialRecord Cached(string model, string brand = "")
        {
            var rows = Search(model, brand ?? "", "", true);
            if (rows.Count > 1) throw new Exception(model + "在多个品牌下存在，请指定品牌后调用，不自动套用参数。");
            return rows.FirstOrDefault();
        }
        public static MaterialRecord GetRecord(string id) { return List().FirstOrDefault(r => r.id == id) ?? throwMissing(); }
        static MaterialRecord throwMissing() { throw new Exception("型号库中没有此记录。"); }
        public static MaterialRecord Save(MaterialRecord r, bool manual = true)
        {
            return Store.Locked(() => {
                if (r == null || string.IsNullOrWhiteSpace(r.model) || string.IsNullOrWhiteSpace(r.specification)) throw new Exception("请填写完整型号和参数描述。");
                r.model = r.model.Trim(); r.brand = string.IsNullOrWhiteSpace(r.brand) ? "未分类" : Brand(r.brand); r.category = string.IsNullOrWhiteSpace(r.category) ? "未分类" : r.category.Trim();
                if (r.model.Length > 160 || r.specification.Length > 12000 || (r.name ?? "").Length > 300 || r.brand.Length > 100 || r.category.Length > 100) throw new Exception("型号或描述过长。");
                if (List().Any(v => v.id != r.id && Normalize(v.model) == Normalize(r.model) && string.Equals(v.brand, r.brand, StringComparison.OrdinalIgnoreCase))) throw new Exception("此品牌下已有相同型号，请编辑原记录或核对品牌。");
                if (string.IsNullOrWhiteSpace(r.id)) r.id = AppStorage.Hash(Encoding.UTF8.GetBytes(Brand(r.brand).ToUpperInvariant() + "|" + Normalize(r.model)));
                string file = Store.Owned(Folder, r.id) + ".json";
                if (File.Exists(file)) { string history = Path.Combine(AppStorage.Root, "History", "Materials", r.id, DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + ".json"); Store.Write(history, File.ReadAllBytes(file)); }
                r.evidence = r.evidence ?? new List<MaterialEvidence>(); r.facts = r.facts ?? new Dictionary<string, string>();
                if (manual) { r.status = "用户录入"; r.facts.Clear(); }
                r.updated_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                Store.Write(file, ContractEngine.Json().Serialize(r)); return r;
            });
        }
        public static MaterialRecord ImportRecord(MaterialRecord record)
        {
            return Store.Locked(() => {
                var old = Cached(record.model, record.brand);
                if (old == null) return Save(record, false);
                var evidence = record.evidence ?? new List<MaterialEvidence>();
                foreach (var e in evidence) if (!old.evidence.Any(v => v.source == e.source && v.location == e.location && v.specification == e.specification)) old.evidence.Add(e);
                if (string.IsNullOrWhiteSpace(old.name)) old.name = record.name;
                if (old.category == "未分类" || string.IsNullOrWhiteSpace(old.category)) old.category = record.category;
                if (old.specification != record.specification && !string.IsNullOrWhiteSpace(record.specification)) old.notes = "有其他来源描述，请在来源记录中对照；未自动覆盖当前参数。";
                return Save(old, false);
            });
        }
        public static void Delete(string id)
        {
            Store.Locked(() => { var r = GetRecord(id); string path = Store.Owned(Folder, r.id) + ".json"; string target = Path.Combine(AppStorage.Root, "Trash", "Materials", r.id + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + ".json"); Directory.CreateDirectory(Path.GetDirectoryName(target)); File.Move(path, target); return true; });
        }
        public static void EnsureSeed()
        {
            Store.Locked(() => {
                string marker = Path.Combine(AppStorage.Root, "seed-materials-2.3.done");
                var records = ContractEngine.Json().Deserialize<List<MaterialRecord>>(Encoding.UTF8.GetString(ContractEngine.Resource("materials-seed.json")));
                RepairSeedDuplicates(records);
                if (File.Exists(marker)) return true;
                foreach (var record in records) {
                    Func<string, string> sourcePath = s => s == "builtin:purchase.xlsx" ? Path.Combine(AppStorage.Root, "Builtin", "麓邦采购清单.xlsx") : s == "builtin:example-129300.docx" ? Path.Combine(AppStorage.Root, "Builtin", "东方中科参考范例_12.93万.docx") : s == "builtin:example-161000.docx" ? Path.Combine(AppStorage.Root, "Builtin", "东方中科参考范例_16.1万.docx") : s;
                    record.source = sourcePath(record.source); foreach (var e in record.evidence) e.source = sourcePath(e.source); ImportRecord(record);
                }
                Store.Write(marker, "2.3"); return true;
            });
        }
        static void RepairSeedDuplicates(List<MaterialRecord> seed)
        {
            var keys = new HashSet<string>(seed.Select(r => Brand(r.brand).ToUpperInvariant() + "|" + Normalize(r.model)));
            string builtin = Path.GetFullPath(Path.Combine(AppStorage.Root, "Builtin")) + Path.DirectorySeparatorChar;
            Func<MaterialRecord, bool> ours = r => r.status != "用户录入" && (r.evidence ?? new List<MaterialEvidence>()).Any(e => (e.source ?? "").StartsWith(builtin, StringComparison.OrdinalIgnoreCase));
            foreach (var group in List().GroupBy(r => Brand(r.brand).ToUpperInvariant() + "|" + Normalize(r.model)).Where(g => g.Count() > 1 && keys.Contains(g.Key))) {
                var rows = group.ToList(); if (!rows.All(ours)) continue;
                var official = rows.Where(r => r.status == "官网核验").ToList();
                if (official.Count > 1 || official.Count == 0 && rows.Select(r => r.specification).Distinct().Count() != 1) continue;
                var keep = official.Count == 1 ? official[0] : rows.OrderBy(r => r.id).First();
                foreach (var other in rows.Where(r => r.id != keep.id)) {
                    var evidence = (other.evidence ?? new List<MaterialEvidence>()).Concat(new[] { new MaterialEvidence { source = other.source, status = other.status, specification = other.specification, date = other.checked_at, location = "升级去重保留" } });
                    foreach (var e in evidence) if (!keep.evidence.Any(v => v.source == e.source && v.location == e.location && v.specification == e.specification)) keep.evidence.Add(e);
                    Delete(other.id);
                }
                Save(keep, false);
            }
            foreach (var r in List().Where(r => Normalize(r.model) == "MC2000B-EC" && r.category == "偏振光学" && ours(r))) { r.category = "调制器件"; Save(r, false); }
        }
        public static MaterialRecord ParseExactRow(string model, string html, string source)
        {
            var matched = new List<MaterialRecord>();
            foreach (Match table in Regex.Matches(html, @"<table\b[^>]*>([\s\S]*?)</table>", RegexOptions.IgnoreCase))
            {
                List<string> headers = null;
                foreach (Match row in Regex.Matches(table.Value, @"<tr\b[^>]*>([\s\S]*?)</tr>", RegexOptions.IgnoreCase))
                {
                    var cells = Regex.Matches(row.Value, @"<t[dh]\b[^>]*>([\s\S]*?)</t[dh]>", RegexOptions.IgnoreCase).Cast<Match>().Select(c => Regex.Replace(Plain(c.Groups[1].Value), @"\s+", " ")).ToList();
                    if (cells.Any(c => c == "产品型号" || c == "型号")) { headers = cells; continue; }
                    if (headers == null || cells.Count != headers.Count || !cells.Any(c => Normalize(c) == Normalize(model))) continue;
                    var record = new MaterialRecord { model = model, brand = "麓邦", status = "官网核验", source = source, checked_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), page_hash = AppStorage.Hash(Encoding.UTF8.GetBytes(html)) };
                    for (int i = 0; i < cells.Count; i++) if (!string.IsNullOrWhiteSpace(headers[i]) && !Regex.IsMatch(headers[i], "型号|单价|价格|发货|对比|库存|购物|数量|下载") && !string.IsNullOrWhiteSpace(cells[i])) record.facts[headers[i]] = cells[i];
                    if (record.facts.Count > 0) { record.specification = string.Join("；", record.facts.Select(kv => kv.Key + "：" + kv.Value)); matched.Add(record); }
                }
            }
            if (matched.Count == 0) return null;
            if (matched.Select(r => r.specification).Distinct().Count() > 1) throw new Exception("官网出现多个不同的型号参数行，需人工核对。");
            return matched[0];
        }
        static async Task<string> Get(HttpClient client, string url, CancellationToken cancel)
        {
            using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode(); if (response.Content.Headers.ContentLength > 8 * 1024 * 1024) throw new Exception("网页过大。");
                using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false)) using (var output = new MemoryStream())
                { byte[] buffer = new byte[16384]; int count; while ((count = await input.ReadAsync(buffer, 0, buffer.Length, cancel).ConfigureAwait(false)) > 0) { output.Write(buffer, 0, count); if (output.Length > 8 * 1024 * 1024) throw new Exception("网页过大。"); } return Encoding.UTF8.GetString(output.ToArray()); }
            }
        }
        public static async Task<MaterialRecord> Lookup(string model, bool refresh, string source, CancellationToken cancel, string brand = "")
        {
            if (string.IsNullOrWhiteSpace(model)) throw new Exception("请先填写品牌型号。");
            var cached = Cached(model, brand); if (cached != null && !refresh && string.IsNullOrWhiteSpace(source)) return cached;
            if (brand != "" && brand != "麓邦" && !brand.Equals("LBTEK", StringComparison.OrdinalIgnoreCase)) throw new Exception("此品牌目前支持资料库读取与手工维护，自动官网核验暂支持麓邦。");
            var urls = new List<string>();
            if (!string.IsNullOrWhiteSpace(source)) { Uri uri; if (!Uri.TryCreate(source, UriKind.Absolute, out uri) || uri.Scheme != "https" || !new[] { "www.lbtek.com", "lbtek.com", "en.lbtek.com" }.Contains(uri.Host.ToLowerInvariant()) || !string.IsNullOrEmpty(uri.UserInfo)) throw new Exception("目前自动核验支持麓邦官网HTTPS产品页；其他品牌请据原始资料手动填写。"); urls.Add(source); }
            var known = new Dictionary<string, string> { { "PBS632", "90" }, { "PMC780-APC-2", "471" }, { "BS1355-B", "432" } };
            string product; if (known.TryGetValue(Normalize(model), out product)) urls.Add("https://www.lbtek.com/product/" + product);
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            using (var handler = new HttpClientHandler { AllowAutoRedirect = false }) using (var client = new HttpClient(handler))
            {
                client.Timeout = TimeSpan.FromSeconds(25); client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 ContractHelper/2.0");
                if (urls.Count == 0)
                {
                    try { string search = await Get(client, "https://www.lbtek.com/search?search=" + Uri.EscapeDataString(Normalize(model)), cancel).ConfigureAwait(false); urls.AddRange(Regex.Matches(search, @"href=""(/product/[0-9]+(?:[?#][^""]*)?)""", RegexOptions.IgnoreCase).Cast<Match>().Select(m => "https://www.lbtek.com" + WebUtility.HtmlDecode(m.Groups[1].Value)).Distinct().OrderByDescending(u => u.IndexOf(Normalize(model), StringComparison.OrdinalIgnoreCase) >= 0).Take(6)); } catch (OperationCanceledException) { throw; } catch { }
                }
                if (urls.Count == 0)
                {
                    try { string rss = await Get(client, "https://www.bing.com/search?format=rss&q=" + Uri.EscapeDataString("site:lbtek.com/product/ \"" + Normalize(model) + "\""), cancel).ConfigureAwait(false); var xml = XDocument.Parse(rss); urls.AddRange(xml.Descendants("link").Select(n => n.Value).Where(u => Regex.IsMatch(u, @"^https://(www\.)?lbtek\.com/product/[0-9]+(?:[/?]|$)")).Distinct().Take(6)); } catch (OperationCanceledException) { throw; } catch { }
                }
                foreach (string url in urls.Distinct())
                {
                    cancel.ThrowIfCancellationRequested(); string html;
                    try { html = await Get(client, url, cancel).ConfigureAwait(false); } catch (OperationCanceledException) { throw; } catch { continue; }
                    var record = ParseExactRow(model, html, url); if (record == null) continue;
                    record.evidence.Add(new MaterialEvidence { source = url, status = "官网核验", specification = record.specification, date = record.checked_at });
                    var old = Cached(model, "麓邦"); if (old != null && old.status == "用户录入") { ImportRecord(record); return old; }
                    if (old != null) { record.id = old.id; record.name = old.name; record.category = old.category; record.evidence.AddRange(old.evidence); }
                    Save(record, false); Store.Write(Store.Owned(Folder, record.id) + ".html", html); return record;
                }
            }
            throw new Exception(model + "：未找到官网中与此型号完全一致的参数行，未填入或归档未经核验的参数。");
        }
        public static string Technical(ContractData data)
        {
            return string.Join("\r\n", Resolve(data).Select(r => r.model + "：" + r.specification));
        }
        public static List<MaterialRecord> Resolve(ContractData data)
        {
            return data.goods.Select(g => {
                if (!string.IsNullOrWhiteSpace(g.spec)) return new MaterialRecord { model = g.model, brand = g.brand, name = g.name, specification = g.spec.Trim(), status = "本次填写", source = "本次采购资料" };
                MaterialRecord record = null; try { record = Cached(g.model, g.brand ?? ""); } catch { }
                return record ?? new MaterialRecord { model = g.model, brand = g.brand, name = g.name, specification = "", status = "待补充", notes = "未找到唯一精确型号资料，不使用相近型号。" };
            }).ToList();
        }
    }
}
