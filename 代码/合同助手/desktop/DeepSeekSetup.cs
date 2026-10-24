// 本机接入助手：密钥只从不回显的标准输入接收，仅以Windows加密形式保存。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;

namespace ContractHelper
{
    static class DeepSeekSetup
    {
        static string ReadSecret()
        {
            if (Console.IsInputRedirected) return Console.ReadLine();
            var value = new StringBuilder();
            while (true) { var item = Console.ReadKey(true); if (item.Key == ConsoleKey.Enter) break; if (item.Key == ConsoleKey.Backspace) { if (value.Length > 0) value.Length--; } else if (!char.IsControl(item.KeyChar)) value.Append(item.KeyChar); }
            return value.ToString();
        }
        static int Main(string[] args)
        {
            var report = new Dictionary<string, object> { { "provider", "DeepSeek" }, { "savedEncrypted", false }, { "textConnection", false }, { "visionRecognition", false }, { "draftGeneration", false } };
            string folder = args.Length > 0 ? Path.GetFullPath(args[0]) : Directory.GetCurrentDirectory(); Directory.CreateDirectory(folder);
            Console.WriteLine("Waiting for API key through private input; input will not be echoed.");
            string secret = ReadSecret(); var settings = new ApiSettings { key = (secret ?? "").Trim() };
            try
            {
                settings.Validate(false); ApiStore.Save(settings, ApiStore.DefaultPath); if (ApiStore.Load(ApiStore.DefaultPath).key != settings.key) throw new Exception("加密保存校验失败。"); report["savedEncrypted"] = true;
                Console.WriteLine("Encrypted configuration saved. Checking official API...");
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                using (var http = new HttpClient())
                {
                    http.Timeout = TimeSpan.FromSeconds(40); http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", settings.key);
                    var response = http.GetAsync("https://api.deepseek.com/models").GetAwaiter().GetResult();
                    if (!response.IsSuccessStatusCode) throw new Exception("DeepSeek密钥验证失败，HTTP " + (int)response.StatusCode + "。");
                    var root = ContractEngine.Json().DeserializeObject(response.Content.ReadAsStringAsync().GetAwaiter().GetResult()) as Dictionary<string, object>;
                    var models = root == null || !root.ContainsKey("data") ? null : root["data"] as object[];
                    var names = models == null ? new string[0] : models.OfType<Dictionary<string, object>>().Where(m => m.ContainsKey("id")).Select(m => Convert.ToString(m["id"])).ToArray(); report["availableModels"] = names;
                    if (!names.Contains("deepseek-flash")) throw new Exception("当前账户模型列表未包含 deepseek-flash，需要核对账户可用模型。");
                }
                AiService.Complete(settings, "只回复：连接成功", "测试API连接，不包含任何合同资料。", false, CancellationToken.None).GetAwaiter().GetResult(); report["textConnection"] = true; Console.WriteLine("PASS: text connection.");
                using (var bitmap = new Bitmap(1000, 270))
                {
                    using (var g = Graphics.FromImage(bitmap)) using (var font = new Font("Microsoft YaHei UI", 20))
                    { g.Clear(Color.White); g.DrawString("产品名称       型号             数量   单位   单价(元)", font, Brushes.Black, 20, 18); g.DrawString("测试支架       TEST-A001          2      件      12.50", font, Brushes.Black, 20, 90); g.DrawString("测试接头       TEST-B002          3      件      20.00", font, Brushes.Black, 20, 160); }
                    using (var memory = new MemoryStream())
                    {
                        bitmap.Save(memory, ImageFormat.Png); var result = AiService.Recognize(settings, memory.ToArray(), CancellationToken.None).GetAwaiter().GetResult();
                        if (result.goods.Count != 2 || !result.goods.Any(g => g.model.Contains("TEST-A001") && g.qty == "2" && ContractEngine.Number(g.price, 2, "单价") == 12.5m) || !result.goods.Any(g => g.model.Contains("TEST-B002") && g.qty == "3" && ContractEngine.Number(g.price, 2, "单价") == 20m)) throw new Exception("接口可调用，但合成测试表格识别结果需要检查。");
                        report["visionRecognition"] = true; Console.WriteLine("PASS: screenshot recognition.");
                    }
                }
                var data = new ContractData(); data.fields["采购用途"] = "实验室通用部件采购"; data.goods.Add(new Good { name = "测试支架", model = "TEST-A001", qty = "2", unit = "件", price = "12.50", spec = "" });
                var draft = AiService.Draft(settings, data, CancellationToken.None).GetAwaiter().GetResult();
                if (string.IsNullOrWhiteSpace(draft.title) || string.IsNullOrWhiteSpace(draft.overview) || string.IsNullOrWhiteSpace(draft.technical)) throw new Exception("说明生成结果不完整。"); report["draftGeneration"] = true; Console.WriteLine("PASS: procurement draft generation.");
            }
            catch (Exception error) { string message = error.Message; if (!string.IsNullOrEmpty(settings.key)) message = message.Replace(settings.key, "[hidden]"); report["error"] = message; Console.WriteLine("Setup/test stopped: " + report["error"]); }
            report["model"] = settings.model; report["visionModel"] = settings.visionModel; report["baseUrl"] = settings.url;
            File.WriteAllText(Path.Combine(folder, "deepseek-live-check.json"), ContractEngine.Json().Serialize(report), Encoding.UTF8);
            secret = null; settings.key = null;
            return report.ContainsKey("error") ? 1 : 0;
        }
    }
}
