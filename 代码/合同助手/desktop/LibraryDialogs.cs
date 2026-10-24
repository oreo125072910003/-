using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace ContractHelper
{
    public class RecordChoice
    {
        public string Id, Label; public override string ToString() { return Label; }
        public RecordChoice(string id, string label) { Id = id; Label = label; }
    }
    public class MaterialEditor : XpForm
    {
        public MaterialRecord Result;
        public MaterialEditor(MaterialRecord original)
        {
            Text = original == null ? "新增材料型号" : "编辑材料型号"; ClientSize = new Size(750, 720); MinimumSize = new Size(640, 600); StartPosition = FormStartPosition.CenterParent;
            var panel = new Panel { Dock = DockStyle.Fill, AutoScroll = true }; var s = Ui.Stack(); panel.Controls.Add(s); Controls.Add(panel);
            var r = original == null ? new MaterialRecord() : ContractEngine.Json().Deserialize<MaterialRecord>(ContractEngine.Json().Serialize(original));
            var model = Ui.Field(s, "完整型号 *（保留原后缀，不自动改成相近型号）", 30); model.Text = r.model;
            var name = Ui.Field(s, "材料名称", 30); name.Text = r.name;
            var brand = Ui.Field(s, "品牌（不同品牌可有相同型号）", 30); brand.Text = r.brand;
            var category = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDown, Height = 30 };
            category.Items.AddRange(new object[] { "偏振光学", "光纤与耦合", "光电探测", "光学元件", "调制器件", "光机械及附件", "未分类" });
            s.Controls.Add(Ui.Note("材料分类（可自行填写）")); s.Controls.Add(category); category.Text = r.category;
            var spec = Ui.Field(s, "参数描述 *（只填写有依据的值、单位和条件）", 150); spec.Text = r.specification;
            var source = Ui.Field(s, "资料来源（文件或网址）", 30); source.Text = r.source;
            var notes = Ui.Field(s, "备注", 55); notes.Text = r.notes;
            s.Controls.Add(Ui.Note("手工保存后标为“用户录入”；原来源记录仍保留，不会冒称官网核验。"));
            var actions = Ui.Flow(); actions.Controls.Add(Ui.Button("保存材料", delegate { try { r.model = model.Text; r.name = name.Text; r.brand = brand.Text; r.category = category.Text; r.specification = spec.Text; r.source = source.Text; r.notes = notes.Text; Result = MaterialCatalog.Save(r); DialogResult = DialogResult.OK; } catch (Exception e) { Ui.Error(this, e); } }, true)); actions.Controls.Add(Ui.Button("取消", delegate { DialogResult = DialogResult.Cancel; }, false)); s.Controls.Add(actions);
        }
    }
    public class MaterialPanel : UserControl
    {
        readonly DataGridView grid = Ui.Grid(); readonly TextBox query = new TextBox(), details = new TextBox();
        readonly ComboBox brands = new ComboBox(), categories = new ComboBox(); readonly CheckBox exact = new CheckBox { Text = "完整型号", AutoSize = true };
        readonly Label count = Ui.Note(""); readonly Action<MaterialRecord> use; bool refreshing;
        public MaterialPanel(Action<MaterialRecord> use)
        {
            this.use = use; Dock = DockStyle.Fill; BackColor = Xp.Face;
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(10) }; root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); Controls.Add(root);
            var bar = Ui.Flow(); query.Width = 230; brands.Width = 145; categories.Width = 145; brands.DropDownStyle = categories.DropDownStyle = ComboBoxStyle.DropDownList;
            bar.Controls.Add(Ui.Note("型号/关键词")); bar.Controls.Add(query); bar.Controls.Add(brands); bar.Controls.Add(categories); bar.Controls.Add(exact); bar.Controls.Add(Ui.Button("查询", RefreshRows, false)); root.Controls.Add(bar, 0, 0);
            var split = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, Height = 540, SplitterDistance = 315, Panel1MinSize = 140, Panel2MinSize = 100 };
            grid.ReadOnly = true; grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = false; grid.MultiSelect = false; grid.RowHeadersVisible = false;
            Ui.Column(grid, "brand", "品牌", 100, true); Ui.Column(grid, "model", "完整型号", 180, true); Ui.Column(grid, "name", "材料名称", 190, true); Ui.Column(grid, "category", "分类", 110, true); Ui.Column(grid, "status", "来源状态", 95, true);
            split.Panel1.Controls.Add(grid); details.Dock = DockStyle.Fill; details.ReadOnly = true; details.Multiline = true; details.ScrollBars = ScrollBars.Vertical; details.BackColor = Color.White; split.Panel2.Controls.Add(details); root.Controls.Add(split, 0, 1);
            grid.SelectionChanged += delegate { ShowRecord(); }; grid.CellDoubleClick += delegate { Edit(); };
            var actions = Ui.Flow(); actions.Controls.Add(Ui.Button("新增材料", delegate { using (var d = new MaterialEditor(null)) if (d.ShowDialog(this) == DialogResult.OK) Reload(); }, false)); actions.Controls.Add(Ui.Button("编辑描述", Edit, false)); actions.Controls.Add(Ui.Button("删除材料", Delete, false)); actions.Controls.Add(Ui.Button("导入Excel清单", Import, false)); actions.Controls.Add(Ui.Button("打开来源", OpenSource, false));
            if (use != null) actions.Controls.Add(Ui.Button("填入货物清单", delegate { var r = Selected(); if (r != null) use(r); }, true)); root.Controls.Add(actions, 0, 2); root.Controls.Add(count, 0, 3);
            query.TextChanged += delegate { RefreshRows(); }; brands.SelectedIndexChanged += delegate { RefreshRows(); }; categories.SelectedIndexChanged += delegate { RefreshRows(); }; exact.CheckedChanged += delegate { RefreshRows(); }; Reload();
        }
        public void Reload()
        {
            refreshing = true; string brand = Convert.ToString(brands.SelectedItem), category = Convert.ToString(categories.SelectedItem); var list = MaterialCatalog.List();
            brands.Items.Clear(); brands.Items.Add("全部品牌"); brands.Items.AddRange(list.Select(r => r.brand).Distinct().OrderBy(v => v).Cast<object>().ToArray()); categories.Items.Clear(); categories.Items.Add("全部分类"); categories.Items.AddRange(list.Select(r => r.category).Distinct().OrderBy(v => v).Cast<object>().ToArray());
            brands.SelectedIndex = Math.Max(0, brands.Items.IndexOf(brand)); categories.SelectedIndex = Math.Max(0, categories.Items.IndexOf(category)); refreshing = false; RefreshRows();
        }
        void RefreshRows() { if (refreshing) return; grid.Rows.Clear(); var rows = MaterialCatalog.Search(query.Text.Trim(), brands.SelectedIndex > 0 ? brands.Text : "", categories.SelectedIndex > 0 ? categories.Text : "", exact.Checked); foreach (var r in rows) { int n = grid.Rows.Add(r.brand, r.model, r.name, r.category, r.status); grid.Rows[n].Tag = r; } if (grid.Rows.Count > 0) grid.CurrentCell = grid.Rows[0].Cells[0]; count.Text = "找到 " + rows.Count + " 条。填入只带材料名称、品牌、型号和参数；本次数量、单位及价格另填。"; ShowRecord(); }
        MaterialRecord Selected() { return grid.CurrentRow == null ? null : grid.CurrentRow.Tag as MaterialRecord; }
        void ShowRecord() { var r = Selected(); details.Text = r == null ? "输入完整型号或关键词，选择品牌和分类即可查询。" : r.model + "　" + r.brand + "　" + r.status + "\r\n\r\n" + r.specification + "\r\n\r\n来源：" + r.source + "\r\n" + r.notes + "\r\n\r\n来源记录：\r\n" + string.Join("\r\n\r\n", r.evidence.Select(e => e.status + "　" + e.location + "\r\n" + e.source + "\r\n" + e.specification)); }
        void Edit() { var r = Selected(); if (r == null) return; using (var d = new MaterialEditor(r)) if (d.ShowDialog(this) == DialogResult.OK) Reload(); }
        void Delete() { var r = Selected(); if (r == null) return; if (MessageBox.Show(this, "从型号库移除 " + r.model + "？来源文件和已有合同保留，记录备份保存在本机回收目录。", "删除材料", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) { MaterialCatalog.Delete(r.id); Reload(); } }
        void OpenSource() { var r = Selected(); if (r == null || string.IsNullOrWhiteSpace(r.source)) return; try { Uri uri; if (File.Exists(r.source) || Uri.TryCreate(r.source, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http")) Process.Start(new ProcessStartInfo(r.source) { UseShellExecute = true }); else throw new Exception("来源文件暂不可访问，可在下方查看已归档的参数原文。"); } catch (Exception e) { Ui.Error(this, e); } }
        void Import()
        {
            using (var file = new OpenFileDialog { Filter = "Excel采购清单|*.xlsx" }) if (file.ShowDialog(this) == DialogResult.OK) using (var dialog = new XpForm { Text = "导入型号参数", ClientSize = new Size(510, 230), StartPosition = FormStartPosition.CenterParent }) {
                var s = Ui.Stack(); dialog.Controls.Add(s); s.Controls.Add(Ui.Note("读取完整型号和参数列，不导入旧价格、数量或折扣。")); var brand = Ui.Field(s, "本清单品牌（不确定可留空，之后编辑）", 30);
                var row = Ui.Flow(); row.Controls.Add(Ui.Button("导入并保留来源", delegate { try { var result = ContractEngine.Json().Deserialize<Dictionary<string, object>>(ContractEngine.Json().Serialize(MaterialImport.ImportWorkbook(file.FileName, brand.Text.Trim()))); MessageBox.Show(dialog, "已读取" + result["source_rows"] + "行，共" + result["unique_models"] + "个型号。新增" + result["added"] + "条，其余来源已合并；已有参数描述保留。", "导入完成"); dialog.DialogResult = DialogResult.OK; Reload(); } catch (Exception e) { Ui.Error(dialog, e); } }, true)); row.Controls.Add(Ui.Button("取消", delegate { dialog.Close(); }, false)); s.Controls.Add(row); dialog.ShowDialog(this);
            }
        }
    }
    public class LibraryPanel : UserControl
    {
        readonly string category; readonly DataGridView grid = Ui.Grid(); readonly TextBox query = new TextBox(), details = new TextBox(); readonly Action<LibraryEntry> use;
        public LibraryPanel(string category, Action<LibraryEntry> use)
        {
            this.category = category; this.use = use; Dock = DockStyle.Fill;
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(10) }; root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); Controls.Add(root);
            var bar = Ui.Flow(); query.Width = 280; bar.Controls.Add(query); bar.Controls.Add(Ui.Button(category == "template" ? "导入模板或范例" : "导入已有合同", Import, false)); bar.Controls.Add(Ui.Button("刷新", Reload, false)); bar.Controls.Add(Ui.Button("回收站", Recycle, false)); root.Controls.Add(bar, 0, 0);
            var split = new SplitContainer { Dock = DockStyle.Fill, Width = 1000, SplitterDistance = 520 }; grid.ReadOnly = true; grid.AllowUserToAddRows = grid.AllowUserToDeleteRows = false; grid.RowHeadersVisible = false; grid.MultiSelect = false;
            Ui.Column(grid, "name", "文件名称", 230, true); Ui.Column(grid, "kind", "类型", 55, true); Ui.Column(grid, "role", "用途", 90, true); split.Panel1.Controls.Add(grid); details.Dock = DockStyle.Fill; details.ReadOnly = true; details.Multiline = true; details.ScrollBars = ScrollBars.Vertical; details.BackColor = Color.White; split.Panel2.Controls.Add(details); root.Controls.Add(split, 0, 1);
            var actions = Ui.Flow(); actions.Controls.Add(Ui.Button("打开 / Word编辑", delegate { try { var e = Selected(); if (e != null) ContractLibrary.Open(e.id); } catch (Exception ex) { Ui.Error(this, ex); } }, false)); actions.Controls.Add(Ui.Button("名称与参考设置", Edit, false)); actions.Controls.Add(Ui.Button("替换库内文件", Replace, false)); actions.Controls.Add(Ui.Button("删除", Delete, false)); actions.Controls.Add(Ui.Button(category == "template" ? "用于当前合同" : "继续填写进度", delegate { var e = Selected(); if (e != null && use != null) use(e); }, true)); root.Controls.Add(actions, 0, 2);
            query.TextChanged += delegate { Reload(); }; grid.SelectionChanged += delegate { ShowRecord(); }; Reload();
        }
        LibraryEntry Selected() { return grid.CurrentRow == null ? null : grid.CurrentRow.Tag as LibraryEntry; }
        public void Reload() { grid.Rows.Clear(); foreach (var stored in ContractLibrary.Search(query.Text, category)) { var e = ContractLibrary.ReadCurrent(stored.id); int n = grid.Rows.Add(e.name, e.kind, e.role == "fillable" ? "生成模板" : category == "template" ? "参考范例" : "已生成"); grid.Rows[n].Tag = e; } if (grid.Rows.Count > 0) grid.CurrentCell = grid.Rows[0].Cells[0]; ShowRecord(); }
        void ShowRecord() { var e = Selected(); details.Text = e == null ? (category == "template" ? "存放生成模板和写作范例。参考范例不会自动改写固定条款。" : "生成的合同保存在这里，可关联模板或范例。") : e.name + "\r\n" + e.notes + "\r\n参考模板：" + Relation(e.template_id) + "\r\n写作参考：" + Relation(e.reference_id) + "\r\n\r\n" + e.text; }
        static string Relation(string id) { if (string.IsNullOrWhiteSpace(id)) return "未指定"; try { return ContractLibrary.Get(id).name; } catch { return "原参考已移出库，已有合同保留"; } }
        void Import() { using (var f = new OpenFileDialog { Multiselect = true, Filter = "合同或参考资料|*.docx;*.pdf;*.json;*.png;*.jpg;*.jpeg;*.bmp" }) if (f.ShowDialog(this) == DialogResult.OK) { var errors = new List<string>(); foreach (string path in f.FileNames) try { string role = "reference"; if (category == "template" && Path.GetExtension(path).ToLowerInvariant() == ".docx") try { ContractEngine.ValidateTemplate(ContractEngine.AdaptTemplate(File.ReadAllBytes(path))); role = "fillable"; } catch { } ContractLibrary.Import(path, null, category, role); } catch (Exception e) { errors.Add(e.Message); } Reload(); if (errors.Count > 0) MessageBox.Show(this, string.Join("\r\n", errors)); } }
        void Edit()
        {
            var e = Selected(); if (e == null) return;
            using (var f = new XpForm { Text = "文件名称与参考设置", ClientSize = new Size(660, 490), StartPosition = FormStartPosition.CenterParent }) {
                var s = Ui.Stack(); f.Controls.Add(s); var name = Ui.Field(s, "文件名称", 30); name.Text = e.name; var notes = Ui.Field(s, "说明", 75); notes.Text = e.notes;
                var type = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList }; type.Items.AddRange(new object[] { "生成库", "模板库" }); type.SelectedIndex = e.category == "template" ? 1 : 0; s.Controls.Add(Ui.Note("所属文件库")); s.Controls.Add(type);
                var template = Choices(e.template_id, false); var reference = Choices(e.reference_id, true); s.Controls.Add(Ui.Note("生成模板")); s.Controls.Add(template); s.Controls.Add(Ui.Note("写作参考范例")); s.Controls.Add(reference);
                var row = Ui.Flow(); row.Controls.Add(Ui.Button("保存", delegate { try { ContractLibrary.Update(e.id, name.Text.Trim(), notes.Text, type.SelectedIndex == 1 ? "template" : "generated", ((RecordChoice)template.SelectedItem).Id, null, ((RecordChoice)reference.SelectedItem).Id); f.DialogResult = DialogResult.OK; Reload(); } catch (Exception ex) { Ui.Error(f, ex); } }, true)); row.Controls.Add(Ui.Button("取消", delegate { f.Close(); }, false)); s.Controls.Add(row); f.ShowDialog(this);
            }
        }
        public static ComboBox Choices(string selected, bool references)
        {
            var c = new ComboBox { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList }; c.Items.Add(new RecordChoice("", "不指定")); foreach (var e in ContractLibrary.Search("", "template").Where(v => references ? v.role != "fillable" : v.role == "fillable")) c.Items.Add(new RecordChoice(e.id, e.name)); c.SelectedIndex = 0; for (int i = 1; i < c.Items.Count; i++) if (((RecordChoice)c.Items[i]).Id == selected) c.SelectedIndex = i; return c;
        }
        void Replace() { var e = Selected(); if (e == null) return; using (var f = new OpenFileDialog { Filter = "同类型文件|*." + e.kind.ToLowerInvariant() }) if (f.ShowDialog(this) == DialogResult.OK) try { ContractLibrary.Update(e.id, null, null, null, null, f.FileName); Reload(); } catch (Exception ex) { Ui.Error(this, ex); } }
        void Delete() { var e = Selected(); if (e == null) return; if (MessageBox.Show(this, "移入文件库回收站？桌面原文件和已生成合同保持原样。", "删除库内文档", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes) { ContractLibrary.Delete(e.id); Reload(); } }
        void Recycle() { using (var f = new XpForm { Text = "文件库回收站", ClientSize = new Size(650, 400), StartPosition = FormStartPosition.CenterParent }) { var list = new ListBox { Dock = DockStyle.Fill }; var actions = Ui.Flow(); actions.Dock = DockStyle.Bottom; actions.Height = 40; foreach (var e in ContractLibrary.Trash()) list.Items.Add(new RecordChoice(e.trash_id, e.name)); actions.Controls.Add(Ui.Button("恢复所选", delegate { if (list.SelectedItem == null) return; ContractLibrary.Restore(((RecordChoice)list.SelectedItem).Id); f.Close(); Reload(); }, true)); f.Controls.Add(list); f.Controls.Add(actions); f.ShowDialog(this); } }
    }
}
