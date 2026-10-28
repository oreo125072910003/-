"""Publish verified release files using the repository's existing Git credential helper."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--body-file', type=Path, required=True)
    parser.add_argument('--asset', type=Path, action='append', required=True)
    parser.add_argument('--prerelease', action='store_true', help='Mark this release as a preview instead of a stable release.')
    args = parser.parse_args()
    root = args.repo.resolve()

    def git(*arguments: str) -> str:
        return subprocess.check_output(['git', '-c', 'safe.directory=' + root.as_posix(), *arguments], cwd=root, text=True).strip()

    remote = git('remote', 'get-url', 'origin')
    match = re.fullmatch(r'https://github\.com/([\w.-]+/[\w.-]+?)(?:\.git)?', remote)
    if not match:
        raise RuntimeError('This publisher requires a configured github.com HTTPS origin.')
    repository = match.group(1)
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    tag, commit = 'v' + version, git('rev-parse', 'HEAD')
    if git('status', '--porcelain'):
        raise RuntimeError('Release sources must be committed before publishing.')
    if git('rev-parse', tag + '^{commit}') != commit:
        raise RuntimeError('Release tag does not point to the current source commit.')
    environment = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never')
    credential = subprocess.run(['git', 'credential', 'fill'], cwd=root, input='protocol=https\nhost=github.com\n\n',
                                text=True, capture_output=True, check=True, timeout=30, env=environment)
    values = dict(line.split('=', 1) for line in credential.stdout.splitlines() if '=' in line)
    token = values.get('password')
    if not token:
        raise RuntimeError('No existing GitHub credential is available.')
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
               'User-Agent': 'xiaozhushou-release', 'X-GitHub-Api-Version': '2022-11-28'}
    base = 'https://api.github.com/repos/' + repository

    def api(route: str, method: str = 'GET', body: dict | None = None):
        content = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        request = urllib.request.Request(base + route, data=content, method=method,
                                         headers={**headers, **({'Content-Type': 'application/json'} if content is not None else {})})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    existing = [release for release in api('/releases?per_page=100') if release['tag_name'] == tag]
    if existing:
        raise RuntimeError('A release with this tag already exists; inspect it before replacing assets.')
    release = api('/releases', 'POST', {'tag_name': tag, 'target_commitish': commit, 'name': '小助手 ' + version + ' 完整版',
                                       'body': args.body_file.read_text(encoding='utf-8'), 'draft': True, 'prerelease': args.prerelease})
    uploaded = []
    for asset in args.asset:
        asset = asset.resolve(strict=True)
        if not asset.is_file():
            raise RuntimeError('Upload asset must be a regular file.')
        with asset.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        url = urllib.parse.urlsplit(release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(asset.name))
        if url.scheme != 'https' or url.hostname != 'uploads.github.com':
            raise RuntimeError('Unexpected GitHub asset upload endpoint.')
        print(json.dumps({'uploading': asset.name, 'bytes': asset.stat().st_size}, ensure_ascii=False), flush=True)

        def chunks():
            sent = 0
            next_report = 32 * 1024 * 1024
            with asset.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    yield chunk
                    sent += len(chunk)
                    if sent >= next_report:
                        print(json.dumps({'uploading': asset.name, 'sentBytes': sent}, ensure_ascii=False), flush=True)
                        next_report += 32 * 1024 * 1024

        # Use the same system proxy and TLS handling as the metadata API. Keep
        # a fixed content length and stream bounded chunks for large packages.
        request = urllib.request.Request(url.geturl(), data=chunks(), method='POST',
                                         headers={**headers, 'Content-Type': 'application/octet-stream',
                                                  'Content-Length': str(asset.stat().st_size)})
        with urllib.request.urlopen(request, timeout=600) as response:
            if response.status != 201:
                raise RuntimeError('GitHub asset upload failed with HTTP ' + str(response.status))
            result = json.load(response)
        if result.get('state') != 'uploaded' or result.get('size') != asset.stat().st_size:
            raise RuntimeError('Uploaded asset state or length differs.')
        if result.get('digest') and result['digest'] != 'sha256:' + checksum:
            raise RuntimeError('GitHub asset SHA256 differs.')
        uploaded.append({'name': result['name'], 'bytes': result['size'], 'sha256': checksum, 'serverDigest': result.get('digest')})
    published = api('/releases/' + str(release['id']), 'PATCH', {'draft': False})
    verified = api('/releases/' + str(release['id']))
    if verified['draft'] or len(verified.get('assets', [])) != len(uploaded):
        raise RuntimeError('Published release verification failed.')
    report = {'ok': True, 'repository': repository, 'tag': tag, 'sourceCommit': commit, 'url': published['html_url'], 'assets': uploaded}
    (root / 'dist' / 'releases' / version / 'github-publish.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
