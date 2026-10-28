using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

// Fixed operations over stdin, one request per process. No shell/script evaluator.
class DesktopControl {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  delegate bool EnumProc(IntPtr hwnd,IntPtr arg);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr arg);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=16000000 };
  static readonly HashSet<string> Denied=new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "ChatGPT","Codex","cmd","powershell","pwsh","WindowsTerminal","OpenConsole","LockApp","consent","CredentialUIBroker","SystemSettings","SecHealthUI","SecurityHealthHost","KeePass","KeePassXC","1Password","Bitwarden" };
  static string S(Dictionary<string,object> x,string key){return x.ContainsKey(key)?Convert.ToString(x[key]):"";}
  static int I(Dictionary<string,object> x,string key){return Convert.ToInt32(x[key]);}
  static string Title(IntPtr hwnd){var b=new StringBuilder(1024);GetWindowText(hwnd,b,b.Capacity);return b.ToString();}
  static Dictionary<string,object> Identity(IntPtr hwnd){
    if(!IsWindow(hwnd)||!IsWindowVisible(hwnd))throw new Exception("目标窗口已关闭，请重新列出窗口。");
    uint pid;GetWindowThreadProcessId(hwnd,out pid);var p=Process.GetProcessById((int)pid);
    if(Denied.Contains(p.ProcessName)||p.ProcessName.StartsWith("codex",StringComparison.OrdinalIgnoreCase))throw new Exception("该系统、凭据或助手窗口不支持客户端自动操作。");
    return new Dictionary<string,object>{{"handle",hwnd.ToInt64().ToString()},{"pid",(int)pid},{"started",p.StartTime.ToUniversalTime().Ticks.ToString()},{"process",p.ProcessName},{"title",Title(hwnd)}};
  }
  static IntPtr Target(Dictionary<string,object> x){
    var hwnd=new IntPtr(long.Parse(S(x,"handle")));var current=Identity(hwnd);
    if(Convert.ToString(current["pid"])!=S(x,"pid")||Convert.ToString(current["started"])!=S(x,"started"))throw new Exception("目标窗口身份已变化，请重新观察。");
    return hwnd;
  }
  static RECT Bounds(IntPtr hwnd){RECT r;if(!GetWindowRect(hwnd,out r)||r.Right<=r.Left||r.Bottom<=r.Top)throw new Exception("无法读取窗口边界。");return r;}
  static int[] Rect(RECT r){return new int[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};}
  static void Activate(IntPtr hwnd){
    if(IsIconic(hwnd))ShowWindow(hwnd,9);
    uint pid;uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out pid),current=GetCurrentThreadId();
    bool attached=foreground!=0&&foreground!=current&&AttachThreadInput(current,foreground,true);
    try{BringWindowToTop(hwnd);SetForegroundWindow(hwnd);}finally{if(attached)AttachThreadInput(current,foreground,false);}
    Thread.Sleep(150);
    if(GetForegroundWindow()!=hwnd)throw new Exception("未能切到目标窗口，请保持桌面解锁，并重新观察。");
  }
  static object Snapshot(IntPtr hwnd){
    Activate(hwnd);var identity=Identity(hwnd);var r=Bounds(hwnd);var screen=SystemInformation.VirtualScreen;
    var clip=Rectangle.Intersect(new Rectangle(r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top),screen);
    if(clip.Width<1||clip.Height<1||clip.Width>12000||clip.Height>12000)throw new Exception("目标窗口没有可用的屏幕区域。");
    var elements=new List<object>();
    try{
      var root=AutomationElement.FromHandle(hwnd);var nodes=root.FindAll(TreeScope.Descendants,Condition.TrueCondition);
      for(int n=0;n<nodes.Count&&elements.Count<180;n++){
        try{var e=nodes[n];var a=e.Current;if(a.IsOffscreen||a.IsPassword)continue;var b=a.BoundingRectangle;
          if(b.IsEmpty||b.Width<1||b.Height<1)continue;
          string name=(a.Name??"");if(name.Length>240)name=name.Substring(0,240);
          elements.Add(new {name=name,role=a.ControlType.ProgrammaticName,enabled=a.IsEnabled,focused=a.HasKeyboardFocus,x=(int)b.X-clip.X,y=(int)b.Y-clip.Y,width=(int)b.Width,height=(int)b.Height});
        }catch{}
      }
    }catch{}
    using(var bitmap=new Bitmap(clip.Width,clip.Height))using(var g=Graphics.FromImage(bitmap)){
      g.CopyFromScreen(clip.X,clip.Y,0,0,clip.Size);
      double scale=Math.Min(1,1600.0/Math.Max(clip.Width,clip.Height));
      using(var small=new Bitmap(bitmap,new Size(Math.Max(1,(int)(clip.Width*scale)),Math.Max(1,(int)(clip.Height*scale)))))using(var bytes=new MemoryStream()){
        small.Save(bytes,ImageFormat.Jpeg);
        if(bytes.Length>768*1024)throw new Exception("截图超过大小限制，请缩小窗口。");
        return new {window=identity,rect=Rect(r),origin=new int[]{clip.X,clip.Y},width=small.Width,height=small.Height,scale=scale,elements=elements,mime="image/jpeg",image=Convert.ToBase64String(bytes.ToArray())};
      }
    }
  }
  static void Send(INPUT[] inputs){if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(INPUT)))!=(uint)inputs.Length)throw new Exception("Windows 拒绝了输入，操作结果待核对；请重新观察，不要重复提交。");}
  static INPUT K(ushort key,bool up){return new INPUT{type=1,data=new UNION{keyboard=new KEY{vk=key,flags=up?2u:0u}}};}
  static void ValidateFocus(IntPtr hwnd){
    if(GetForegroundWindow()!=hwnd)throw new Exception("焦点已离开目标窗口，请重新观察。");
    var e=AutomationElement.FocusedElement;if(e==null||e.Current.IsPassword)throw new Exception("不能自动输入凭据；请主人手动填写。");
    uint pid;GetWindowThreadProcessId(hwnd,out pid);if(e.Current.ProcessId!=(int)pid)throw new Exception("输入焦点不属于目标窗口。");
  }
  static object Action(Dictionary<string,object> x){
    var hwnd=Target(x);Activate(hwnd);var r=Bounds(hwnd);var expected=(System.Collections.IList)x["rect"];
    var actual=Rect(r);for(int n=0;n<4;n++)if(actual[n]!=Convert.ToInt32(expected[n]))throw new Exception("窗口位置或尺寸已变化，请重新观察。");
    string op=S(x,"operation");
    if(op=="click"||op=="scroll"){
      int px=I(x,"screenX"),py=I(x,"screenY");if(px<r.Left||px>=r.Right||py<r.Top||py>=r.Bottom)throw new Exception("点击位置超出窗口。");
      if(GetAncestor(WindowFromPoint(new POINT(px,py)),2)!=hwnd)throw new Exception("操作位置被其他窗口遮挡，请重新观察。");
      var v=SystemInformation.VirtualScreen;
      Send(new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{x=(int)((px-v.Left)*65535.0/Math.Max(1,v.Width-1)),y=(int)((py-v.Top)*65535.0/Math.Max(1,v.Height-1)),flags=0x8000|0x4000|1}}}});
      if(op=="scroll")Send(new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{data=unchecked((uint)I(x,"delta")),flags=0x0800}}}});
      else{
        bool right=S(x,"button")=="right";int count=x.ContainsKey("count")?I(x,"count"):1;
        for(int n=0;n<count;n++)Send(new INPUT[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=right?8u:2u}}},new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=right?16u:4u}}}});
      }
    }else if(op=="type"){
      ValidateFocus(hwnd);string value=S(x,"text");if(value.Length>2000)throw new Exception("一次最多输入 2000 字符。");
      foreach(char ch in value){if(ch<32)throw new Exception("文本不能包含控制键，请单独使用按键操作。");}
      foreach(char ch in value){ValidateFocus(hwnd);Send(new INPUT[]{new INPUT{type=1,data=new UNION{keyboard=new KEY{scan=ch,flags=4}}},new INPUT{type=1,data=new UNION{keyboard=new KEY{scan=ch,flags=6}}}});}
    }else if(op=="key"){
      ValidateFocus(hwnd);var values=(System.Collections.IList)x["keys"];var inputs=new List<INPUT>();foreach(object key in values)inputs.Add(K(Convert.ToUInt16(key),false));for(int n=values.Count-1;n>=0;n--)inputs.Add(K(Convert.ToUInt16(values[n]),true));Send(inputs.ToArray());
    }else throw new Exception("未知的窗口操作。");
    Thread.Sleep(180);return Snapshot(hwnd);
  }
  [STAThread] static int Main(){
    Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);SetProcessDPIAware();
    try{
      var x=Json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());object result;
      if(S(x,"operation")=="list"){
        var windows=new List<object>();EnumWindows(delegate(IntPtr hwnd,IntPtr arg){try{if(IsWindowVisible(hwnd)&&Title(hwnd).Length>0)windows.Add(Identity(hwnd));}catch{}return windows.Count<150;},IntPtr.Zero);result=new {windows=windows};
      }else if(S(x,"operation")=="preview"){
        var file=S(x,"file");if(!Path.IsPathRooted(file)||new FileInfo(file).Length>50*1024*1024)throw new Exception("截图文件无效。");
        using(var image=Image.FromFile(file)){
          double ratio=Math.Min(1,1600.0/Math.Max(image.Width,image.Height));
          using(var resized=new Bitmap(image,new Size(Math.Max(1,(int)(image.Width*ratio)),Math.Max(1,(int)(image.Height*ratio)))))using(var bytes=new MemoryStream()){
            resized.Save(bytes,ImageFormat.Jpeg);if(bytes.Length>768*1024)throw new Exception("截图预览超过大小限制。");result=new {image=Convert.ToBase64String(bytes.ToArray()),mime="image/jpeg"};
          }
        }
      }else if(S(x,"operation")=="observe")result=Snapshot(Target(x));else result=Action(x);
      Console.Write(Json.Serialize(new {ok=true,result=result}));return 0;
    }catch(Exception e){Console.Write(Json.Serialize(new {ok=false,error=e.Message}));return 1;}
  }
}
