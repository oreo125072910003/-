using System;
using System.Drawing;
using System.Windows.Forms;
class FixtureForm {
 [STAThread] static void Main(){
  var form=new Form{Text="小助手客户端控制验证",Size=new Size(620,320),StartPosition=FormStartPosition.CenterScreen};
  var label=new Label{Text="这是独立测试窗口",Location=new Point(30,25),AutoSize=true};
  var input=new TextBox{Location=new Point(30,70),Width=440,AccessibleName="验证输入框"};
  var button=new Button{Text="验证按钮",Location=new Point(30,125),Width=150,Height=40};
  button.Click+=(s,e)=>{label.Text="已点击："+input.Text;};
  form.Controls.Add(label);form.Controls.Add(input);form.Controls.Add(button);Application.Run(form);
 }
}
