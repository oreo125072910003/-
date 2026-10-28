"""Exercise the actual Windows installer in an isolated directory without personal data."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import winreg


def digest(filename: Path) -> str:
    with filename.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def registration() -> dict:
    values = {}
    for name in ['Software\\XiaoZhuShou\\Installer', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\XiaoZhuShou']:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, name) as key:
                items = []
                for index in range(winreg.QueryInfoKey(key)[1]):
                    items.append(winreg.EnumValue(key, index))
                values[name] = items
        except FileNotFoundError:
            values[name] = None
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version')
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    version = arguments.version or json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    release = root / 'dist' / 'releases' / version
    manifest = json.loads((release / 'installer.json').read_text(encoding='utf-8'))
    installer = Path(manifest['filename'])
    if digest(installer) != manifest['sha256']:
        raise RuntimeError('Installer checksum mismatch.')
    workspace = Path(tempfile.mkdtemp(prefix='xiaozhushou-installer-check-')).resolve()
    install = workspace / 'application'
    data = workspace / 'personal-data-sentinel.txt'
    data.write_text('This synthetic user data must survive uninstall.', encoding='utf-8')
    data_hash = digest(data)
    report_directory = root / 'dist' / 'installer-verification' / version
    report_directory.mkdir(parents=True, exist_ok=True)
    previous_registration = registration()
    unrelated = workspace / 'unrelated-directory'
    unrelated.mkdir()
    unrelated_file = unrelated / 'keep.txt'
    unrelated_file.write_text('This is not a product installation.', encoding='utf-8')
    refused_directory = subprocess.run([str(installer), '/S', '/ISOLATED', '/D=' + str(unrelated)], timeout=30)
    if refused_directory.returncode != 87 or not unrelated_file.is_file() or (unrelated / '小助手.exe').exists():
        raise RuntimeError('Installer did not refuse an unrelated nonempty directory.')
    # /ISOLATED skips shortcuts and registration only. The shipped installer and
    # actual file installation/uninstallation paths remain the same.
    result = subprocess.run([str(installer), '/S', '/ISOLATED', '/D=' + str(install)], timeout=600)
    if result.returncode != 0:
        raise RuntimeError(f'Isolated installation failed: {result.returncode}')
    executable = install / '小助手.exe'
    if digest(executable) != manifest['applicationSha256'] or digest(install / 'resources/app.asar') != manifest['archiveSha256']:
        raise RuntimeError('Installed program differs from verified installer payload.')
    component_check = "const fs=await import('node:fs');const {pathToFileURL}=await import('node:url');const {verifyWechatCompanions}=await import(pathToFileURL(process.argv[1]).href);const release=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify(verifyWechatCompanions(process.argv[2],release)));"
    verified_components = subprocess.run(['node', '--input-type=module', '-e', component_check,
                                         str(root / 'scripts/installer-manifest.mjs'), str(install), str(release / 'release.json')],
                                        capture_output=True, encoding='utf-8', timeout=180)
    if verified_components.returncode != 0:
        raise RuntimeError('Actual installed WeChat resources failed validation: ' + verified_components.stderr[-1500:])
    companions = json.loads(verified_components.stdout)
    if not companions.get('included') or not companions.get('allFileDigestsVerified') or manifest.get('companions', {}).get('manifestSha256') != companions['manifestSha256']:
        raise RuntimeError('Installer did not include its declared complete WeChat runtime.')
    retained = install / '用户自己的资料.txt'
    retained.write_text('Unrelated files in the program folder are not installer-owned.', encoding='utf-8')
    retained_hash = digest(retained)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.CreateFileW(str(executable), 0x80000000, 0, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        raise RuntimeError('Could not establish the isolated busy-file fixture.')
    try:
        refused = subprocess.run([str(installer), '/S', '/ISOLATED', '/D=' + str(install)], timeout=30)
        if refused.returncode != 32:
            raise RuntimeError('Upgrade failed to refuse occupied files without overwriting them.')
    finally:
        kernel.CloseHandle(handle)
    if digest(executable) != manifest['applicationSha256']:
        raise RuntimeError('Busy upgrade changed the installed executable.')
    environment = dict(os.environ)
    for key in ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'XIAOZHUSHOU_DATA_HOME']:
        environment.pop(key, None)
    environment['XIAOZHUSHOU_SMOKE_OUTPUT'] = str(report_directory / 'desktop-smoke')
    smoke_report = report_directory / 'desktop-smoke/desktop-smoke.json'
    smoke_report.unlink(missing_ok=True)
    smoke = subprocess.run([str(executable), '--smoke-test'], cwd=install, env=environment, capture_output=True, timeout=360)
    (report_directory / 'installed-app.log').write_bytes(smoke.stdout + smoke.stderr)
    if smoke.returncode != 0:
        raise RuntimeError(f'Installed app smoke test failed: {smoke.returncode}')
    smoke_result = json.loads(smoke_report.read_text(encoding='utf-8'))
    if not smoke_result.get('ok') or smoke_result.get('version') != version:
        raise RuntimeError('Installed application smoke did not confirm the requested version.')
    if smoke_result.get('portableWechatComponentsPrepared') is not True or smoke_result.get('portableWechatRuntimeVerified') is not True:
        raise RuntimeError('Installed application did not actually prepare and verify its bundled WeChat runtime.')
    smoke_data = Path(smoke_result['dataDir']).resolve()
    if smoke_data.parent != Path(tempfile.gettempdir()).resolve() or not smoke_data.name.startswith('xiaozhushou-desktop-smoke-'):
        raise RuntimeError('Smoke result did not identify an isolated synthetic data directory.')
    prepared_environment = smoke_data / 'wechat-environment'
    companion_manifest = json.loads((install / 'resources/companions/manifest.json').read_text(encoding='utf-8'))
    preserved_components = []
    for item in companion_manifest['files']:
        relative = item['path']
        # The source manifest has already passed the shared path/credential
        # validation. Preparation relocates its three allowlisted namespaces.
        if relative.startswith('wechat-client/'):
            mapped = 'state/hook/wechat-4.1.10.27/' + relative[len('wechat-client/'):]
        elif relative.startswith('reader/'):
            mapped = relative[len('reader/'):]
        else:
            mapped = relative
        destination = prepared_environment.joinpath(*mapped.split('/'))
        if not destination.is_file() or destination.stat().st_size != item['bytes'] or digest(destination) != item['sha256']:
            raise RuntimeError('Prepared installed WeChat component is missing or changed: ' + relative)
        preserved_components.append((destination, item['sha256']))
    config = json.loads((prepared_environment / 'config/wechatagent.json').read_text(encoding='utf-8'))
    if Path(config['runtime']['python']).resolve() != (prepared_environment / 'python/python.exe').resolve() or config['wechat']['whitelist'] != {'private': [], 'groups': []}:
        raise RuntimeError('Prepared WeChat runtime did not use its isolated Python and empty conversation grants.')
    token_file = prepared_environment / 'state/hook/native-token.txt'
    if not re.fullmatch('[a-f0-9]{64}', token_file.read_text(encoding='utf-8').strip()):
        raise RuntimeError('New WeChat runtime did not create its own token.')
    token_hash = digest(token_file)
    uninstall = subprocess.run([str(install / '卸载小助手.exe'), '/S'], timeout=60)
    if uninstall.returncode != 0:
        raise RuntimeError(f'Uninstaller failed: {uninstall.returncode}')
    deadline = time.monotonic() + 45
    while (executable.exists() or (install / '卸载小助手.exe').exists()) and time.monotonic() < deadline:
        time.sleep(0.2)
    if executable.exists() or (install / 'resources/app.asar').exists() or (install / '卸载小助手.exe').exists():
        raise RuntimeError('Uninstaller did not remove its program files.')
    if digest(retained) != retained_hash or digest(data) != data_hash:
        raise RuntimeError('Uninstaller changed unrelated synthetic user data.')
    if digest(token_file) != token_hash or any(not filename.is_file() or digest(filename) != expected for filename, expected in preserved_components):
        raise RuntimeError('Uninstaller changed the prepared personal WeChat environment.')
    if (install / 'resources/companions/manifest.json').exists():
        raise RuntimeError('Uninstaller left its bundled program components behind.')
    if registration() != previous_registration:
        raise RuntimeError('Isolated verification changed the real installation registration.')
    report = {'ok': True, 'version': version, 'installerSha256': manifest['sha256'], 'isolatedDirectory': str(workspace),
              'actualInstallerExecuted': True, 'installedPayloadHashMatched': True, 'busyUpgradeRefused': True,
              'unrelatedInstallDirectoryRefused': True,
              'installedAppSmokePassed': True, 'actualUninstallerExecuted': True, 'programFilesRemoved': True,
              'wechatClientBundled': True, 'readerRuntimeBundled': True, 'clientVersion': companions['clientVersion'],
              'companionFilesVerified': companions['files'], 'companionManifestSha256': companions['manifestSha256'],
              'portableWechatComponentsPrepared': True, 'portableWechatRuntimeVerified': True,
              'preparedWechatEnvironmentRetained': True, 'preparedEnvironment': str(prepared_environment),
              'unrelatedFilesRetained': True, 'syntheticPersonalDataRetained': True, 'registrationUnchanged': True,
              'personalDataOpened': False, 'messagesSent': 0, 'liveDshRestarted': False}
    (report_directory / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
