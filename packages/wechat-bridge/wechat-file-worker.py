"""One bounded, read-only attachment request through the existing reader.

No server, native injection, login operation, download, or path from a chat.
"""
import base64
import html
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import urllib.request
from urllib.parse import urlsplit, quote
import xml.etree.ElementTree as ET

MAX_BYTES = 16 * 1024 * 1024


def failure(code):
    raise RuntimeError(code)


def fingerprint(values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def xml(value):
    if not isinstance(value, str) or len(value) > 512000 or re.search(r'<!\s*(DOCTYPE|ENTITY)', value, re.I):
        failure('FILE_XML_INVALID')
    return ET.fromstring(value)


def record(node):
    if list(node):
        return node
    text = (node.text or '').strip()
    for _ in range(3):
        if text.startswith('<'):
            return xml(text)
        decoded = html.unescape(text)
        if decoded == text:
            break
        text = decoded
    return xml(text)


def file_items(content):
    root = xml(content)
    app = root if root.tag == 'appmsg' else root.find('appmsg') if root.tag == 'msg' else None
    if app is None:
        return []
    def item(node, forwarded=False):
        attach = node.find('appattach') if not forwarded else node
        hashes = [element.text.strip().lower() for element in node.iter() if element.tag in ('filemd5', 'md5', 'fullmd5', 'datamd5') and element.text and element.text.strip()]
        return {'name': (node.findtext('datatitle') or node.findtext('datadesc') or '').strip() if forwarded else (node.findtext('title') or '').strip(),
                'size': int((attach.findtext('datasize' if forwarded else 'totallen') if attach is not None else '') or 0), 'hashes': hashes}
    if app.findtext('type') == '6':
        return [item(app)]
    if app.findtext('type') != '19' or app.find('recorditem') is None:
        return []
    result, visited = [], [0]
    def collect(node, depth):
        if depth > 3:
            return
        data = node if node.tag == 'datalist' else node.find('datalist')
        if data is None:
            data = node.find('recordinfo/datalist')
        if data is None:
            return
        for entry in data.findall('dataitem'):
            visited[0] += 1
            if visited[0] > 50 or len(result) >= 20:
                break
            kind = entry.get('datatype') or entry.findtext('datatype')
            if kind == '8':
                result.append(item(entry, True))
            elif kind == '14':
                nested = entry.find('recordxml')
                if nested is None:
                    nested = entry.find('recorditem')
                if nested is not None:
                    collect(record(nested), depth + 1)
    collect(record(app.find('recorditem')), 0)
    return result


def safe_chain(path):
    current = path
    while True:
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            failure('FILE_PATH_REFUSED')
        if current == current.parent:
            return
        current = current.parent


def cached_bytes(account, info):
    name, size, hashes = info['name'], info['size'], info['hashes']
    if not name or len(name) > 300 or re.search(r'[\\/\x00-\x1f:]', name) or name in ('.', '..'):
        failure('FILE_NAME_INVALID')
    if not 0 < size <= MAX_BYTES:
        failure('FILE_TOO_LARGE')
    if not hashes or any(not re.fullmatch('[a-f0-9]{32}', value) for value in hashes) or len(set(hashes)) != 1:
        failure('FILE_DIGEST_UNAVAILABLE')
    base = account / 'msg' / 'file'
    if not base.is_dir():
        failure('FILE_NOT_CACHED')
    safe_chain(base)
    candidates, scanned = [], 0
    for directory in [base] + sorted((entry for entry in base.iterdir() if entry.is_dir()), reverse=True)[:36]:
        safe_chain(directory)
        direct = directory / name
        if direct.is_file():
            candidates.append(direct)
        for entry in directory.iterdir():
            scanned += 1
            if scanned > 10000:
                break
            if entry != direct and entry.is_file() and entry.stat().st_size == size:
                candidates.append(entry)
        if scanned > 10000:
            break
    budget = 128 * 1024 * 1024
    for candidate in dict.fromkeys(candidates):
        safe_chain(candidate)
        if candidate.stat().st_size != size:
            continue
        budget -= size
        if budget < 0:
            failure('FILE_SEARCH_LIMIT')
        with candidate.open('rb') as handle:
            before = os.fstat(handle.fileno())
            data = handle.read(MAX_BYTES + 1)
            after = os.fstat(handle.fileno())
        safe_chain(candidate)
        if len(data) != size or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            continue
        if hashlib.md5(data).hexdigest() == hashes[0]:
            return data
    failure('FILE_NOT_CACHED')


def indexed_digest(module, settings, account, info):
    """Only a task with existing private computer-read authority may use the
    client's unique local cache index when a forwarded card omitted its MD5.
    A title/size match alone never grants that authority.
    """
    database = account / 'db_storage/hardlink/hardlink.db'
    safe_chain(database)
    connection = None
    try:
        key, salt = module.nt.derive_database_key(str(database), '', '', module.local_secret(settings['decryptKey']))
        connection, cursor = module.nt.connect_nt_db(str(database), key, salt)
        cursor.execute('PRAGMA query_only=ON')
        cursor.execute('PRAGMA busy_timeout=2000')
        rows = cursor.execute('SELECT md5 FROM file_hardlink_info_v4 WHERE file_name=? AND file_size=? LIMIT 8', (info['name'], info['size'])).fetchall()
        hashes = {row[0].lower() for row in rows if isinstance(row[0], str) and re.fullmatch('[a-fA-F0-9]{32}', row[0])}
        if len(rows) >= 8 or len(hashes) != 1 or len(rows) == 0 or any(not isinstance(row[0], str) or not re.fullmatch('[a-fA-F0-9]{32}', row[0]) for row in rows):
            failure('FILE_CACHE_AMBIGUOUS')
        return list(hashes)
    finally:
        if connection is not None:
            connection.close()


def run(request):
    root = pathlib.Path(request['root'])
    io = json.loads((root / 'state/wechat-io-config.json').read_text(encoding='utf-8-sig'))
    origin = urlsplit(io['reader_base_url'])
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or origin.username or origin.password or origin.path not in ('', '/'):
        failure('FILE_READER_UNAVAILABLE')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            failure('FILE_READER_UNAVAILABLE')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def get(route):
        req = urllib.request.Request(io['reader_base_url'].rstrip('/') + route, headers={'Authorization': 'Bearer ' + io['reader_token']})
        with opener.open(req, timeout=8) as response:
            data = response.read(12 * 1024 * 1024 + 1)
        if len(data) > 12 * 1024 * 1024:
            failure('FILE_READER_LIMIT')
        return json.loads(data)
    def identity():
        state = get('/api/v1/reader/status')
        if state.get('lastError') or state.get('accountDirectory', '').lower() != request['account'].lower():
            failure('FILE_ACCOUNT_CHANGED')
        return state
    identity()
    talker, source_id, index = request['talker'], request['sourceId'], request['index']
    if not re.fullmatch('[A-Za-z0-9_.@-]{1,256}', talker) or not re.fullmatch('[a-f0-9]{64}', source_id) or type(index) is not int or not 0 <= index < 20:
        failure('FILE_REFERENCE_INVALID')
    if request['id'] != fingerprint([request['account'], talker, source_id, index]):
        failure('FILE_REFERENCE_INVALID')
    rows = get('/api/v1/messages?talker=' + quote(talker, safe='') + '&limit=500').get('messages', [])
    matches = [row for row in rows if fingerprint([talker, row.get('serverId'), row.get('localId'), row.get('createTime')]) == source_id]
    if len(matches) != 1:
        failure('FILE_MESSAGE_UNAVAILABLE')
    if int(matches[0].get('localType') or 0) & 0xFFFFFFFF != 49:
        failure('FILE_REFERENCE_INVALID')
    items = file_items(matches[0].get('fullText', ''))
    if index >= len(items):
        failure('FILE_REFERENCE_INVALID')
    info = items[index]
    # Reuse the original reader's Windows credential decoding; never take a
    # cache path, download URL, or filename supplied in the incoming chat text.
    spec = importlib.util.spec_from_file_location('xzs_original_reader', root / 'scripts/reader-api.py')
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(root / 'scripts'))
    spec.loader.exec_module(module)
    settings = json.loads((root / 'state/weflow/WeFlow-config.json').read_text(encoding='utf-8-sig'))
    account = pathlib.Path(module.local_secret(settings['dbPath']))
    if not (account / 'db_storage').is_dir():
        account /= module.local_secret(settings['myWxid'])
    if account.name.lower() != request['account'].lower():
        failure('FILE_ACCOUNT_CHANGED')
    verification = 'message-md5'
    if not info['hashes'] and request.get('allowIndexedFallback') is True:
        info['hashes'] = indexed_digest(module, settings, account, info)
        verification = 'owner-authorized-cache-index'
    data = cached_bytes(account, info)
    identity()
    return {'ok': True, 'id': request['id'], 'name': info['name'], 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'verification': verification, 'b64': base64.b64encode(data).decode('ascii')}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            failure('FILE_REFERENCE_INVALID')
        result = run(json.loads(raw))
    except Exception as error:
        code = str(error)
        result = {'ok': False, 'error': code if re.fullmatch('FILE_[A-Z_]+', code) else 'FILE_READ_FAILED'}
    print(json.dumps(result, ensure_ascii=False))
