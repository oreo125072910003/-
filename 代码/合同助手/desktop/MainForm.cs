using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ContractHelper
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        static string[] ConfigureArguments(string[] args)
        {
            var remaining = new List<string>(); string dataRoot = null;
            for (int i = 0; i < args.Length; i++) {
                if (args[i] != "--data-dir") { remaining.Add(args[i]); continue; }
                if (dataRoot != null) throw new ArgumentException("--data-dir 不能重复。\n");
                if (++i >= args.Length || string.IsNullOrWhiteSpace(args[i]) || args[i].StartsWith("--")) throw new ArgumentException("--data-dir 缺少目录。\n");
                string value = args[i];
                if (!System.Text.RegularExpressions.Regex.IsMatch(value, @"^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))")) throw new ArgumentException("--data-dir 必须是完整的绝对目录。\n");
                dataRoot = Path.GetFullPath(value);
            }
            if (remaining.Count > 0) {
                string mode = remaining[0];
                bool help = mode == "--help" || mode == "--mcp-help" || mode == "--agent-prompt";
                bool oneValue = mode == "--self-test-help" || mode == "--open-progress";
                bool selfTest = mode == "--self-test";
                if ((!help && !oneValue && !selfTest) || (help && remaining.Count != 1) || (oneValue && remaining.Count != 2) || (selfTest && (remaining.Count < 2 || remaining.Count > 3)) || remaining.Skip(1).Any(s => string.IsNullOrWhiteSpace(s) || s.StartsWith("--"))) throw new ArgumentException("未知参数，或参数缺少值。\n");
            }
            // Set storage before any help, tests, MainForm or library can read it.
            if (dataRoot != null) AppStorage.OverrideRoot = dataRoot;
            return remaining.ToArray();
        }
        [STAThread] static void Main(string[] args)
        {
            try { args = ConfigureArguments(args); }
            catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 2; return; }
            SetProcessDPIAware(); Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length > 1 && args[0] == "--self-test-help") { HelpDialog.Test(args[1]); return; }
            if (args.Length > 0 && (args[0] == "--help" || args[0] == "--mcp-help" || args[0] == "--agent-prompt")) { Application.Run(new HelpDialog(args[0] == "--agent-prompt" ? 3 : args[0] == "--mcp-help" ? 1 : 0)); return; }
            if (args.Length > 1 && args[0] == "--self-test") { DesktopTests.Run(args[1], args.Length > 2 ? args[2] : null); return; }
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { MessageBox.Show(e.Exception.Message, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Information); };
            var form = new MainForm(false);
            if (args.Length > 1 && args[0] == "--open-progress") form.Shown += delegate { try { form.LoadProgressFromPath(args[1]); } catch (Exception e) { Ui.Error(form, e); } };
            Application.Run(form);
        }
    }
    public static class Ui
    {
        public static readonly Color Green = Xp.Blue;
        public static Button Button(string text, Action action, bool primary)
        {
            var b = new XpButton { Text = text, Primary = primary, AutoSize = true, MinimumSize = new Size(80, 29), Padding = new Padding(8, 2, 8, 2), Margin = new Padding(0, 0, 6, 4) };
            if (action != null) b.Click += delegate { action(); }; return b;
        }
        public static Label Note(string text) { return new Label { Text = text, AutoSize = true, ForeColor = Color.FromArgb(64, 64, 64), MaximumSize = new Size(1000, 0), Margin = new Padding(0, 5, 0, 9) }; }
        public static FlowLayoutPanel Flow() { return new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, WrapContents = true, Margin = new Padding(0), Padding = new Padding(0) }; }
        public static TableLayoutPanel Stack() { return new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, Padding = new Padding(12), Margin = new Padding(0), BackColor = Xp.Face }; }
        public static TextBox Field(TableLayoutPanel stack, string label, int height)
        {
            var box = new TextBox { Dock = DockStyle.Fill, Multiline = height > 34, Height = height, BorderStyle = BorderStyle.Fixed3D, BackColor = Color.White, ForeColor = Color.Black, Margin = new Padding(0, 0, 0, 9), ScrollBars = height > 34 ? ScrollBars.Vertical : ScrollBars.None };
            stack.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(0, 2, 0, 5), ForeColor = Color.Black }); stack.Controls.Add(box); return box;
        }
        public static DataGridView Grid()
        {
            return new DataGridView { Dock = DockStyle.Fill, BackgroundColor = Color.White, BorderStyle = BorderStyle.Fixed3D, GridColor = Color.FromArgb(192, 192, 192), CellBorderStyle = DataGridViewCellBorderStyle.Single, ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.Raised, RowHeadersBorderStyle = DataGridViewHeaderBorderStyle.Raised, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, AllowUserToAddRows = true, AllowUserToDeleteRows = true, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = true, RowHeadersWidth = 26, ColumnHeadersHeight = 28, ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing, AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells, ClipboardCopyMode = DataGridViewClipboardCopyMode.EnableWithoutHeaderText, DefaultCellStyle = new DataGridViewCellStyle { Padding = new Padding(2), WrapMode = DataGridViewTriState.True, SelectionBackColor = Color.FromArgb(49, 106, 197), SelectionForeColor = Color.White }, ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Xp.Face, ForeColor = Color.Black }, RowHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Xp.Face }, EnableHeadersVisualStyles = false };
        }
        public static void Column(DataGridView grid, string key, string label, float weight, bool readOnly)
        { grid.Columns.Add(new DataGridViewTextBoxColumn { Name = key, HeaderText = label, FillWeight = weight, MinimumWidth = key == "price" ? 124 : 55, ReadOnly = readOnly, SortMode = DataGridViewColumnSortMode.NotSortable }); }
        public static string Cell(DataGridViewRow row, string name) { return Convert.ToString(row.Cells[name].Value).Trim(); }
        public static void Error(IWin32Window owner, Exception e) { MessageBox.Show(owner, e.Message, "请检查", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }
    public class MainForm : XpForm
    {
        const string WindowTitle = "合同填写小助手";
        readonly Dictionary<string, TextBox> boxes = new Dictionary<string, TextBox>();
        readonly TabControl tabs = new XpTabs { Dock = DockStyle.Fill };
        readonly DataGridView goodsGrid = Ui.Grid();
        readonly Label amount = new Label(), uppercase = new Label();
        readonly StatusBar status = new StatusBar();
        LibraryPanel generatedLibrary, templateLibrary; MaterialPanel materialsPanel;
        string selectedTemplateId = "", selectedReferenceId = ""; readonly Label filePreview = new Label(); FlowLayoutPanel toolbar; Button cancelButton;
        readonly Button exportButton; readonly bool testing; bool loading, dirty, busy;
        byte[] templateBytes; string templateName = TemplateRules.Name, templateSource = "";
        List<Payment> payments = TemplateRules.DefaultPayments(); ApiSettings api; CancellationTokenSource request;
        public MainForm(bool testing)
        {
            this.testing = testing; if (!testing) EmbeddedContent.EnsureLibrary(); Text = WindowTitle + " 2.3"; ClientSize = new Size(1100, 800); MinimumSize = new Size(980, 720); StartPosition = FormStartPosition.CenterScreen; Icon = SystemIcons.Application;
            templateBytes = ContractEngine.Resource("template.docx"); api = new ApiSettings();
            if (!testing) try { api = ApiStore.Load(ApiStore.DefaultPath); } catch { }
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new Padding(3) };
            foreach (int h in new[] { 25, 40 }) root.RowStyles.Add(new RowStyle(SizeType.Absolute, h)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 23)); Controls.Add(root);
            MainMenuStrip = BuildMenu(); root.Controls.Add(MainMenuStrip, 0, 0);
            var bar = Ui.Flow(); toolbar = bar; bar.Padding = new Padding(6, 4, 0, 0); bar.Controls.Add(Ui.Button("新建合同", NewContract, false)); bar.Controls.Add(Ui.Button("批量导入图片", delegate { OpenImages(null, false); }, true)); bar.Controls.Add(Ui.Button("保存进度", SaveProgress, false)); bar.Controls.Add(Ui.Button("记住双方资料", RememberCommon, false)); cancelButton = Ui.Button("取消AI操作", delegate { if (request != null) request.Cancel(); }, false); cancelButton.Enabled = false; bar.Controls.Add(cancelButton); root.Controls.Add(bar, 0, 1);
            BuildContractTab(); BuildGoodsTab(); BuildLibraryTab(); BuildMaterialsTab(); BuildSettingsTab(); root.Controls.Add(tabs, 0, 2);
            var footer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, Padding = new Padding(10, 3, 6, 0) }; footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180)); for (int i = 0; i < 3; i++) footer.RowStyles.Add(new RowStyle(SizeType.Percent, 33));
            amount.Dock = uppercase.Dock = DockStyle.Fill; amount.TextAlign = uppercase.TextAlign = ContentAlignment.MiddleLeft; amount.Font = new Font(Font, FontStyle.Bold); footer.Controls.Add(amount, 0, 0); footer.Controls.Add(uppercase, 0, 1); exportButton = Ui.Button("生成 Word 合同", Generate, true); exportButton.Dock = DockStyle.Fill; footer.Controls.Add(exportButton, 1, 0); footer.SetRowSpan(exportButton, 3); filePreview.Dock = DockStyle.Fill; filePreview.TextAlign = ContentAlignment.MiddleLeft; footer.Controls.Add(filePreview, 0, 2); root.Controls.Add(footer, 0, 3);
            status.Dock = DockStyle.Fill; status.SizingGrip = true; root.Controls.Add(status, 0, 4);
            AllowDrop = true; DragEnter += delegate(object sender, DragEventArgs e) { if (!busy && e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; };
            DragDrop += delegate(object sender, DragEventArgs e) { var paths = e.Data.GetData(DataFormats.FileDrop) as string[]; if (paths != null) OpenImages(paths, false); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { if (request != null) request.Cancel(); e.Cancel = true; Status("正在取消，请稍后关闭。"); } else if (dirty && MessageBox.Show(this, "填写进度尚未保存，确定关闭吗？", "关闭程序", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) e.Cancel = true; };
            ResetData(); if (!testing) try { EmbeddedContent.EnsureLibrary(); } catch (Exception e) { Status("内置参考合同入库失败：" + e.Message); } RefreshLibrary();
        }
        ToolStripMenuItem Item(string name, Action action, Keys key) { var item = new ToolStripMenuItem(name) { ShortcutKeys = key }; item.Click += delegate { action(); }; return item; }
        MenuStrip BuildMenu()
        {
            var menu = new MenuStrip { Dock = DockStyle.Fill, AutoSize = false, BackColor = Xp.Face, Renderer = new ToolStripSystemRenderer(), Padding = new Padding(1), Font = Font };
            var file = new ToolStripMenuItem("文件(&F)"); file.DropDownItems.Add(Item("新建合同", NewContract, Keys.Control | Keys.N)); file.DropDownItems.Add(Item("打开填写进度...", OpenProgress, Keys.Control | Keys.O)); file.DropDownItems.Add(Item("保存填写进度...", SaveProgress, Keys.Control | Keys.S)); file.DropDownItems.Add(Item("生成Word合同...", Generate, Keys.Control | Keys.Enter)); file.DropDownItems.Add(new ToolStripSeparator()); file.DropDownItems.Add(Item("载入脱敏开发示例", delegate { if (MayReplace()) { templateBytes = ContractEngine.Resource("template.docx"); templateName = TemplateRules.Name; templateSource = ""; LoadData(ContractEngine.Sample()); MarkDirty(); Status("已载入2项脱敏开发货物，合计50.01元。"); } }, Keys.None)); file.DropDownItems.Add(Item("退出", Close, Keys.None));
            var view = new ToolStripMenuItem("查看(&V)"); for (int i = 0; i < 6; i++) { int n = i; view.DropDownItems.Add(Item(new[] { "合同资料", "货物与参数", "生成库", "模板库", "型号库", "设置" }[i], delegate { tabs.SelectedIndex = n; }, Keys.None)); }
            var tools = new ToolStripMenuItem("工具(&T)"); tools.DropDownItems.Add(Item("批量导入图片...", delegate { OpenImages(null, false); }, Keys.Control | Keys.Shift | Keys.V)); tools.DropDownItems.Add(Item("AI起草概况与材料说明", async delegate { await GenerateDraft(); }, Keys.Control | Keys.G)); tools.DropDownItems.Add(Item("联网核验型号参数", async delegate { await LookupModels(); }, Keys.None)); tools.DropDownItems.Add(Item("查看已归档型号资料", ShowMaterials, Keys.None)); tools.DropDownItems.Add(new ToolStripSeparator()); tools.DropDownItems.Add(Item("API设置...", delegate { ConfigureApi(); }, Keys.None)); tools.DropDownItems.Add(Item("导入Word模板...", ImportTemplate, Keys.None)); tools.DropDownItems.Add(Item("恢复脱敏开发模板", delegate { templateBytes = ContractEngine.Resource("template.docx"); templateName = TemplateRules.Name; templateSource = ""; UpdateFixed(); MarkDirty(); }, Keys.None)); tools.DropDownItems.Add(Item("导出填写标记模板...", ExportTemplate, Keys.None));
            var help = new ToolStripMenuItem("帮助(&H)");
            help.DropDownItems.Add(Item("使用说明", delegate { using (var dialog = new HelpDialog(0)) dialog.ShowDialog(this); }, Keys.F1));
            help.DropDownItems.Add(Item("AI接入说明", delegate { using (var dialog = new HelpDialog(1)) dialog.ShowDialog(this); }, Keys.None));
            help.DropDownItems.Add(Item("AI工作提示词", delegate { using (var dialog = new HelpDialog(3)) dialog.ShowDialog(this); }, Keys.None));
            help.DropDownItems.Add(Item("模板和示例", delegate { using (var dialog = new HelpDialog(2)) dialog.ShowDialog(this); }, Keys.None));
            menu.Items.AddRange(new ToolStripItem[] { file, view, tools, help }); return menu;
        }
        TabPage Page(string name) { var p = new TabPage(name) { BackColor = Xp.Face, AutoScroll = true }; tabs.TabPages.Add(p); return p; }
        TextBox Field(TableLayoutPanel stack, string key, string label, int height) { var box = Ui.Field(stack, label, height); box.Name = key; boxes[key] = box; box.TextChanged += delegate { MarkDirty(); }; return box; }
        void BuildContractTab()
        {
            var page = Page("合同资料"); var cols = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 }; cols.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42)); cols.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58)); page.Controls.Add(cols);
            var party = Ui.Stack(); var desc = Ui.Stack(); cols.Controls.Add(party); cols.Controls.Add(desc);
            party.Controls.Add(Ui.Note("乙方资料 · 可由多张截图一起导入")); Field(party, "乙方名称", "乙方名称 *", 30); Field(party, "乙方简称", "乙方简称（仅用于文件名）", 30); Field(party, "乙方代表", "乙方代表（选填）", 30); Field(party, "乙方电话", "联系电话 *", 30); Field(party, "乙方地址", "地址 *", 76); Field(party, "采购用途", "采购用途（有实际用途时填写）", 65);
            desc.Controls.Add(Ui.Note("一、采购合同名称及项目概况")); Field(desc, "合同名称", "合同名称（留空按货物清单填写）", 30); Field(desc, "项目概况", "采购概况（留空按实际货物简述）", 115); Field(desc, "技术补充", "四、2. 额外技术说明（型号参数在货物页填写）", 85);
            var actions = Ui.Flow(); var ai = Ui.Button("AI起草并预览", null, false); ai.Click += async delegate { await GenerateDraft(); }; actions.Controls.Add(ai); desc.Controls.Add(actions); desc.Controls.Add(Ui.Note("其他正文沿用模板。技术参数须来自已提供资料或官网核验。"));
        }
        void BuildGoodsTab()
        {
            var page = Page("货物与参数"); page.AutoScroll = false; var area = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) }; area.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); area.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); page.Controls.Add(area);
            var bar = Ui.Flow(); bar.Controls.Add(Ui.Button("批量导入图片", delegate { OpenImages(null, false); }, true)); bar.Controls.Add(Ui.Button("增加一行", delegate { goodsGrid.Rows.Add("", "", "", "", "", "", "", ""); MarkDirty(); }, false)); bar.Controls.Add(Ui.Button("删除选中行", delegate { foreach (DataGridViewRow row in goodsGrid.SelectedRows) if (!row.IsNewRow) goodsGrid.Rows.Remove(row); Recalculate(); MarkDirty(); }, false)); var lookup = Ui.Button("联网核验型号参数", null, false); lookup.Click += async delegate { await LookupModels(); }; bar.Controls.Add(lookup); bar.Controls.Add(Ui.Button("从型号库填参数", FillFromMaterials, false)); bar.Controls.Add(Ui.Button("打开型号库", ShowMaterials, false)); area.Controls.Add(bar, 0, 0);
            Ui.Column(goodsGrid, "name", "货物名称 *", 140, false); Ui.Column(goodsGrid, "model", "完整型号 *", 150, false); Ui.Column(goodsGrid, "brand", "品牌", 90, false); Ui.Column(goodsGrid, "qty", "数量 *", 65, false); Ui.Column(goodsGrid, "unit", "单位 *", 55, false); Ui.Column(goodsGrid, "price", "含税单价(元) *", 100, false); Ui.Column(goodsGrid, "subtotal", "金额", 100, true); Ui.Column(goodsGrid, "spec", "已有技术资料", 230, false); area.Controls.Add(goodsGrid, 0, 1);
            goodsGrid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.None; goodsGrid.RowTemplate.Height = 48; goodsGrid.Columns["spec"].DefaultCellStyle.WrapMode = DataGridViewTriState.False;
            goodsGrid.CellToolTipTextNeeded += delegate(object sender, DataGridViewCellToolTipTextNeededEventArgs e) { if (e.RowIndex >= 0 && e.ColumnIndex >= 0) e.ToolTipText = Convert.ToString(goodsGrid.Rows[e.RowIndex].Cells[e.ColumnIndex].Value); };
            goodsGrid.CellDoubleClick += delegate(object sender, DataGridViewCellEventArgs e) { if (e.RowIndex < 0 || e.ColumnIndex < 0 || goodsGrid.Columns[e.ColumnIndex].Name != "spec") return; var row = goodsGrid.Rows[e.RowIndex]; using (var f = new XpForm { Text = "编辑技术参数 · " + Ui.Cell(row, "model"), ClientSize = new Size(740, 400), StartPosition = FormStartPosition.CenterParent }) { var text = new TextBox { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Vertical, Text = Ui.Cell(row, "spec") }; var actions = Ui.Flow(); actions.Dock = DockStyle.Bottom; actions.Height = 40; actions.Controls.Add(Ui.Button("保存本行参数", delegate { row.Cells["spec"].Value = text.Text.Trim(); MarkDirty(); f.Close(); }, true)); f.Controls.Add(text); f.Controls.Add(actions); f.ShowDialog(this); } };
            goodsGrid.CellEndEdit += delegate { Recalculate(); MarkDirty(); }; goodsGrid.UserDeletedRow += delegate { Recalculate(); MarkDirty(); }; goodsGrid.DataError += delegate(object sender, DataGridViewDataErrorEventArgs e) { e.ThrowException = false; };
        }
        void BuildLibraryTab()
        {
            var generated = Page("生成库"); generated.AutoScroll = false; generatedLibrary = new LibraryPanel("generated", e => { if (File.Exists(e.progress) && MayReplace()) { LoadProgressFromPath(e.progress); tabs.SelectedIndex = 0; } else if (!File.Exists(e.progress)) MessageBox.Show(this, "此文档没有可恢复的填写进度，可直接打开Word查阅和编辑。"); }); generated.Controls.Add(generatedLibrary);
            var templates = Page("模板库"); templates.AutoScroll = false; templateLibrary = new LibraryPanel("template", UseTemplate); templates.Controls.Add(templateLibrary);
        }
        void BuildMaterialsTab() { var page = Page("型号库"); page.AutoScroll = false; materialsPanel = new MaterialPanel(r => { SetGoods(new[] { new Good { name = r.name, model = r.model, brand = r.brand, spec = r.specification, qty = "", unit = "", price = "" } }, true); MarkDirty(); tabs.SelectedIndex = 1; Status("已带入型号和参数，请填写本次数量、单位及含税单价。"); }); page.Controls.Add(materialsPanel); }
        void RefreshLibrary() { if (generatedLibrary != null) generatedLibrary.Reload(); if (templateLibrary != null) templateLibrary.Reload(); }
        void UseTemplate(LibraryEntry entry)
        {
            try {
                if (entry.role == "fillable") { var bytes = ContractEngine.AdaptTemplate(File.ReadAllBytes(entry.path)); ContractEngine.ValidateTemplate(bytes); templateBytes = bytes; templateName = TemplateRules.IsSchool(bytes) ? TemplateRules.Name : entry.name; templateSource = entry.path; selectedTemplateId = entry.id; }
                else { selectedReferenceId = entry.id; if (!string.IsNullOrWhiteSpace(entry.template_id)) { var baseEntry = ContractLibrary.Get(entry.template_id); if (baseEntry.role == "fillable") { UseTemplate(baseEntry); } } }
                UpdateFixed(); MarkDirty(); tabs.SelectedIndex = 0; Status("当前模板：" + templateName + (selectedReferenceId == "" ? "" : "；已关联参考范例，固定正文沿用生成模板。"));
            } catch (Exception e) { Ui.Error(this, e); }
        }
        void FillFromMaterials()
        {
            var data = ReadData(); var issues = new List<string>(); int count = 0;
            foreach (var g in data.goods) try { var r = MaterialCatalog.Cached(g.model, g.brand ?? ""); if (r == null) { issues.Add(g.model + "：暂无精确型号资料"); continue; } if (string.IsNullOrWhiteSpace(g.spec)) { g.spec = r.specification; if (string.IsNullOrWhiteSpace(g.brand)) g.brand = r.brand; count++; } else issues.Add(g.model + "：当前描述已保留，可在型号库对照"); } catch (Exception e) { issues.Add(e.Message); }
            SetGoods(data.goods, false); MarkDirty(); Status("已填入" + count + "行参数。"); if (issues.Count > 0) MessageBox.Show(this, string.Join("\r\n", issues), "型号资料核对");
        }
        void BuildSettingsTab()
        {
            var page = Page("设置"); var cols = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 }; cols.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45)); cols.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55)); page.Controls.Add(cols); var contacts = Ui.Stack(); var fixedPart = Ui.Stack(); cols.Controls.Add(contacts); cols.Controls.Add(fixedPart);
            var preference = Preferences.Load(); contacts.Controls.Add(Ui.Note("生成文件与接入")); var folder = Ui.Field(contacts, "默认输出文件夹（桌面与Harness共用）", 32); folder.Text = preference.output_directory;
            var units = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList }; units.Items.AddRange(new object[] { "万", "元" }); units.SelectedItem = preference.amount_unit; contacts.Controls.Add(Ui.Note("文件名金额单位（保留准确金额，不取整）")); contacts.Controls.Add(units);
            var settingsActions = Ui.Flow(); settingsActions.Controls.Add(Ui.Button("选择文件夹", delegate { using (var d = new FolderBrowserDialog { SelectedPath = folder.Text, Description = "选择生成合同的默认保存目录" }) if (d.ShowDialog(this) == DialogResult.OK) folder.Text = d.SelectedPath; }, false));
            settingsActions.Controls.Add(Ui.Button("保存输出设置", delegate { try { var current = Preferences.Load(); current.output_directory = folder.Text.Trim(); current.amount_unit = units.Text; Preferences.Save(current); Recalculate(); Status("默认目录已保存，Harness下一次调用也会使用此目录。"); } catch (Exception e) { Ui.Error(this, e); } }, true)); settingsActions.Controls.Add(Ui.Button("API设置与连接测试", delegate { ConfigureApi(); }, false)); contacts.Controls.Add(settingsActions); contacts.Controls.Add(Ui.Note("文件名：日期_乙方简称_准确金额；正文价格始终以元填写。"));
            contacts.Controls.Add(Ui.Note("甲方经办资料 · 初始值取自你提供的文档")); Field(contacts, "甲方代表", "甲方代表 *", 30); Field(contacts, "甲方电话", "甲方联系电话 *", 30); contacts.Controls.Add(Ui.Button("记住双方资料", RememberCommon, false)); contacts.Controls.Add(Ui.Note("付款沿用原件：验收合格后10个工作日内付清。编号、签章日期均保留原模板，不自动编写。"));
            fixedPart.Controls.Add(Ui.Note("模板固定内容 · 仅查看")); foreach (var kv in TemplateRules.FixedFields) Field(fixedPart, kv.Key, kv.Key, 30);
        }
        void Status(string text) { status.Text = text; }
        void MarkDirty() { if (!loading) { dirty = true; Text = WindowTitle + " 2.3 *"; try { filePreview.Text = "文件名：" + TemplateRules.FileBase(ReadData(), DateTime.Now) + ".docx"; } catch { } } }
        void Clean() { dirty = false; Text = WindowTitle + " 2.3"; }
        bool MayReplace() { return !dirty || MessageBox.Show(this, "当前进度尚未保存，继续会替换。是否继续？", "替换当前内容", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes; }
        void UpdateFixed() { bool school = TemplateRules.IsSchool(templateBytes); foreach (var kv in TemplateRules.FixedFields) { boxes[kv.Key].ReadOnly = school; boxes[kv.Key].TabStop = !school; boxes[kv.Key].BackColor = school ? Xp.Face : Color.White; if (school) boxes[kv.Key].Text = kv.Value; } }
        void ResetData() { templateBytes = ContractEngine.Resource("template.docx"); templateName = TemplateRules.Name; templateSource = ""; var d = new ContractData(); d.fields = TemplateRules.Defaults(); d.payments = TemplateRules.DefaultPayments(); if (!testing) try { foreach (var kv in CommonInfoStore.Load(CommonInfoStore.DefaultPath)) d.fields[kv.Key] = kv.Value; } catch { } LoadData(d); tabs.SelectedIndex = 0; Clean(); Status("脱敏开发模板 · 真实业务请导入并核对经确认模板。"); }
        void NewContract() { if (!busy && MayReplace()) ResetData(); }
        public void LoadData(ContractData d) { selectedTemplateId = d.template_id ?? ""; selectedReferenceId = d.reference_id ?? ""; loading = true; try { TemplateRules.Prepare(d, TemplateRules.IsSchool(templateBytes)); foreach (var kv in boxes) kv.Value.Text = d.Get(kv.Key); payments = d.payments.Count == 0 ? TemplateRules.DefaultPayments() : d.payments; SetGoods(d.goods, false); UpdateFixed(); } finally { loading = false; } Recalculate(); }
        void SetGoods(IEnumerable<Good> rows, bool append) { if (!append) goodsGrid.Rows.Clear(); foreach (var g in rows) goodsGrid.Rows.Add(g.name, g.model, g.brand, g.qty, g.unit, g.price, "", g.spec); Recalculate(); }
        public ContractData ReadData() { goodsGrid.EndEdit(); if (selectedTemplateId == "" && templateName == TemplateRules.Name) { var baseEntry = ContractLibrary.Search("", "template").FirstOrDefault(e => e.role == "fillable" && (e.hash == AppStorage.Hash(templateBytes) || e.id == AppStorage.Hash(templateBytes))); if (baseEntry != null) selectedTemplateId = baseEntry.id; } var d = new ContractData { cover = false, template_id = selectedTemplateId, reference_id = selectedReferenceId, payments = payments.Select(p => new Payment { condition = p.condition, ratio = p.ratio }).ToList() }; foreach (var kv in boxes) d.fields[kv.Key] = kv.Value.Text.Trim(); d.goods = goodsGrid.Rows.Cast<DataGridViewRow>().Where(r => !r.IsNewRow).Select(r => new Good { name = Ui.Cell(r, "name"), model = Ui.Cell(r, "model"), brand = Ui.Cell(r, "brand"), qty = Ui.Cell(r, "qty"), unit = Ui.Cell(r, "unit"), price = Ui.Cell(r, "price"), spec = Ui.Cell(r, "spec") }).Where(g => new[] { g.name, g.model, g.qty, g.unit, g.price, g.spec }.Any(v => v != "")).ToList(); TemplateRules.Prepare(d, TemplateRules.IsSchool(templateBytes)); return d; }
        void Recalculate() { if (goodsGrid.Columns.Count == 0) return; try { decimal total = 0; foreach (DataGridViewRow r in goodsGrid.Rows) if (!r.IsNewRow) { decimal sum = ContractEngine.Subtotal(new Good { qty = Ui.Cell(r, "qty"), price = Ui.Cell(r, "price") }); r.Cells["subtotal"].Value = ContractEngine.Money(sum); total += sum; } amount.Text = "合同总额　￥" + total.ToString("N2"); uppercase.Text = ContractEngine.ChineseMoney(total); try { filePreview.Text = "文件名：" + TemplateRules.FileBase(ReadData(), DateTime.Now) + ".docx"; } catch { filePreview.Text = "填写乙方及货物后显示文件名称"; } } catch { amount.Text = "合同总额　请核对数量和单价"; uppercase.Text = ""; filePreview.Text = "补全数量和单价后显示文件名称"; } }
        void RememberCommon() { try { if (!testing) CommonInfoStore.Save(ReadData(), CommonInfoStore.DefaultPath); Status("双方资料已记住，下次新建自动带入。"); } catch (Exception e) { Ui.Error(this, e); } }
        static void WriteFile(string path, byte[] bytes) { string temp = path + ".tmp"; try { File.WriteAllBytes(temp, bytes); if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path); } finally { if (File.Exists(temp)) File.Delete(temp); } }
        void Generate() { try { var d = ReadData(); var bytes = ContractEngine.Build(d, templateBytes); string folder = Preferences.Load().output_directory; Directory.CreateDirectory(folder); string file = TemplateRules.AvailableBase(folder, TemplateRules.FileBase(d, DateTime.Now)); using (var dialog = new SaveFileDialog { Title = "保存合同", Filter = "Word合同|*.docx", InitialDirectory = folder, FileName = Path.GetFileName(file) + ".docx" }) if (dialog.ShowDialog(this) == DialogResult.OK) { if (SameTemplate(dialog.FileName)) throw new Exception("不能覆盖导入的模板。"); string progress = Path.ChangeExtension(dialog.FileName, ".json"); if (templateName != TemplateRules.Name) d.template = new TemplateData { name = templateName, base64 = Convert.ToBase64String(templateBytes) }; WriteFile(dialog.FileName, bytes); WriteFile(progress, Encoding.UTF8.GetBytes(ContractEngine.Json().Serialize(d))); ContractLibrary.Import(dialog.FileName, progress, "generated", "reference", selectedTemplateId, selectedReferenceId); var preferences = Preferences.Load(); preferences.output_directory = Path.GetDirectoryName(dialog.FileName); Preferences.Save(preferences); RefreshLibrary(); Clean(); Status("合同及进度已保存，并加入文件库：" + Path.GetFileName(dialog.FileName)); } } catch (Exception e) { Ui.Error(this, e); } }
        void SaveProgress() { try { var d = ReadData(); if (templateName != TemplateRules.Name) d.template = new TemplateData { name = templateName, base64 = Convert.ToBase64String(templateBytes) }; string name = "未完成合同"; try { name = TemplateRules.FileBase(d, DateTime.Now); } catch { } using (var f = new SaveFileDialog { Filter = "填写进度|*.json", FileName = name + ".json" }) if (f.ShowDialog(this) == DialogResult.OK) { WriteFile(f.FileName, Encoding.UTF8.GetBytes(ContractEngine.Json().Serialize(d))); Clean(); Status("进度已保存。"); } } catch (Exception e) { Ui.Error(this, e); } }
        void OpenProgress() { if (!MayReplace()) return; using (var f = new OpenFileDialog { Filter = "填写进度|*.json" }) if (f.ShowDialog(this) == DialogResult.OK) try { LoadProgressFromPath(f.FileName); } catch (Exception e) { Ui.Error(this, e); } }
        public void LoadProgressFromPath(string path) { if (new FileInfo(path).Length > 30 * 1024 * 1024) throw new Exception("进度文件过大。"); var d = ContractEngine.Json().Deserialize<ContractData>(File.ReadAllText(path, Encoding.UTF8)); if (d == null || d.version != 1 || d.fields == null || d.goods == null || d.payments == null || d.goods.Count > 500 || d.payments.Count > 3 || d.goods.Any(g => g == null) || d.payments.Any(p => p == null)) throw new Exception("不是有效的填写进度。"); templateBytes = d.template == null ? ContractEngine.Resource("template.docx") : ContractEngine.AdaptTemplate(Convert.FromBase64String(d.template.base64)); ContractEngine.ValidateTemplate(templateBytes); templateName = d.template == null || TemplateRules.IsSchool(templateBytes) ? TemplateRules.Name : d.template.name; templateSource = ""; LoadData(d); Clean(); Status("进度已恢复，固定内容仍沿用原模板。"); }
        void ImportTemplate() { using (var f = new OpenFileDialog { Filter = "Word模板|*.docx" }) if (f.ShowDialog(this) == DialogResult.OK) try { if (new FileInfo(f.FileName).Length > 20 * 1024 * 1024) throw new Exception("模板请小于20MB。"); var bytes = ContractEngine.AdaptTemplate(File.ReadAllBytes(f.FileName)); ContractEngine.ValidateTemplate(bytes); templateBytes = bytes; templateName = TemplateRules.IsSchool(bytes) ? TemplateRules.Name : Path.GetFileName(f.FileName); templateSource = f.FileName; UpdateFixed(); MarkDirty(); Status("已载入模板：" + templateName); } catch (Exception e) { Ui.Error(this, e); } }
        bool SameTemplate(string path) { return templateSource != "" && string.Equals(Path.GetFullPath(path), Path.GetFullPath(templateSource), StringComparison.OrdinalIgnoreCase); }
        void ExportTemplate() { using (var f = new SaveFileDialog { Filter = "Word模板|*.docx", FileName = "九州合同填写标记模板.docx" }) if (f.ShowDialog(this) == DialogResult.OK) try { if (SameTemplate(f.FileName)) throw new Exception("请选择其他文件名。"); WriteFile(f.FileName, ContractEngine.Resource("template.docx")); } catch (Exception e) { Ui.Error(this, e); } }
        bool ConfigureApi() { using (var dialog = new ApiDialog(api)) if (dialog.ShowDialog(this) == DialogResult.OK) { api = dialog.Settings; return true; } return false; }
        bool EnsureApi(bool vision) { try { api.Validate(vision); return true; } catch { return ConfigureApi(); } }
        void Busy(bool value) { busy = value; exportButton.Enabled = !value; tabs.Enabled = !value; MainMenuStrip.Enabled = !value; foreach (Control c in toolbar.Controls) c.Enabled = !value; cancelButton.Enabled = value; UseWaitCursor = value; }
        async Task GenerateDraft() { if (busy || !EnsureApi(false)) return; Busy(true); request = new CancellationTokenSource(); Status("正在起草第一节，技术说明只取已有资料及已核验参数…"); try { var result = await AiService.Draft(api, ReadData(), request.Token); using (var preview = new DraftDialog(result)) if (preview.ShowDialog(this) == DialogResult.OK) { boxes["合同名称"].Text = preview.Result.title; boxes["项目概况"].Text = preview.Result.overview; if (!string.IsNullOrWhiteSpace(preview.Result.technical)) boxes["技术补充"].Text = preview.Result.technical; var current = ReadData(); if (preview.Result.specifications != null) for (int i = 0; i < Math.Min(current.goods.Count, preview.Result.specifications.Count); i++) if (string.IsNullOrWhiteSpace(current.goods[i].spec) && current.goods[i].model == preview.Result.specifications[i].model) current.goods[i].spec = preview.Result.specifications[i].specification; SetGoods(current.goods, false); MarkDirty(); Status("已填入第一节及第四节第2项，请核对内容。"); } } catch (Exception e) { Ui.Error(this, e); } finally { request.Dispose(); request = null; Busy(false); } }
        async Task LookupModels() { if (busy) return; Busy(true); request = new CancellationTokenSource(); var messages = new List<string>(); try { var data = ReadData(); foreach (var g in data.goods) { Status("正在核验官网型号：" + g.model); try { var r = await MaterialCatalog.Lookup(g.model, true, null, request.Token, g.brand ?? ""); string source = r.specification; if (string.IsNullOrWhiteSpace(g.spec)) g.spec = source; messages.Add(g.model + "：" + r.status + "，资料已归档。" + (g.spec != source ? "已有技术资料已保留，可在型号资料库对照。" : "")); } catch (Exception e) { messages.Add(e.Message); } } SetGoods(data.goods, false); MarkDirty(); MessageBox.Show(this, string.Join("\r\n\r\n", messages), "型号核验结果"); Status("已完成核验；未确认的参数保持原样。"); } finally { request.Dispose(); request = null; Busy(false); } }
        void ShowMaterials() { if (materialsPanel != null) materialsPanel.Reload(); tabs.SelectedIndex = 4; }
        void OpenImages(string[] paths, bool paste) { if (busy || !EnsureApi(true)) return; try { using (var dialog = new ImageDialog(api, paths, paste)) if (dialog.ShowDialog(this) == DialogResult.OK) { foreach (var kv in dialog.Result.fields) if (!string.IsNullOrWhiteSpace(kv.Value) || dialog.Result.conflicts.Contains(kv.Key)) boxes[kv.Key].Text = kv.Value; if (dialog.Result.goods.Count > 0) SetGoods(dialog.Result.goods, dialog.Append && ReadData().goods.Count > 0); RefreshLibrary(); MarkDirty(); Status("已导入乙方资料及" + dialog.Result.goods.Count + "项货物，请检查后生成合同。"); } } catch (Exception e) { Ui.Error(this, e); } }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData) { if (keyData == (Keys.Control | Keys.V) && !busy && (Clipboard.ContainsImage() || Clipboard.ContainsFileDropList())) { OpenImages(null, true); return true; } return base.ProcessCmdKey(ref msg, keyData); }
        public bool TestFixedControls() { return TemplateRules.FixedFields.All(kv => boxes[kv.Key].ReadOnly && !boxes[kv.Key].TabStop && boxes[kv.Key].Text == kv.Value) && !boxes.ContainsKey("合同编号"); }
        public void TestCapture(string folder) { LoadData(ContractEngine.Sample()); Show(); Application.DoEvents(); for (int i = 0; i < tabs.TabCount; i++) { tabs.SelectedIndex = i; Application.DoEvents(); using (var bmp = new Bitmap(Width, Height)) { DrawToBitmap(bmp, new Rectangle(Point.Empty, Size)); bmp.Save(Path.Combine(folder, "desktop-tab-" + i + ".png")); } } Hide(); Clean(); }
        public void TestCompactCapture(string folder) { Size = MinimumSize; Show(); Application.DoEvents(); tabs.SelectedIndex = 0; using (var bmp = new Bitmap(Width, Height)) { DrawToBitmap(bmp, new Rectangle(Point.Empty, Size)); bmp.Save(Path.Combine(folder, "compact.png")); } Hide(); Clean(); }
    }
    public class ApiDialog : XpForm
    {
        public ApiSettings Settings { get; private set; }
        readonly TextBox url, model, vision, key; readonly CheckBox remember; CancellationTokenSource request;
        public ApiDialog(ApiSettings initial)
        {
            Text = "API 设置 - DeepSeek"; ClientSize = new Size(700, 600); MinimumSize = new Size(650, 550); AllowResize = true; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
            var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true }; var stack = Ui.Stack(); scroll.Controls.Add(stack); Controls.Add(scroll); stack.Controls.Add(Ui.Note("已适配DeepSeek：deepseek-flash同时用于截图识别和合同说明。也可填写其他兼容接口。"));
            var deepseekPreset = Ui.Button("一键填写DeepSeek地址和模型", null, false); stack.Controls.Add(deepseekPreset);
            url = Ui.Field(stack, "接口地址（根地址、/v1 或完整 /chat/completions 地址）", 32); model = Ui.Field(stack, "文字模型名称 *", 32); vision = Ui.Field(stack, "图片模型名称（可选，留空则使用文字模型）", 32); key = Ui.Field(stack, "API Key（本地无密钥接口可留空）", 32); key.UseSystemPasswordChar = true; url.Text = initial.url; model.Text = initial.model; vision.Text = initial.visionModel; key.Text = initial.key;
            deepseekPreset.Click += delegate { url.Text = "https://api.deepseek.com"; model.Text = vision.Text = "deepseek-flash"; };
            remember = new CheckBox { Text = "记住设置（密钥由Windows加密保存在本机）", Checked = true, AutoSize = true, Margin = new Padding(0, 3, 0, 12) }; stack.Controls.Add(remember);
            var row = Ui.Flow(); var test = Ui.Button("测试连接", null, false); var label = Ui.Note(""); test.Click += async delegate { test.Enabled = false; request = new CancellationTokenSource(); label.Text = "正在连接…"; try { await AiService.Complete(Read(), "只回复：连接成功", "测试API连接", false, request.Token); if (!IsDisposed) label.Text = "文字接口连接成功"; } catch (Exception e) { if (!IsDisposed) label.Text = e.Message; } finally { if (!IsDisposed) test.Enabled = true; } }; row.Controls.Add(test); var visionTest = Ui.Button("测试图片接口", null, false); visionTest.Click += async delegate { visionTest.Enabled = false; request = new CancellationTokenSource(); label.Text = "正在测试合成图片…"; try { using (var bitmap = new Bitmap(250, 75)) using (var memory = new MemoryStream()) { using (var graphics = Graphics.FromImage(bitmap)) { graphics.Clear(Color.White); graphics.DrawString("TEST 23", new Font("Arial", 24), Brushes.Black, 8, 10); } bitmap.Save(memory, ImageFormat.Png); var content = new object[] { new { type = "text", text = "读取图中字符" }, new { type = "image_url", image_url = new { url = "data:image/png;base64," + Convert.ToBase64String(memory.ToArray()) } } }; string result = await AiService.Complete(Read(), "这是合成图片连接测试。", content, true, request.Token); if (!IsDisposed) label.Text = "图片接口返回：" + result; } } catch (Exception e) { if (!IsDisposed) label.Text = e.Message; } finally { if (!IsDisposed) visionTest.Enabled = true; } }; row.Controls.Add(visionTest); row.Controls.Add(Ui.Button("保存设置", delegate { try { Settings = Read(); Settings.Validate(false); if (remember.Checked) ApiStore.Save(Settings, ApiStore.DefaultPath); DialogResult = DialogResult.OK; } catch (Exception e) { Ui.Error(this, e); } }, true)); row.Controls.Add(Ui.Button("取消", delegate { DialogResult = DialogResult.Cancel; }, false)); stack.Controls.Add(row); stack.Controls.Add(label); FormClosing += delegate { if (request != null) request.Cancel(); };
        }
        ApiSettings Read() { return new ApiSettings { url = url.Text.Trim(), model = model.Text.Trim(), visionModel = vision.Text.Trim(), key = key.Text.Trim() }; }
    }
    public class DraftDialog : XpForm
    {
        public DraftResult Result { get; private set; }
        public DraftDialog(DraftResult draft)
        {
            Text = "检查AI生成的说明"; ClientSize = new Size(830, 700); MinimumSize = new Size(680, 600); MinimizeBox = false; MaximizeBox = false; StartPosition = FormStartPosition.CenterParent;
            var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true }; var s = Ui.Stack(); scroll.Controls.Add(s); Controls.Add(scroll); s.Controls.Add(Ui.Note("仅写入第一节及第四节第2项；技术说明由已有资料和归档参数整理。" + (draft.warning ?? ""))); var title = Ui.Field(s, "合同名称", 32); var overview = Ui.Field(s, "采购项目概况", 170); var technical = Ui.Field(s, "技术或用途说明", 220); title.Text = draft.title ?? ""; overview.Text = draft.overview ?? ""; technical.Text = draft.technical ?? ""; if (draft.specifications != null) { var parameterPreview = Ui.Field(s, "按型号填入技术表的参数（不会重复附加到补充说明）", 170); parameterPreview.ReadOnly = true; parameterPreview.Text = string.Join("\r\n\r\n", draft.specifications.Select(r => r.model + "（" + r.status + "）\r\n" + (r.specification == "" ? "暂无精确型号资料，不猜填" : r.specification))); } var row = Ui.Flow(); row.Controls.Add(Ui.Button("填入合同", delegate { Result = new DraftResult { title = title.Text.Trim(), overview = overview.Text.Trim(), technical = technical.Text.Trim(), specifications = draft.specifications }; DialogResult = DialogResult.OK; }, true)); row.Controls.Add(Ui.Button("取消", delegate { DialogResult = DialogResult.Cancel; }, false)); s.Controls.Add(row);
        }
    }
    public class ImageDialog : XpForm
    {
        readonly ApiSettings api; readonly List<byte[]> images = new List<byte[]>(); readonly ListBox files = new ListBox { Dock = DockStyle.Fill };
        readonly PictureBox picture = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, BackColor = SystemColors.AppWorkspace };
        readonly TabControl pages = new XpTabs { Dock = DockStyle.Fill }; readonly Label status = Ui.Note("可连续粘贴，也可一次选择多张图片。乙方资料和货物表格可以混合添加。");
        readonly Dictionary<string, ComboBox> fields = new Dictionary<string, ComboBox>(); readonly DataGridView rows = Ui.Grid();
        readonly CheckBox append = new CheckBox { Text = "追加货物（取消则替换清单）", Checked = true, AutoSize = true }, archive = new CheckBox { Text = "将图片存入文件库供查阅", Checked = true, AutoSize = true };
        readonly Button recognize, apply; CancellationTokenSource request; bool testing;
        public BatchResult Result { get; private set; } public bool Append { get { return append.Checked; } }
        public ImageDialog(ApiSettings api, string path, bool paste) : this(api, path == null ? null : new[] { path }, paste) { }
        public ImageDialog(ApiSettings api, string[] paths, bool paste)
        {
            this.api = api; Text = "批量智能导入 · 乙方资料与货物"; ClientSize = new Size(1060, 760); MinimumSize = new Size(940, 680); StartPosition = FormStartPosition.CenterParent; AllowDrop = true;
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(10) }; root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 65)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); Controls.Add(root);
            var bar = Ui.Flow(); bar.Controls.Add(Ui.Button("添加多张图片", Choose, false)); bar.Controls.Add(Ui.Button("粘贴 Ctrl+V", Paste, false)); bar.Controls.Add(Ui.Button("移除选中图片", delegate { if (request != null || files.SelectedIndex < 0) return; int n = files.SelectedIndex; images.RemoveAt(n); files.Items.RemoveAt(n); InvalidateResult(); }, false)); recognize = Ui.Button("智能识别全部", null, true); recognize.Click += async delegate { await Recognize(); }; bar.Controls.Add(recognize); bar.Controls.Add(Ui.Button("查看识别依据", delegate { if (Result == null) return; using (var source = new XpForm { Text = "识别依据 · 请对照原图", ClientSize = new Size(780, 500), StartPosition = FormStartPosition.CenterParent }) { source.Controls.Add(new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, BackColor = Color.White, ScrollBars = ScrollBars.Vertical, Text = string.Join("\r\n\r\n", Result.candidates.Select(c => "图片" + c.image + " · " + c.field + "：" + c.value + "\r\n原文：" + c.quote).Concat(Result.evidence.Select(e => "识别时货物第" + e.row + "行，图片" + e.image + "\r\n数量原文：" + e.qty_quote + "\r\n单价原文：" + e.price_quote + "\r\n币种原文：" + e.currency_quote + "；含税：" + e.tax_included))) }); source.ShowDialog(this); } }, false)); root.Controls.Add(bar, 0, 0);
            var imagePage = new TabPage("1. 添加图片"); var split = new SplitContainer { Dock = DockStyle.Fill, Width = 1000, SplitterDistance = 210 }; split.Panel1.Controls.Add(files); split.Panel2.Controls.Add(picture); imagePage.Controls.Add(split); pages.TabPages.Add(imagePage);
            var reviewPage = new TabPage("2. 核对并填入"); var review = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(8) }; review.RowStyles.Add(new RowStyle(SizeType.Absolute, 150)); review.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); review.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            var party = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4 }; party.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90)); party.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            foreach (string key in BatchImport.PartyKeys) { var box = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDown, Margin = new Padding(2, 3, 2, 5) }; fields[key] = box; party.Controls.Add(new Label { Text = key, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }); party.Controls.Add(box); } review.Controls.Add(party, 0, 0);
            foreach (var c in new[] { new[] { "name", "货物名称", "150" }, new[] { "model", "品牌型号", "180" }, new[] { "qty", "数量", "60" }, new[] { "unit", "单位", "50" }, new[] { "price", "含税单价(元)", "110" }, new[] { "spec", "图片中的参数", "200" } }) Ui.Column(rows, c[0], c[1], int.Parse(c[2]), false); review.Controls.Add(rows, 0, 1); review.Controls.Add(append, 0, 2); reviewPage.Controls.Add(review); pages.TabPages.Add(reviewPage); root.Controls.Add(pages, 0, 1); status.Dock = DockStyle.Fill; status.AutoSize = false; root.Controls.Add(status, 0, 2);
            var bottom = Ui.Flow(); bottom.Controls.Add(archive); apply = Ui.Button("确认填入合同", Apply, true); apply.Enabled = false; bottom.Controls.Add(apply); bottom.Controls.Add(Ui.Button("关闭 / 取消识别", delegate { if (request != null) request.Cancel(); else Close(); }, false)); root.Controls.Add(bottom, 0, 3);
            files.SelectedIndexChanged += delegate { if (picture.Image != null) { picture.Image.Dispose(); picture.Image = null; } if (files.SelectedIndex >= 0) using (var m = new MemoryStream(images[files.SelectedIndex])) using (var src = Image.FromStream(m)) picture.Image = new Bitmap(src); };
            DragEnter += delegate(object sender, DragEventArgs e) { if (request == null && e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy; }; DragDrop += delegate(object sender, DragEventArgs e) { AddPaths(e.Data.GetData(DataFormats.FileDrop) as string[]); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (request != null) { request.Cancel(); e.Cancel = true; status.Text = "正在取消识别…"; } }; FormClosed += delegate { if (picture.Image != null) picture.Image.Dispose(); };
            if (paths != null) AddPaths(paths); if (paste) Paste();
        }
        void InvalidateResult() { Result = null; apply.Enabled = false; status.Text = "已添加" + images.Count + "张图片。点击智能识别全部，图片将发送至：" + api.url; }
        void Add(byte[] png, string name) { if (request != null) return; if (images.Count >= 60) throw new Exception("一次最多60张图片。"); string hash = AppStorage.Hash(png); if (images.Any(b => AppStorage.Hash(b) == hash)) { status.Text = "相同图片已存在，未重复添加。"; return; } images.Add(png); files.Items.Add((images.Count) + ". " + name); files.SelectedIndex = images.Count - 1; InvalidateResult(); }
        void AddPaths(string[] paths) { if (paths == null || request != null) return; var errors = new List<string>(); foreach (string path in paths) try { Add(BatchImport.Load(path), Path.GetFileName(path)); } catch (Exception e) { errors.Add(Path.GetFileName(path) + "：" + e.Message); } if (errors.Count > 0) MessageBox.Show(this, string.Join("\r\n", errors), "部分图片未添加"); }
        void Choose() { using (var f = new OpenFileDialog { Multiselect = true, Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp" }) if (f.ShowDialog(this) == DialogResult.OK) AddPaths(f.FileNames); }
        void Paste() { if (request != null) return; try { if (Clipboard.ContainsFileDropList()) AddPaths(Clipboard.GetFileDropList().Cast<string>().ToArray()); else if (Clipboard.ContainsImage()) using (var image = Clipboard.GetImage()) Add(BatchImport.Png(image), "剪贴板图片"); else status.Text = "剪贴板中没有图片。可先截图，再连续按Ctrl+V添加。"; } catch (Exception e) { Ui.Error(this, e); } }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData) { if (keyData == (Keys.Control | Keys.V) && (Clipboard.ContainsImage() || Clipboard.ContainsFileDropList())) { Paste(); return true; } return base.ProcessCmdKey(ref msg, keyData); }
        async Task Recognize() { if (images.Count == 0) { Choose(); if (images.Count == 0) return; } recognize.Enabled = apply.Enabled = false; request = new CancellationTokenSource(); try { Result = await BatchImport.Recognize(api, images, request.Token, new Progress<string>(s => status.Text = s)); foreach (string key in BatchImport.PartyKeys) { fields[key].Items.Clear(); foreach (string v in Result.candidates.Where(c => c.field == key).Select(c => c.value).Distinct()) fields[key].Items.Add(v); fields[key].Text = Result.fields.ContainsKey(key) ? Result.fields[key] : ""; fields[key].BackColor = Result.conflicts.Contains(key) ? Color.LemonChiffon : Color.White; } rows.Rows.Clear(); foreach (var g in Result.goods) rows.Rows.Add(g.name, g.model, g.qty, g.unit, g.price, g.spec); pages.SelectedIndex = 1; status.Text = Result.warnings.Count == 0 ? "识别完成。请核对乙方资料、数量和单价，再确认填入。" : string.Join("；", Result.warnings); if (Result.warnings.Count > 0 && !testing) MessageBox.Show(this, string.Join("\r\n", Result.warnings), "请核对识别结果"); apply.Enabled = true; } catch (Exception e) { status.Text = e.Message; } finally { recognize.Enabled = true; request.Dispose(); request = null; } }
        void Apply() { if (Result == null || request != null) return; rows.EndEdit(); foreach (string key in BatchImport.PartyKeys) Result.fields[key] = fields[key].Text.Trim(); Result.goods = rows.Rows.Cast<DataGridViewRow>().Where(r => !r.IsNewRow).Select(r => new Good { name = Ui.Cell(r, "name"), model = Ui.Cell(r, "model"), qty = Ui.Cell(r, "qty"), unit = Ui.Cell(r, "unit"), price = Ui.Cell(r, "price"), spec = Ui.Cell(r, "spec") }).ToList(); if (archive.Checked) try { string folder = Path.Combine(AppStorage.Root, "ImportedImages"); Directory.CreateDirectory(folder); foreach (byte[] png in images) { string path = Path.Combine(folder, AppStorage.Hash(png).Substring(0, 12) + ".png"); File.WriteAllBytes(path, png); ContractLibrary.Import(path, null); } } catch (Exception e) { status.Text = "图片归档失败：" + e.Message; return; } DialogResult = DialogResult.OK; }
        public Task TestRecognize() { testing = true; return Recognize(); }
        public void TestApply() { archive.Checked = false; Apply(); }
        public int TestImageCount { get { return images.Count; } }
        public void TestAdd(byte[] png, string name) { Add(png, name); }
    }
}
