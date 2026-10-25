using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Xml.Linq;

namespace ContractHelper
{
    // Fully offline checks using synthetic resources; no UI, model or user home.
    public static class DesktopTests
    {
        static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        static void CheckLibraryUpdates(string folder, byte[] document)
        {
            string progress = Path.Combine(folder, "standalone.json");
            File.WriteAllText(progress, ContractEngine.Json().Serialize(ContractEngine.Sample()), Encoding.UTF8);
            var json = ContractLibrary.Import(progress, null, "generated"); string oldPath = json.path;
            var renamed = ContractLibrary.Update(json.id, "renamed-progress.json", null, null, null);
            Check(renamed.progress == renamed.path && File.Exists(renamed.progress) && !File.Exists(oldPath), "standalone JSON rename keeps resumable progress");
            Check(ContractLibrary.Get(json.id).progress == renamed.path, "standalone JSON rename persists progress");
            string docx = Path.Combine(folder, "paired.docx"); File.WriteAllBytes(docx, document);
            var pair = ContractLibrary.Import(docx, progress, "generated"); string companion = pair.progress;
            var pairRenamed = ContractLibrary.Update(pair.id, "renamed-document.docx", null, null, null);
            Check(pairRenamed.progress == companion && File.Exists(companion), "DOCX rename preserves independent progress JSON");

            string metadata = Path.Combine(Path.GetDirectoryName(renamed.path), "entry.json");
            // The old record deliberately has an already stale pointer and custom formatting.
            var stale = ContractLibrary.Get(json.id); stale.progress = Path.Combine(folder, "already-missing.json");
            File.WriteAllText(metadata, " \r\n" + ContractEngine.Json().Serialize(stale) + "\r\n", Encoding.UTF8);
            byte[] record = File.ReadAllBytes(metadata), contents = File.ReadAllBytes(stale.path); bool rejected = false;
            using (var locked = new FileStream(metadata, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                try { ContractLibrary.Update(json.id, "must-rollback.json", "do not persist", "template", null); } catch { rejected = true; }
            }
            Check(rejected && File.Exists(stale.path) && !File.Exists(Path.Combine(Path.GetDirectoryName(stale.path), "must-rollback.json")), "metadata failure rolls back file move");
            Check(File.ReadAllBytes(metadata).SequenceEqual(record) && File.ReadAllBytes(stale.path).SequenceEqual(contents), "rollback preserves exact old record including stale progress");

            string pairMetadata = Path.Combine(Path.GetDirectoryName(pairRenamed.path), "entry.json"), invalid = Path.Combine(folder, "invalid.docx");
            byte[] pairRecord = File.ReadAllBytes(pairMetadata), pairBytes = File.ReadAllBytes(pairRenamed.path); File.WriteAllText(invalid, "not a zip"); rejected = false;
            try { ContractLibrary.Update(pair.id, "invalid-rename.docx", null, null, null, invalid); } catch { rejected = true; }
            Check(rejected && File.Exists(pairRenamed.path) && File.ReadAllBytes(pairRenamed.path).SequenceEqual(pairBytes), "invalid replacement restores prior content and name");
            Check(File.ReadAllBytes(pairMetadata).SequenceEqual(pairRecord) && File.Exists(companion), "replacement rollback preserves metadata and companion");
        }
        public static void Run(string folder, string apiUrl)
        {
            Directory.CreateDirectory(folder);
            if (AppStorage.OverrideRoot == null) AppStorage.OverrideRoot = Path.Combine(Path.GetFullPath(folder), "data");
            try {
                var data = ContractEngine.Sample(); byte[] template = ContractEngine.Resource("template.docx");
                ContractEngine.ValidateTemplate(template); ContractEngine.ValidateData(data);
                Check(ContractEngine.Total(data) == 50.01m, "line rounding and total");
                Check(ContractEngine.ChineseMoney(50.01m) == "伍拾元零壹分", "Chinese money");
                var payments = ContractEngine.PaymentAmounts(data);
                Check(payments.SequenceEqual(new[] { 15m, 35.01m }), "payment rounding and remainder");
                byte[] result = ContractEngine.Build(data, template);
                using (var stream = new MemoryStream(result)) using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                using (var reader = new StreamReader(zip.GetEntry("word/document.xml").Open(), Encoding.UTF8)) {
                    var xml = XDocument.Parse(reader.ReadToEnd()); string text = ContractEngine.Text(xml.Root);
                    Check(!text.Contains("{{") && text.Contains("50.01") && text.Contains("DEMO-A") && text.Contains("DEMO-B"), "generated values and no unresolved tokens");
                    Check(xml.Descendants(ContractEngine.W + "tbl").All(t => t.Elements(ContractEngine.W + "tr").Count() == 3), "goods and payment rows cloned");
                }
                File.WriteAllBytes(Path.Combine(folder, "synthetic-contract.docx"), result);
                data.payments[1].ratio = "60"; bool rejected = false;
                try { ContractEngine.ValidateData(data); } catch { rejected = true; }
                Check(rejected, "invalid payment ratios rejected");
                EmbeddedContent.EnsureLibrary(); Check(ContractLibrary.Search("", "template").Count == 3, "synthetic library seed");
                Check(CommonInfoStore.DefaultPath.StartsWith(AppStorage.Root) && ApiStore.DefaultPath.StartsWith(AppStorage.Root), "data directory isolation");
                CheckLibraryUpdates(folder, result);
                File.WriteAllText(Path.Combine(folder, "desktop-test-results.json"), ContractEngine.Json().Serialize(new { passed = true, mode = "offline-synthetic", checks = 15, storageRoot = AppStorage.Root, libraryRenameAndRollback = true, uiTested = false, liveAiTested = false }), Encoding.UTF8);
            } catch (Exception e) {
                File.WriteAllText(Path.Combine(folder, "desktop-test-failed.txt"), e.ToString(), Encoding.UTF8); Environment.ExitCode = 1;
            }
        }
    }
}
