"""Create and verify a complete Windows release from a clean Git snapshot."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import zipfile


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    root = args.repo.resolve()

    def git(*arguments: str) -> bytes:
        return subprocess.check_output(['git', '-c', 'safe.directory=' + root.as_posix(), *arguments], cwd=root)

    if git('status', '--porcelain').strip():
        raise RuntimeError('Commit the release sources before creating the source snapshot.')
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    commit = git('rev-parse', 'HEAD').decode().strip()
    release = root / 'dist' / 'releases' / version
    application = release / '小助手-win32-x64'
    built = json.loads((release / 'release.json').read_text(encoding='utf-8'))
    if built['version'] != version or digest(application / '小助手.exe') != built['sha256']:
        raise RuntimeError('Application build does not match its release manifest.')
    for forbidden in ['runtime-locations.json', 'wechat-locations.json', 'desktop-install.local.json']:
        # The separately verified ASAR manifest checks these packaged paths too.
        if (application / 'resources' / 'app' / 'config' / forbidden).exists():
            raise RuntimeError('Machine-specific configuration in application package.')

    output = release / f'小助手-{version}-完整版.zip'
    if output.exists():
        raise FileExistsError(output)
    with tempfile.TemporaryDirectory(prefix='portable-stage-', dir=release) as temporary:
        stage = Path(temporary) / f'小助手-{version}'
        stage.mkdir()
        shutil.copytree(application, stage / '程序文件')
        # Windows PowerShell 5.1 needs a BOM to decode Chinese paths reliably.
        launcher = (root / 'scripts' / 'portable-launch.ps1').read_text(encoding='utf-8')
        (stage / '程序文件' / '启动.ps1').write_text(launcher, encoding='utf-8-sig', newline='\r\n')
        (stage / '启动小助手.cmd').write_text(
            '@echo off\r\nchcp 65001 >nul\r\npowershell -NoLogo -NoProfile -ExecutionPolicy Bypass '
            '-File "%~dp0程序文件\\启动.ps1" %*\r\n', encoding='utf-8', newline='')
        (stage / '先看这里.txt').write_text(
            f'小助手 {version} 完整发布版\n\n'
            '先解压整个压缩包，再双击“启动小助手.cmd”。\n'
            '“程序文件”包含小助手和合同工具；“源码”用于开发，不需要打开。\n\n'
            '核心使用本机已经登录的 DeepSeek Harness。微信使用本机已配置的匹配客户端和读取服务。\n'
            '本包没有复制账户、密钥、聊天或邮件；在原电脑上会查找已有小助手数据。\n'
            '如果旧版仍在托盘，请先退出旧版，再启动本版。\n'
            '若能力中心显示“等待重载”，从系统托盘完整退出 DSH 后重新打开。\n\n'
            f'详细变化与当前限制：源码/docs/发布/{version}.md。\n', encoding='utf-8-sig')

        source_zip = Path(temporary) / 'source.zip'
        git('archive', '--format=zip', '--output=' + str(source_zip), commit)
        source = stage / '源码'
        with zipfile.ZipFile(source_zip) as archive:
            for member in archive.infolist():
                name = PurePosixPath(member.filename)
                if name.is_absolute() or '..' in name.parts:
                    raise RuntimeError('Unexpected path in Git archive.')
                parts = set(name.parts)
                if parts & {'state', 'logs', 'node_modules', '配置快照', '.git'}:
                    raise RuntimeError('Unexpected runtime data in source snapshot: ' + member.filename)
            archive.extractall(source)

        verification_file = release / 'verification.json'
        verification = json.loads(verification_file.read_text(encoding='utf-8'))
        if not verification.get('ok') or verification.get('version') != version:
            raise RuntimeError('Packaged application has not passed verification.')
        info = {'version': version, 'sourceCommit': commit, 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'platform': 'win32-x64', 'entry': '启动小助手.cmd', 'externalDependencies': ['DeepSeek Harness', 'configured WeChat environment'],
                'accountCredentialsIncluded': False, 'personalChatIncluded': False, 'verification': verification}
        (stage / '发布信息.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        files = sorted(path for path in stage.rglob('*') if path.is_file())
        hashes = [{'path': path.relative_to(stage).as_posix(), 'size': path.stat().st_size, 'sha256': digest(path)} for path in files]
        (stage / '文件校验.json').write_text(json.dumps(hashes, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for path in sorted(path for path in stage.rglob('*') if path.is_file()):
                archive.write(path, path.relative_to(stage.parent).as_posix())
        with zipfile.ZipFile(output) as archive:
            damaged = archive.testzip()
            if damaged:
                raise RuntimeError('Archive integrity check failed: ' + damaged)
            manifest_name = stage.name + '/文件校验.json'
            for item in json.loads(archive.read(manifest_name)):
                with archive.open(stage.name + '/' + item['path']) as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != item['sha256']:
                        raise RuntimeError('Archive content hash mismatch: ' + item['path'])
    checksum = digest(output)
    (release / 'SHA256SUMS.txt').write_text(checksum + '  ' + output.name + '\n', encoding='utf-8')
    result = {'ok': True, 'version': version, 'sourceCommit': commit, 'archive': str(output), 'bytes': output.stat().st_size,
              'sha256': checksum, 'files': len(hashes) + 1, 'allFileHashesVerified': True}
    (release / 'portable-release.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
