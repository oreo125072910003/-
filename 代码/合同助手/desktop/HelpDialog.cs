using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace ContractHelper
{
    public class HelpDialog : XpForm
    {
        readonly TabControl tabs = new XpTabs { Dock = DockStyle.Fill };
        readonly List<TextBox> readers = new List<TextBox>();
        public HelpDialog(int topic)
        {
            Text = "帮助与内置文档 - 合同填写小助手"; ClientSize = new Size(900, 700); MinimumSize = new Size(720, 540); StartPosition = FormStartPosition.CenterParent;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) }; layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); Controls.Add(layout);
            for (int i = 0; i < EmbeddedContent.Titles.Length; i++)
            {
                var page = new TabPage(EmbeddedContent.Titles[i]) { BackColor = Xp.Face, Padding = new Padding(8) };
                var text = new TextBox { Dock = DockStyle.Fill, ReadOnly = true, BackColor = Color.White, BorderStyle = BorderStyle.Fixed3D, Font = new Font("宋体", 11), Multiline = true, ForeColor = Color.Black, ScrollBars = ScrollBars.Vertical, Text = EmbeddedContent.Read(i) };
                text.Select(0, 0); readers.Add(text); page.Controls.Add(text); tabs.TabPages.Add(page);
            }
            layout.Controls.Add(tabs, 0, 0); tabs.SelectedIndex = Math.Max(0, Math.Min(topic, tabs.TabCount - 1));
            var actions = Ui.Flow(); actions.Padding = new Padding(0, 7, 0, 0); actions.Controls.Add(Ui.Button("复制当前说明", delegate { Clipboard.SetText(readers[tabs.SelectedIndex].Text); }, false)); var close = Ui.Button("关闭", Close, true); actions.Controls.Add(close); layout.Controls.Add(actions, 0, 1); AcceptButton = CancelButton = close;
        }
        public static void Test(string folder)
        {
            Directory.CreateDirectory(folder); var checks = new List<string>();
            try
            {
                for (int i = 0; i < EmbeddedContent.Titles.Length; i++) if (EmbeddedContent.Read(i).Length < 100) throw new Exception("内置说明缺失。");
                if (AppStorage.Hash(ContractEngine.Resource("reference.docx")) != TemplateRules.ReferenceHash || Encoding.ASCII.GetString(ContractEngine.Resource("reference.pdf"), 0, 5) != "%PDF-") throw new Exception("内置参考合同不完整。");
                AppStorage.OverrideRoot = Path.Combine(folder, "library-test-" + Guid.NewGuid().ToString("N")); EmbeddedContent.EnsureLibrary(); EmbeddedContent.EnsureLibrary();
                if (ContractLibrary.Search("", "template").Count != 5 || MaterialCatalog.List().Count != 99) throw new Exception("内置模板、范例或99个型号资料入库失败。");
                using (var dialog = new HelpDialog(0))
                {
                    dialog.Show(); Application.DoEvents();
                    for (int i = 0; i < EmbeddedContent.Titles.Length; i++) { dialog.tabs.SelectedIndex = i; Application.DoEvents(); using (var bmp = new Bitmap(dialog.Width, dialog.Height)) { dialog.DrawToBitmap(bmp, new Rectangle(Point.Empty, dialog.Size)); bmp.Save(Path.Combine(folder, "help-" + i + ".png")); } }
                    dialog.Hide();
                }
                checks.Add("四份说明内置读取，无外部TXT依赖"); checks.Add("参考Word原件哈希一致、参考PDF内置、首次入库及重复运行去重"); checks.Add("XP原生帮助窗口四个页签正常显示");
                File.WriteAllText(Path.Combine(folder, "help-test-results.json"), ContractEngine.Json().Serialize(new { passed = true, checks }), Encoding.UTF8);
            }
            catch (Exception e) { File.WriteAllText(Path.Combine(folder, "help-test-failed.txt"), e.ToString(), Encoding.UTF8); Environment.ExitCode = 1; }
        }
    }
}
