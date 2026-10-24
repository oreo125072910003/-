using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace ContractHelper
{
    public class ApiSettings
    {
        public string url { get; set; }
        public string model { get; set; }
        public string visionModel { get; set; }
        public string key { get; set; }
        public string protectedKey { get; set; }
        public ApiSettings() { url = "https://api.deepseek.com"; model = "deepseek-flash"; visionModel = "deepseek-flash"; key = ""; }
        public bool IsDeepSeek { get { Uri uri; return Uri.TryCreate(url, UriKind.Absolute, out uri) && string.Equals(uri.Host, "api.deepseek.com", StringComparison.OrdinalIgnoreCase); } }
        public string Endpoint()
        {
            Uri uri; if (!Uri.TryCreate((url ?? "").Trim(), UriKind.Absolute, out uri) || (uri.Scheme != "https" && uri.Scheme != "http") || !string.IsNullOrEmpty(uri.UserInfo)) throw new Exception("请填写有效的 API 地址，例如 https://服务商地址/v1。");
            string value = uri.AbsoluteUri.TrimEnd('/'); return value.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase) ? value : value + "/chat/completions";
        }
        public void Validate(bool vision)
        {
            Endpoint(); if (string.IsNullOrWhiteSpace(vision && !string.IsNullOrWhiteSpace(visionModel) ? visionModel : model)) throw new Exception("请先在 API 设置中填写模型名称。识别截图需要支持图片输入的模型。");
            if (IsDeepSeek && string.IsNullOrWhiteSpace(key)) throw new Exception("请先在API设置中填写DeepSeek API Key。");
            if (IsDeepSeek && vision && (string.IsNullOrWhiteSpace(visionModel) ? model : visionModel) == "deepseek-v4-pro") throw new Exception("DeepSeek截图识别请使用 deepseek-flash 模型。");
        }
    }
    public static class ApiStore
    {
        public static string DefaultPath { get { return Path.Combine(AppStorage.Root, "api.json"); } }
        public static ApiSettings Load(string path)
        {
            if (!File.Exists(path)) return new ApiSettings(); var s = ContractEngine.Json().Deserialize<ApiSettings>(File.ReadAllText(path, Encoding.UTF8));
            s.key = string.IsNullOrEmpty(s.protectedKey) ? "" : Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(s.protectedKey), null, DataProtectionScope.CurrentUser)); return s;
        }
        public static void Save(ApiSettings settings, string path)
        {
            var stored = new ApiSettings { url = settings.url, model = settings.model, visionModel = settings.visionModel, key = null, protectedKey = string.IsNullOrEmpty(settings.key) ? null : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(settings.key), null, DataProtectionScope.CurrentUser)) };
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))); File.WriteAllText(path, ContractEngine.Json().Serialize(stored), Encoding.UTF8);
        }
    }
    public class OcrResult { public List<Good> goods { get; set; } public List<string> warnings { get; set; } public List<GoodsEvidence> evidence { get; set; } }
    public class DraftResult { public string title { get; set; } public string overview { get; set; } public string technical { get; set; } public string warning { get; set; } public List<MaterialRecord> specifications { get; set; } }
    public static class AiService
    {
        public static Dictionary<string, object> BuildPayload(ApiSettings settings, string instruction, object content, bool vision, bool jsonOutput)
        {
            settings.Validate(vision); string model = vision && !string.IsNullOrWhiteSpace(settings.visionModel) ? settings.visionModel : settings.model;
            var payload = new Dictionary<string, object> { { "model", model.Trim() }, { "stream", false }, { "messages", new object[] { new { role = "system", content = (object)instruction }, new { role = "user", content = content } } } };
            if (settings.IsDeepSeek) { payload["thinking"] = new { type = "disabled" }; payload["max_tokens"] = vision ? 8192 : 4096; if (jsonOutput) payload["response_format"] = new { type = "json_object" }; }
            return payload;
        }
        static string CleanJson(string value)
        {
            int first = (value ?? "").IndexOf('{'), last = (value ?? "").LastIndexOf('}'); if (first < 0 || last <= first) throw new Exception("模型没有返回可解析的数据，请重试或更换模型。"); return value.Substring(first, last - first + 1);
        }
        public static async Task<string> Complete(ApiSettings settings, string instruction, object content, bool vision, CancellationToken cancel, bool jsonOutput = false)
        {
            string body = ContractEngine.Json().Serialize(BuildPayload(settings, instruction, content, vision, jsonOutput));
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            using (var overall = CancellationTokenSource.CreateLinkedTokenSource(cancel))
            using (var handler = new HttpClientHandler { AllowAutoRedirect = false }) using (var http = new HttpClient(handler))
            {
                overall.CancelAfter(150000); http.Timeout = TimeSpan.FromSeconds(60); http.MaxResponseContentBufferSize = 4 * 1024 * 1024;
                if (!string.IsNullOrWhiteSpace(settings.key)) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", settings.key.Trim());
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    int delay = attempt == 0 ? 1500 : 3500;
                    try
                    {
                        using (var request = new StringContent(body, Encoding.UTF8, "application/json")) using (var response = await http.PostAsync(settings.Endpoint(), request, overall.Token).ConfigureAwait(false))
                        {
                            if (!response.IsSuccessStatusCode)
                            {
                                int code = (int)response.StatusCode;
                                if ((code == 429 || code == 500 || code == 502 || code == 503 || code == 504) && attempt < 2) {
                                    if (response.Headers.RetryAfter != null && response.Headers.RetryAfter.Delta.HasValue) delay = (int)Math.Min(10000, Math.Max(delay, response.Headers.RetryAfter.Delta.Value.TotalMilliseconds));
                                } else {
                                    string hint = code == 401 ? "密钥无效或已过期。" : code == 402 ? "API账户余额不足。" : code == 403 ? "该密钥没有模型权限。" : code == 429 ? "请求过多，已有限重试，请稍后再试。" : "请检查接口地址、模型及图片支持情况。";
                                    throw new Exception("API返回 " + code + "：" + hint);
                                }
                            }
                            else
                            {
                                string raw = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                                var root = ContractEngine.Json().DeserializeObject(raw) as Dictionary<string, object>;
                                if (root == null || !root.ContainsKey("choices")) throw new Exception("接口响应不是Chat Completions格式，请检查API设置。");
                                var choices = root["choices"] as object[]; if (choices == null || choices.Length == 0) throw new Exception("接口没有返回内容。");
                                var choice = choices[0] as Dictionary<string, object>; var message = choice != null && choice.ContainsKey("message") ? choice["message"] as Dictionary<string, object> : null;
                                if (choice != null && choice.ContainsKey("finish_reason") && Convert.ToString(choice["finish_reason"]) == "length") throw new Exception("模型输出被截断，请减少单次图片或货物行数后重试。");
                                string text = message != null && message.ContainsKey("content") ? message["content"] as string : null;
                                if (text == null && message != null && message.ContainsKey("content")) { var pieces = message["content"] as object[]; text = pieces == null ? "" : string.Concat(pieces.OfType<Dictionary<string, object>>().Where(v => v.ContainsKey("text")).Select(v => Convert.ToString(v["text"]))); }
                                if (!string.IsNullOrWhiteSpace(text)) return text;
                                if (!jsonOutput || attempt > 0) throw new Exception("模型返回空内容，未猜填资料；请稍后重试。");
                            }
                        }
                    }
                    catch (TaskCanceledException) { if (overall.IsCancellationRequested || attempt == 2) throw new Exception(cancel.IsCancellationRequested ? "已取消。" : "API请求超时，请稍后重试。"); }
                    catch (HttpRequestException) { if (attempt == 2) throw new Exception("无法连接API，请检查网络、地址及HTTPS证书。"); }
                    try { await Task.Delay(delay, overall.Token).ConfigureAwait(false); } catch (OperationCanceledException) { throw new Exception(cancel.IsCancellationRequested ? "已取消。" : "API请求超时。"); }
                }
                throw new Exception("API暂时不可用，未修改合同资料。");
            }
        }
        public static async Task<OcrResult> Recognize(ApiSettings settings, byte[] png, CancellationToken cancel)
        {
            var batch = await BatchImport.Recognize(settings, new[] { png }, cancel).ConfigureAwait(false);
            if (batch.goods.Count == 0) throw new Exception("未识别到货物行，请检查图片是否包含清晰表格。");
            return new OcrResult { goods = batch.goods, warnings = batch.warnings, evidence = batch.evidence };
        }
        public static DraftResult ReviewDraft(DraftResult result, ContractData data)
        {
            if (result == null) throw new Exception("草稿格式不正确。");
            string known = string.Join(" ", data.goods.Select(g => g.name + " " + g.model)) + " " + data.Get("采购用途");
            var knownNumbers = new HashSet<string>(Regex.Matches(known, @"\d+(?:\.\d+)?").Cast<Match>().Select(m => m.Value));
            string prose = (result.title ?? "") + " " + (result.overview ?? "");
            bool invalid = string.IsNullOrWhiteSpace(result.title) || string.IsNullOrWhiteSpace(result.overview) || result.title.Length > 60 || result.overview.Length > 240 || prose.Contains("{{") || prose.Contains("}}") ||
                Regex.Matches(prose, @"\d+(?:\.\d+)?").Cast<Match>().Any(m => !knownNumbers.Contains(m.Value)) ||
                Regex.IsMatch(prose, "合同编号|流水号|序列号|签订日期|签章日期|保修|质保|违约|付款|交货|验收标准|通过.*认证|达到.*精度|保证满足");
            if (invalid) {
                var safe = new ContractData { goods = data.goods }; safe.fields["采购用途"] = data.Get("采购用途"); TemplateRules.Prepare(safe, true);
                result.title = safe.Get("合同名称"); result.overview = safe.Get("项目概况"); result.warning = "AI草稿包含新数值、越界条款、标记或不完整内容，已回退为实际清单概况；请核对原始资料。";
            }
            result.specifications = MaterialCatalog.Resolve(data);
            result.technical = "";
            var missing = result.specifications.Where(r => string.IsNullOrWhiteSpace(r.specification)).Select(r => r.model).ToArray();
            if (missing.Length > 0) result.warning = (result.warning ?? "") + " 以下型号无唯一可用参数：" + string.Join("、", missing) + "。未猜填数值。";
            return result;
        }
        public static async Task<DraftResult> Draft(ApiSettings settings, ContractData data, CancellationToken cancel)
        {
            if (!data.goods.Any(g => !string.IsNullOrWhiteSpace(g.name) || !string.IsNullOrWhiteSpace(g.model))) throw new Exception("请先填写或识别货物清单。");
            string instruction = EmbeddedContent.Prompt("draft-prompt.txt");
            var materials = MaterialCatalog.Resolve(data);
            string source = ContractEngine.Json().Serialize(new { purpose = data.Get("采购用途"), goods = data.goods.Select((g, i) => new { g.name, description = OverviewEvidence(materials[i]), source_status = materials[i].status }).ToArray() });
            string answer = await Complete(settings, instruction, source, false, cancel, true).ConfigureAwait(false); DraftResult result;
            try { result = ContractEngine.Json().Deserialize<DraftResult>(CleanJson(answer)); } catch { throw new Exception("API 返回的草稿格式有误，请重试。"); }
            return ReviewDraft(result, data);
        }
        static string OverviewEvidence(MaterialRecord r)
        {
            var descriptions = new[] { r.specification ?? "" }.Concat((r.evidence ?? new List<MaterialEvidence>()).Select(e => e.specification ?? ""));
            return string.Join("；", descriptions.SelectMany(s => Regex.Split(s, "[，,；;。\\r\\n]")).Select(s => s.Trim()).Where(s => s.Length > 1 && !Regex.IsMatch(s, @"[0-9<>=≥≤]")).Distinct().Take(8));
        }
    }
}
