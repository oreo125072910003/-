using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace ContractHelper
{
    public static class MaterialImport
    {
        static readonly XNamespace S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        static XDocument Xml(ZipArchiveEntry entry)
        {
            if (entry == null || entry.Length > 30 * 1024 * 1024) throw new Exception("Excel结构缺失或过大。");
            using (var input = entry.Open()) using (var reader = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 30 * 1024 * 1024 })) return XDocument.Load(reader);
        }
        public static string Classify(string description)
        {
            if (Regex.IsMatch(description, "声光|斩波")) return "调制器件";
            if (Regex.IsMatch(description, "光纤|准直器")) return "光纤与耦合";
            if (Regex.IsMatch(description, "波片|偏振|格兰|隔离器")) return "偏振光学";
            if (Regex.IsMatch(description, "探测器|功率计|检测卡|光束质量")) return "光电探测";
            if (Regex.IsMatch(description, "反射镜|分束|滤光片|透镜|针孔")) return "光学元件";
            return "光机械及附件";
        }
        public static List<MaterialRecord> ReadWorkbook(string path, string brand)
        {
            var info = new FileInfo(path); if (!info.Exists || info.Extension.ToLowerInvariant() != ".xlsx" || info.Length > 30L * 1024 * 1024) throw new Exception("请选择30MB以内的.xlsx采购清单。");
            var result = new List<MaterialRecord>();
            using (var zip = ZipFile.OpenRead(path))
            {
                var shared = new List<string>(); var sharedPart = zip.GetEntry("xl/sharedStrings.xml");
                if (sharedPart != null) shared = Xml(sharedPart).Descendants(S + "si").Select(e => string.Concat(e.Descendants(S + "t").Select(t => t.Value))).ToList();
                XNamespace rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
                var relationships = Xml(zip.GetEntry("xl/_rels/workbook.xml.rels")).Root.Elements().ToDictionary(e => (string)e.Attribute("Id"), e => (string)e.Attribute("Target"));
                foreach (var sheet in Xml(zip.GetEntry("xl/workbook.xml")).Descendants(S + "sheet"))
                {
                    string target = relationships[(string)sheet.Attribute(rel + "id")].Replace('\\', '/');
                    string zipPath = target.StartsWith("/") ? target.TrimStart('/') : "xl/" + target;
                    var rows = Xml(zip.GetEntry(zipPath)).Descendants(S + "row"); string modelCol = null, descriptionCol = null;
                    foreach (var row in rows)
                    {
                        var cells = new Dictionary<string, string>();
                        foreach (var c in row.Elements(S + "c")) {
                            string coordinate = (string)c.Attribute("r"), type = (string)c.Attribute("t"), value = (string)c.Element(S + "v") ?? "";
                            if (coordinate == null) continue;
                            if (type == "s") { int n; value = int.TryParse(value, out n) && n >= 0 && n < shared.Count ? shared[n] : ""; }
                            else if (type == "inlineStr") value = string.Concat(c.Descendants(S + "t").Select(t => t.Value));
                            cells[Regex.Replace(coordinate, "[0-9]", "")] = value.Trim();
                        }
                        foreach (var c in cells) { if (c.Value == "商品型号" || c.Value == "品牌型号" || c.Value == "型号") modelCol = c.Key; if (c.Value == "商品信息" || c.Value == "参数描述" || c.Value == "技术参数") descriptionCol = c.Key; }
                        if (modelCol == null || descriptionCol == null || !cells.ContainsKey(modelCol) || !cells.ContainsKey(descriptionCol)) continue;
                        string model = cells[modelCol], description = cells[descriptionCol];
                        if (model == "商品型号" || model == "型号" || model == "品牌型号" || model.Length == 0 || description.Length == 0) continue;
                        string location = (string)sheet.Attribute("name") + "!" + modelCol + (string)row.Attribute("r") + "/" + descriptionCol + (string)row.Attribute("r");
                        string rowBrand = description.Contains("EIGHT生产") ? "EIGHT" : string.IsNullOrWhiteSpace(brand) ? "未分类" : brand.Trim();
                        var r = new MaterialRecord { model = model, name = Regex.Split(description, "[，,；;]")[0], brand = rowBrand, category = Classify(description), specification = description, source = Path.GetFileName(path), status = "用户清单", checked_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") };
                        r.evidence.Add(new MaterialEvidence { source = Path.GetFileName(path), location = location, specification = description, status = "用户清单", date = r.checked_at }); result.Add(r);
                        if (result.Count > 10000) throw new Exception("一次最多导入10000行型号资料。");
                    }
                }
            }
            if (result.Count == 0) throw new Exception("未找到“商品型号”和“商品信息”列。也支持“型号”和“技术参数/参数描述”列。");
            return result;
        }
        public static object ImportWorkbook(string path, string brand)
        {
            var rows = ReadWorkbook(path, brand); byte[] bytes = File.ReadAllBytes(path);
            string copy = Path.Combine(AppStorage.Root, "MaterialSources", AppStorage.Hash(bytes), Path.GetFileName(path)); Store.Write(copy, bytes);
            int added = 0, merged = 0; var conflicts = new List<string>();
            foreach (var r in rows) {
                r.source = copy; foreach (var e in r.evidence) e.source = copy;
                var old = MaterialCatalog.Cached(r.model, r.brand);
                if (old == null) added++; else { merged++; if (old.specification != r.specification) conflicts.Add(r.model); }
                MaterialCatalog.ImportRecord(r);
            }
            return new { source = copy, source_rows = rows.Count, unique_models = rows.Select(r => r.brand + "|" + MaterialCatalog.Normalize(r.model)).Distinct().Count(), added, merged, conflicting_models = conflicts.Distinct().ToArray(), note = "保留型号和参数原文，不导入历史数量、单价、折扣或库存；不同来源描述另存依据，不自动覆盖。" };
        }
    }
}
