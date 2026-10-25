using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace ContractHelper
{
    public static class AppStorage
    {
        public static string OverrideRoot;
        public static string Root { get { return OverrideRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Xiaozhushou", "ContractHelper"); } }
        public static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    }
    public class LibraryEntry
    {
        public string id, name, path, imported, kind, text, progress;
        public string category, role, notes, template_id, reference_id, hash, trash_id, deleted_at;
    }
    public static class ContractLibrary
    {
        static readonly object Gate = new object();
        static string Folder { get { return Path.Combine(AppStorage.Root, "Library"); } }
        static LibraryEntry Read(string metadata)
        {
            var e = ContractEngine.Json().Deserialize<LibraryEntry>(File.ReadAllText(metadata, Encoding.UTF8));
            if (e == null) throw new Exception("资料记录无效。");
            if (string.IsNullOrWhiteSpace(e.category)) e.category = string.IsNullOrWhiteSpace(e.progress) ? "template" : "generated";
            if (string.IsNullOrWhiteSpace(e.role)) e.role = "reference";
            return e;
        }
        public static List<LibraryEntry> Search(string query, string category = "")
        {
            lock (Gate)
            {
                if (!Directory.Exists(Folder)) return new List<LibraryEntry>();
                var entries = new List<LibraryEntry>();
                foreach (string dir in Directory.GetDirectories(Folder))
                {
                    try { var e = Read(Path.Combine(dir, "entry.json")); if (File.Exists(e.path)) entries.Add(e); } catch { }
                }
                var terms = (query ?? "").Split(new[] { ' ', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                return entries.Where(e => (category == "" || e.category == category) && terms.All(t => ((e.name ?? "") + "\n" + (e.text ?? "") + "\n" + e.notes).IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0)).OrderByDescending(e => e.imported).ToList();
            }
        }
        public static LibraryEntry Get(string id) { var e = Search("").FirstOrDefault(v => v.id == id); if (e == null) throw new Exception("文件库中没有此记录。"); return e; }
        public static LibraryEntry Import(string path, string progress, string category = "", string role = "reference", string templateId = "", string referenceId = "")
        {
            return Store.Locked(() => {
                bool automaticCategory = category == "";
                path = Path.GetFullPath(path); var info = new FileInfo(path);
                string ext = info.Extension.ToLowerInvariant();
                if (!new[] { ".docx", ".pdf", ".json", ".png", ".jpg", ".jpeg", ".bmp" }.Contains(ext) || !info.Exists || info.Length > 50L * 1024 * 1024) throw new Exception("文件库支持50MB以内的Word、PDF、填写进度和截图。");
                if (category == "") category = string.IsNullOrWhiteSpace(progress) ? "template" : "generated";
                if (category != "generated" && category != "template") throw new Exception("文件库类别只能为generated或template。");
                if (role != "reference" && role != "fillable") throw new Exception("资料角色只能为reference或fillable。");
                byte[] bytes = File.ReadAllBytes(path); string digest = AppStorage.Hash(bytes);
                if (automaticCategory) { var prior = Search("").FirstOrDefault(e => e.hash == digest || e.id == digest); if (prior != null) return prior; }
                var existing = Search("").FirstOrDefault(e => (e.hash == digest || e.id == digest) && e.category == category);
                if (existing != null) { if (role == "fillable" && existing.role != "fillable") { ContractEngine.ValidateTemplate(ContractEngine.AdaptTemplate(bytes)); existing.role = "fillable"; Store.Write(Path.Combine(Store.Owned(Folder, existing.id), "entry.json"), ContractEngine.Json().Serialize(existing)); } return existing; }
                string id = Directory.Exists(Path.Combine(Folder, digest)) ? Guid.NewGuid().ToString("N") : digest;
                string folder = Store.Owned(Folder, id), metadata = Path.Combine(folder, "entry.json");
                if (role == "fillable") { if (ext != ".docx") throw new Exception("可生成模板必须为已适配的Word模板。"); ContractEngine.ValidateTemplate(ContractEngine.AdaptTemplate(bytes)); }
                Directory.CreateDirectory(folder); string copy = Path.Combine(folder, info.Name); File.WriteAllBytes(copy, bytes);
                var entry = new LibraryEntry { id = id, name = info.Name, path = copy, imported = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), kind = ext.TrimStart('.').ToUpperInvariant(), text = "", progress = "", category = category, role = role, template_id = templateId, reference_id = referenceId, hash = digest };
                if (ext == ".docx")
                {
                    using (var memory = new MemoryStream(bytes)) using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
                    {
                        var part = zip.GetEntry("word/document.xml"); if (part == null || part.Length > 20 * 1024 * 1024) throw new Exception("不是有效的Word文件。");
                        using (var stream = part.Open()) { XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"; var xml = XDocument.Load(stream); entry.text = string.Join("\r\n", xml.Descendants(w + "p").Select(p => string.Concat(p.Descendants(w + "t").Select(t => t.Value)))); }
                    }
                }
                else if (ext == ".json") { var data = ContractEngine.Json().Deserialize<ContractData>(Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF')); if (data == null || data.fields == null) throw new Exception("不是合同填写进度。"); entry.text = string.Join("\r\n", data.fields.Select(kv => kv.Key + "：" + kv.Value)) + "\r\n" + ContractEngine.Json().Serialize(data.goods); entry.progress = copy; }
                if (!string.IsNullOrWhiteSpace(progress) && File.Exists(progress)) { string dest = Path.Combine(folder, "填写进度.json"); File.Copy(progress, dest, true); entry.progress = dest; }
                if (entry.text.Length > 300000) entry.text = entry.text.Substring(0, 300000);
                Store.Write(metadata, ContractEngine.Json().Serialize(entry)); return entry;
            });
        }
        public static LibraryEntry Update(string id, string name, string notes, string category, string templateId, string replacement = null, string referenceId = null)
        {
            return Store.Locked(() => {
                var entry = Get(id); string folder = Store.Owned(Folder, entry.id);
                if (category != null) { if (category != "generated" && category != "template") throw new Exception("文件库类别无效。"); entry.category = category; }
                if (notes != null) entry.notes = notes;
                if (templateId != null) { if (templateId != "" && Get(templateId).category != "template") throw new Exception("参考项必须在模板库中。"); entry.template_id = templateId; }
                if (referenceId != null) { if (referenceId != "" && Get(referenceId).category != "template") throw new Exception("参考项必须在模板库中。"); entry.reference_id = referenceId; }
                string metadata = Path.Combine(folder, "entry.json"), oldPath = entry.path, destination = oldPath;
                byte[] oldMetadata = File.ReadAllBytes(metadata), oldContent = null;
                if (!string.IsNullOrWhiteSpace(name) && name != entry.name) {
                    if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.Length > 150 || name.Contains("..")) throw new Exception("文件名称无效。");
                    if (!name.EndsWith(Path.GetExtension(oldPath), StringComparison.OrdinalIgnoreCase)) name += Path.GetExtension(oldPath);
                    destination = Path.Combine(folder, name);
                }
                bool moved = false, replaced = false;
                try {
                if (!string.IsNullOrWhiteSpace(replacement)) {
                    var info = new FileInfo(replacement); if (!info.Exists || info.Length > 50L * 1024 * 1024 || info.Extension.ToUpperInvariant().TrimStart('.') != entry.kind) throw new Exception("替换文件须为同类型且不超过50MB。");
                    byte[] bytes = File.ReadAllBytes(replacement);
                    if (entry.role == "fillable") ContractEngine.ValidateTemplate(ContractEngine.AdaptTemplate(bytes));
                    oldContent = File.ReadAllBytes(entry.path);
                    Store.Write(Path.Combine(AppStorage.Root, "History", "Library", entry.id, DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + Path.GetExtension(entry.path)), oldContent);
                    Store.Write(entry.path, bytes);
                    replaced = true;
                }
                if (!string.IsNullOrWhiteSpace(name) && name != entry.name) {
                    if (!string.Equals(destination, oldPath, StringComparison.OrdinalIgnoreCase)) { File.Move(oldPath, destination); moved = true; }
                    // Only a standalone progress JSON points to the renamed file itself.
                    if (string.Equals(entry.progress, oldPath, StringComparison.OrdinalIgnoreCase)) entry.progress = destination;
                    entry.name = name; entry.path = destination;
                }
                string currentHash = AppStorage.Hash(File.ReadAllBytes(entry.path));
                if (currentHash != (string.IsNullOrWhiteSpace(entry.hash) ? entry.id : entry.hash) && entry.kind == "DOCX") { entry.progress = ""; entry.notes = (entry.notes ?? "") + " 文档已编辑，旧填写进度未同步；请按Word核对。"; }
                entry.hash = currentHash;
                if (entry.kind == "DOCX") using (var zip = ZipFile.OpenRead(entry.path)) { var part = zip.GetEntry("word/document.xml"); using (var input = part.Open()) { XNamespace w = ContractEngine.W; var xml = XDocument.Load(input); entry.text = string.Join("\r\n", xml.Descendants(w + "p").Select(p => ContractEngine.Text(p))); } }
                Store.Write(metadata, ContractEngine.Json().Serialize(entry)); return entry;
                } catch (Exception updateError) {
                    try {
                        if (moved) File.Move(destination, oldPath);
                        if (replaced) Store.Write(oldPath, oldContent);
                        // Preserve the exact prior record, including any already stale progress pointer.
                        if (!File.ReadAllBytes(metadata).SequenceEqual(oldMetadata)) Store.Write(metadata, oldMetadata);
                    } catch (Exception rollbackError) { throw new AggregateException("文件库更新失败，恢复原记录时也遇到问题，请核对原文件。", updateError, rollbackError); }
                    throw;
                }
            });
        }
        public static void Delete(string id)
        {
            Store.Locked(() => {
                var entry = Get(id); string folder = Store.Owned(Folder, entry.id); entry.trash_id = Guid.NewGuid().ToString("N"); entry.deleted_at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                string dest = Store.Owned(Path.Combine(AppStorage.Root, "Trash", "Library"), entry.trash_id); Directory.CreateDirectory(Path.GetDirectoryName(dest));
                Store.Write(Path.Combine(folder, "entry.json"), ContractEngine.Json().Serialize(entry)); Directory.Move(folder, dest); return true;
            });
        }
        public static List<LibraryEntry> Trash()
        {
            string folder = Path.Combine(AppStorage.Root, "Trash", "Library"); var rows = new List<LibraryEntry>();
            if (Directory.Exists(folder)) foreach (string path in Directory.GetDirectories(folder)) try { rows.Add(Read(Path.Combine(path, "entry.json"))); } catch { }
            return rows.OrderByDescending(e => e.deleted_at).ToList();
        }
        public static LibraryEntry Restore(string trashId)
        {
            return Store.Locked(() => {
                string source = Store.Owned(Path.Combine(AppStorage.Root, "Trash", "Library"), trashId); var e = Read(Path.Combine(source, "entry.json"));
                string dest = Store.Owned(Folder, e.id); if (Directory.Exists(dest)) { e.id = Guid.NewGuid().ToString("N"); dest = Store.Owned(Folder, e.id); }
                Directory.CreateDirectory(Folder); Directory.Move(source, dest); e.path = Path.Combine(dest, Path.GetFileName(e.path));
                if (!string.IsNullOrWhiteSpace(e.progress)) e.progress = Path.Combine(dest, Path.GetFileName(e.progress)); e.trash_id = e.deleted_at = null;
                Store.Write(Path.Combine(dest, "entry.json"), ContractEngine.Json().Serialize(e)); return e;
            });
        }
        public static void Open(string id) { var e = Get(id); Process.Start(new ProcessStartInfo(e.path) { UseShellExecute = true }); }
        public static LibraryEntry ReadCurrent(string id)
        {
            var e = Get(id); string hash = AppStorage.Hash(File.ReadAllBytes(e.path));
            if (hash != (string.IsNullOrWhiteSpace(e.hash) ? e.id : e.hash)) {
                e.progress = ""; e.notes = (e.notes ?? "") + " 文档已编辑，旧进度未同步；请按Word核对。";
                if (e.kind == "DOCX") using (var zip = ZipFile.OpenRead(e.path)) using (var input = zip.GetEntry("word/document.xml").Open()) { var xml = XDocument.Load(input); e.text = string.Join("\r\n", xml.Descendants(ContractEngine.W + "p").Select(p => ContractEngine.Text(p))); }
            }
            return e;
        }
    }
}
