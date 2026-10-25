"""Open a no-window synthetic argument receiver, never the actual desktop UI."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from test_offline import Client

CAPTURE = r'''
using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
static class Capture {
    static void Main(string[] args) {
        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "captured.json"), new JavaScriptSerializer().Serialize(args), Encoding.UTF8);
    }
}
'''

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--exe',type=Path,required=True)
    args=parser.parse_args()
    exe=args.exe.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='contract-open-args-') as temporary:
        root=Path(temporary); source=root/'capture.cs'; source.write_text(CAPTURE,encoding='utf-8')
        capture=root/'synthetic capture.exe'
        csc=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        subprocess.run([str(csc),'/nologo','/target:winexe','/reference:System.Web.Extensions.dll',f'/out:{capture}',str(source)],check=True,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
        progress=root/'progress with spaces.json'
        progress.write_text(json.dumps({'version':1,'fields':{},'goods':[],'payments':[]}),encoding='utf-8')
        for suffix in ['', '\\']:
            data_dir=str(root/'explicit data with spaces')+suffix
            result_file=root/'captured.json';result_file.unlink(missing_ok=True)
            client=Client(exe,root,desktop_exe=capture,data_dir=data_dir)
            try:
                client.call('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'synthetic','version':'1'}})
                client.call('notifications/initialized',notification=True)
                error,result=client.tool('open_contract_desktop',{'progress_path':str(progress)})
                assert not error,result
                deadline=time.monotonic()+5
                while not result_file.exists() and time.monotonic()<deadline:time.sleep(.02)
                received=json.loads(result_file.read_text(encoding='utf-8-sig'))
                assert received==['--data-dir',data_dir,'--open-progress',str(progress)],received
            finally:client.close()
    print(json.dumps({'passed':True,'checks':2,'spacesAndTrailingBackslashPreserved':True,'actualDesktopStarted':False,'syntheticNoWindowReceiver':True}))

if __name__=='__main__':main()
