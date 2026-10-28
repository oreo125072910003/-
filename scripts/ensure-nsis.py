"""Fetch a pinned, portable official NSIS compiler into the ignored build cache."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import urllib.request
import zipfile

VERSION = '3.13'
SHA256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
URL = f'https://downloads.sourceforge.net/project/nsis/NSIS%203/{VERSION}/nsis-{VERSION}.zip'


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    cache = root / 'dist' / 'installer-tools'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f'nsis-{VERSION}.zip'
    if not archive.is_file():
        temporary = archive.with_suffix('.download')
        with urllib.request.urlopen(URL, timeout=60) as response, temporary.open('wb') as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        temporary.replace(archive)
    with archive.open('rb') as source:
        actual = hashlib.file_digest(source, 'sha256').hexdigest()
    if actual != SHA256:
        raise RuntimeError('Official NSIS archive differs from the pinned SHA256; no compiler was executed.')
    compiler = cache / f'nsis-{VERSION}' / 'makensis.exe'
    with zipfile.ZipFile(archive) as package:
        for member in package.infolist():
            name = PurePosixPath(member.filename)
            if name.is_absolute() or '..' in name.parts or name.parts[0] != f'nsis-{VERSION}':
                raise RuntimeError('Unexpected compiler archive path.')
        if not compiler.is_file():
            package.extractall(cache)
        # Validate the extracted compiler/includes too, not just the cached ZIP.
        for member in package.infolist():
            if not member.is_dir():
                extracted = cache / member.filename
                if extracted.is_symlink() or not extracted.is_file() or extracted.read_bytes() != package.read(member):
                    raise RuntimeError('Cached NSIS compiler files differ from the verified official archive.')
    print(json.dumps({'compiler': str(compiler), 'version': VERSION, 'archiveSha256': actual, 'source': URL}))


if __name__ == '__main__':
    main()
