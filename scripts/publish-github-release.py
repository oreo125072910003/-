"""Publish verified release files using the repository's existing Git credential helper."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--body-file', type=Path, required=True)
    parser.add_argument('--asset', type=Path, action='append', required=True)
    parser.add_argument('--prerelease', action='store_true', help='Mark this release as a preview instead of a stable release.')
    parser.add_argument('--resume', action='store_true', help='Resume only a matching draft; retain every verified uploaded asset.')
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
            return None if response.status == 204 else json.load(response)

    existing = [release for release in api('/releases?per_page=100') if release['tag_name'] == tag]
    if existing:
        if not args.resume or len(existing) != 1 or not existing[0]['draft'] or existing[0]['target_commitish'] != commit:
            raise RuntimeError('Only the matching draft at this source commit can be resumed.')
        release = existing[0]
    else:
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
        result = None
        for attempt in range(3):
            matches = [item for item in api('/releases/' + str(release['id']) + '/assets') if item['name'] == asset.name]
            if len(matches) > 1:
                raise RuntimeError('More than one asset has this name.')
            if matches:
                current = matches[0]
                if current['state'] == 'uploaded':
                    if current['size'] != asset.stat().st_size or current.get('digest') != 'sha256:' + checksum:
                        raise RuntimeError('An uploaded asset differs; it was preserved.')
                    result = current
                    break
                # Only retire a failed starter in our matching unpublished draft.
                api('/releases/assets/' + str(current['id']), 'DELETE')
            print(json.dumps({'uploading': asset.name, 'bytes': asset.stat().st_size, 'attempt': attempt + 1}, ensure_ascii=False), flush=True)
            # curl accepts a native file stream and handles large uploads without
            # loading them into memory. ASCII staging avoids Windows path encodings;
            # credentials travel only through stdin, never argv or a saved file.
            with tempfile.TemporaryDirectory(prefix='xzs-release-') as temporary:
                staged = Path(temporary) / 'asset.bin'
                try:
                    os.link(asset, staged)
                except OSError:
                    shutil.copyfile(asset, staged)
                response_file = Path(temporary) / 'response.json'
                config = ['silent', 'show-error', 'http1.1', 'connect-timeout = 30', 'max-time = 900',
                          'request = "POST"', 'header = "Expect:"', 'write-out = "%{http_code}"']
                for key, value in {**headers, 'Content-Type': 'application/octet-stream'}.items():
                    config.append('header = ' + json.dumps(key + ': ' + value))
                proxy = urllib.request.getproxies().get('https')
                if attempt == 1 and proxy:
                    config.append('proxy = ' + json.dumps(proxy))
                else:
                    config.append('noproxy = "*"')
                config += ['url = ' + json.dumps(url.geturl()), 'data-binary = "@asset.bin"', 'output = "response.json"']
                completed = subprocess.run(['curl.exe' if os.name == 'nt' else 'curl', '--config', '-'],
                                           input='\n'.join(config) + '\n', text=True, capture_output=True,
                                           cwd=temporary, timeout=960)
                print(json.dumps({'asset': asset.name, 'attempt': attempt + 1, 'exitCode': completed.returncode,
                                  'httpStatus': completed.stdout.strip()}), flush=True)
                if completed.returncode == 0 and completed.stdout.strip() == '201':
                    result = json.loads(response_file.read_text(encoding='utf-8'))
                    break
            time.sleep(2)
        if result is None:
            # A timeout can follow successful receipt. Read before declaring failure.
            result = next((item for item in api('/releases/' + str(release['id']) + '/assets')
                           if item['name'] == asset.name and item['state'] == 'uploaded' and item['size'] == asset.stat().st_size
                           and item.get('digest') == 'sha256:' + checksum), None)
        if result is None:
            raise RuntimeError('Upload did not complete; the draft can be resumed without replacing verified assets.')
        if result.get('state') != 'uploaded' or result.get('size') != asset.stat().st_size:
            raise RuntimeError('Uploaded asset state or length differs.')
        if result.get('digest') != 'sha256:' + checksum:
            raise RuntimeError('GitHub asset SHA256 differs.')
        uploaded.append({'name': result['name'], 'bytes': result['size'], 'sha256': checksum, 'serverDigest': result.get('digest')})
    published = api('/releases/' + str(release['id']), 'PATCH', {'draft': False})
    verified = api('/releases/' + str(release['id']))
    if verified['draft'] or len(verified.get('assets', [])) != len(uploaded):
        raise RuntimeError('Published release verification failed.')
    for item in uploaded:
        actual = next(asset for asset in verified['assets'] if asset['name'] == item['name'])
        if actual['size'] != item['bytes'] or actual.get('digest') != 'sha256:' + item['sha256']:
            raise RuntimeError('Published asset verification differs.')
        item['downloadUrl'] = actual['browser_download_url']
    report = {'ok': True, 'repository': repository, 'tag': tag, 'sourceCommit': commit, 'url': published['html_url'], 'assets': uploaded}
    (root / 'dist' / 'releases' / version / 'github-publish.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
