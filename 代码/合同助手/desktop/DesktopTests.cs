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
                File.WriteAllText(Path.Combine(folder, "desktop-test-results.json"), ContractEngine.Json().Serialize(new { passed = true, mode = "offline-synthetic", checks = 8, storageRoot = AppStorage.Root, uiTested = false, liveAiTested = false }), Encoding.UTF8);
            } catch (Exception e) {
                File.WriteAllText(Path.Combine(folder, "desktop-test-failed.txt"), e.ToString(), Encoding.UTF8); Environment.ExitCode = 1;
            }
        }
    }
}
