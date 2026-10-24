// 集中绘制XP年代的窗口和控件，不依赖主题包或网页。
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ContractHelper
{
    static class Xp
    {
        public static readonly Color Face = Color.FromArgb(236, 233, 216);
        public static readonly Color Blue = Color.FromArgb(0, 60, 116);
        public static readonly Color Border = Color.FromArgb(127, 157, 185);
        public static Font Font() { return new Font("SimSun", 10f, FontStyle.Regular); }
        public static void Bevel(Graphics g, Rectangle r)
        {
            ControlPaint.DrawBorder(g, r, Color.White, 1, ButtonBorderStyle.Solid, Color.White, 1, ButtonBorderStyle.Solid, Color.FromArgb(128, 128, 128), 1, ButtonBorderStyle.Solid, Color.FromArgb(128, 128, 128), 1, ButtonBorderStyle.Solid);
        }
    }

    // 保留真正的Windows窗口行为，只自行绘制XP蓝色外观。
    public class XpForm : Form
    {
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, int message, IntPtr w, IntPtr l);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        readonly XpTitleBar caption;
        public bool AllowResize { get; set; }
        public XpForm()
        {
            AllowResize = true; FormBorderStyle = FormBorderStyle.None; Padding = new Padding(4, 33, 4, 4);
            BackColor = Xp.Face; Font = Xp.Font(); DoubleBuffered = true;
            caption = new XpTitleBar(this); Controls.Add(caption);
            caption.MouseDown += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); } };
            caption.MouseDoubleClick += delegate(object sender, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ToggleMaximize(); };
        }
        internal void ToggleMaximize()
        { if (MaximizeBox) { MaximizedBounds = Screen.FromControl(this).WorkingArea; WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; } }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e); try { int square = 1; DwmSetWindowAttribute(Handle, 33, ref square, 4); } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
        }
        protected override void OnLayout(LayoutEventArgs e) { base.OnLayout(e); if (caption != null) { caption.SetBounds(3, 3, Math.Max(0, ClientSize.Width - 6), 28); caption.PerformLayout(); } }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); if (caption != null) caption.Invalidate(); }
        protected override void OnActivated(EventArgs e) { base.OnActivated(e); if (caption != null) caption.Invalidate(); }
        protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); if (caption != null) caption.Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        { base.OnPaint(e); using (var pen = new Pen(Color.FromArgb(0, 69, 202), 3)) e.Graphics.DrawRectangle(pen, 1, 1, ClientSize.Width - 3, ClientSize.Height - 3); }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0xA3 && m.WParam == (IntPtr)2 && MaximizeBox) { ToggleMaximize(); return; }
            base.WndProc(ref m);
            if (m.Msg != 0x84 || !AllowResize || WindowState != FormWindowState.Normal) return;
            long coordinates = m.LParam.ToInt64(); Point point = PointToClient(new Point((short)(coordinates & 0xffff), (short)((coordinates >> 16) & 0xffff)));
            bool left = point.X < 5, right = point.X >= Width - 5, top = point.Y < 4, bottom = point.Y >= Height - 5;
            if (left && top) m.Result = (IntPtr)13; else if (right && top) m.Result = (IntPtr)14; else if (left && bottom) m.Result = (IntPtr)16; else if (right && bottom) m.Result = (IntPtr)17;
            else if (left) m.Result = (IntPtr)10; else if (right) m.Result = (IntPtr)11; else if (top) m.Result = (IntPtr)12; else if (bottom) m.Result = (IntPtr)15;
        }
    }

    sealed class XpTitleBar : Panel
    {
        readonly XpForm owner; readonly Button minimize, maximize, close;
        public XpTitleBar(XpForm owner)
        {
            this.owner = owner; DoubleBuffered = true; AccessibleName = "窗口标题栏";
            minimize = new XpCaptionButton(0) { AccessibleName = "最小化" }; maximize = new XpCaptionButton(1) { AccessibleName = "最大化或还原" }; close = new XpCaptionButton(2) { AccessibleName = "关闭" };
            minimize.Click += delegate { owner.WindowState = FormWindowState.Minimized; }; maximize.Click += delegate { owner.ToggleMaximize(); }; close.Click += delegate { owner.Close(); };
            Controls.Add(minimize); Controls.Add(maximize); Controls.Add(close);
        }
        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e); int right = Width - 3; close.SetBounds(right - 23, 2, 23, 23); right -= 26;
            maximize.Visible = owner.MaximizeBox; if (owner.MaximizeBox) { maximize.SetBounds(right - 23, 2, 23, 23); right -= 26; }
            minimize.Visible = owner.MinimizeBox; if (owner.MinimizeBox) minimize.SetBounds(right - 23, 2, 23, 23);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            using (var fill = new LinearGradientBrush(ClientRectangle, Color.FromArgb(59, 151, 255), Color.FromArgb(0, 76, 219), LinearGradientMode.Vertical)) e.Graphics.FillRectangle(fill, ClientRectangle);
            e.Graphics.DrawLine(Pens.LightSkyBlue, 0, 0, Width, 0);
            if (owner.Icon != null) e.Graphics.DrawIcon(owner.Icon, new Rectangle(5, 5, 17, 17));
            var text = new Rectangle(27, 4, Math.Max(0, Width - 118), 22);
            using (var font = new Font("Tahoma", 10, FontStyle.Bold))
            { TextRenderer.DrawText(e.Graphics, owner.Text, font, new Rectangle(text.X + 1, text.Y + 1, text.Width, text.Height), Color.FromArgb(0, 42, 129), TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix); TextRenderer.DrawText(e.Graphics, owner.Text, font, text, Color.White, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix); }
        }
    }

    sealed class XpCaptionButton : Button
    {
        readonly int kind; bool hot;
        public XpCaptionButton(int kind) { this.kind = kind; TabStop = false; SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var brush = new LinearGradientBrush(r, kind == 2 ? Color.FromArgb(hot ? 255 : 240, 158, 136) : Color.FromArgb(144, 192, 255), kind == 2 ? Color.FromArgb(195, 48, 16) : Color.FromArgb(19, 80, 194), LinearGradientMode.ForwardDiagonal)) e.Graphics.FillRectangle(brush, r);
            e.Graphics.DrawRectangle(Pens.White, r); using (var inner = new Pen(Color.FromArgb(130, Color.White))) e.Graphics.DrawRectangle(inner, 1, 1, Width - 3, Height - 3);
            using (var pen = new Pen(Color.White, 2))
            {
                if (kind == 0) e.Graphics.DrawLine(pen, 5, 16, 13, 16);
                else if (kind == 1) { e.Graphics.DrawRectangle(pen, 5, 5, 11, 11); e.Graphics.DrawLine(pen, 5, 7, 16, 7); }
                else { e.Graphics.DrawLine(pen, 6, 6, 16, 16); e.Graphics.DrawLine(pen, 16, 6, 6, 16); }
            }
        }
    }

    public class XpButton : Button
    {
        public bool Primary { get; set; } bool hot, pressed;
        public XpButton() { SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true); FlatStyle = FlatStyle.Standard; BackColor = Xp.Face; ForeColor = Color.Black; }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            using (var fill = new LinearGradientBrush(r, pressed ? Color.FromArgb(216, 212, 196) : Color.White, pressed ? Xp.Face : Color.FromArgb(226, 222, 205), LinearGradientMode.Vertical)) e.Graphics.FillRectangle(fill, r);
            using (var border = new Pen(Enabled ? Xp.Blue : Color.FromArgb(172, 168, 153))) e.Graphics.DrawRectangle(border, r);
            using (var bevel = new Pen(hot ? Color.FromArgb(255, 191, 82) : Primary ? Color.FromArgb(120, 165, 216) : Color.White, hot || Primary ? 2 : 1)) e.Graphics.DrawRectangle(bevel, 2, 2, Math.Max(1, Width - 5), Math.Max(1, Height - 5));
            Rectangle text = new Rectangle(7 + (pressed ? 1 : 0), pressed ? 1 : 0, Width - 14, Height);
            TextRenderer.DrawText(e.Graphics, Text, Font, text, Enabled ? ForeColor : SystemColors.GrayText, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, new Rectangle(5, 5, Width - 10, Height - 10));
        }
    }

    public class XpTabs : TabControl
    {
        public XpTabs() { DrawMode = TabDrawMode.OwnerDrawFixed; Padding = new Point(15, 6); }
        protected override void OnDrawItem(DrawItemEventArgs e)
        {
            bool selected = SelectedIndex == e.Index; Rectangle r = GetTabRect(e.Index);
            using (var fill = new SolidBrush(selected ? Xp.Face : Color.FromArgb(222, 221, 204))) e.Graphics.FillRectangle(fill, r);
            Xp.Bevel(e.Graphics, r); if (selected) using (var pen = new Pen(Color.FromArgb(230, 139, 44), 2)) e.Graphics.DrawLine(pen, r.Left + 2, r.Top + 1, r.Right - 2, r.Top + 1);
            TextRenderer.DrawText(e.Graphics, TabPages[e.Index].Text, Font, r, selected ? Xp.Blue : Color.Black, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }
}
