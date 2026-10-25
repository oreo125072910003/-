"""Exercise actual reader producers/policies without databases or reader startup."""
import ast
import contextlib
import hashlib
import hmac
import http.client
import io
import json
import pathlib
import queue
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / '代码/项目/scripts/reader-api.py'
tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
reader = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Reader')
methods = {'selected_talkers', 'effective_whitelist', 'product_subscription', 'messages',
           'sessions', 'image_talker_allowed', 'make_payload', 'poll', 'contacts'}
reader.body = [n for n in reader.body if isinstance(n, ast.FunctionDef) and n.name in methods]
selected = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('push_payload', 'serve')] + [reader]
media_tree = ast.parse((SOURCE.parent / 'wechat_media.py').read_text(encoding='utf-8-sig'))
selected += [n for n in media_tree.body if isinstance(n, ast.FunctionDef) and n.name == 'clean_account_wxid']
scope = dict(globals(), read_json=lambda p: json.loads(pathlib.Path(p).read_text(encoding='utf-8')),
             group_username=lambda value: '@chatroom' in value, PAT_TYPE=(62 << 32) | 49)
exec(compile(ast.Module(body=selected, type_ignores=[]), str(SOURCE), 'exec'), scope)
Reader, push_payload = scope['Reader'], scope['push_payload']


def own_payload(talker='wxid_test_friend', identity='101', own='wxid_self_0001'):
    return push_payload(talker, {'isSend': True, 'senderUsername': own, 'localType': 1,
        'fullText': '本人接管', 'localId': 29, 'serverId': '90029', 'createTime': int(time.time())}, {}, own, identity)


class ReaderRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xzs-reader-regression-')
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        (root / 'config').mkdir()
        self.config = root / 'config/wechatagent.json'
        self.original = json.dumps({'wechat': {'whitelist': {'private': ['101'], 'groups': []}}, 'unknownLegacyOption': {'keep': True}})
        self.config.write_text(self.original)
        settings = root / 'settings.json'
        settings.write_text('{}')
        r = Reader()
        r.root, r.settings_file, r.account, r.own_wxid = root, settings, pathlib.Path('synthetic-account'), 'wxid_self_0001'
        r.names = {'wxid_old': 'old', 'wxid_new': 'new', 'new@chatroom': 'new group'}
        r.conversation_id = lambda talker: {'wxid_old': '101', 'wxid_new': '102', 'new@chatroom': '201'}[talker]
        r.display_name = lambda talker: r.names[talker]
        r.refresh_names = lambda **kw: None
        r.lock, r.product_subscriptions, r.product_subscription_revision = threading.Lock(), {}, 0
        self.r, self.sid = r, '11111111-1111-1111-1111-111111111111'

    def apply(self, private=None, groups=None, revision=0, **extra):
        return self.r.product_subscription(self.sid, dict(version=1, subscriptionId=self.sid,
            expectedRevision=revision, accountDirectory='synthetic-account', ownWxid=self.r.own_wxid,
            private=['102'] if private is None else private, groups=['201'] if groups is None else groups, **extra))

    def test_real_own_producer_emits_account_conversation_and_native_message(self):
        value = own_payload()
        self.assertTrue(value['isSend'])
        self.assertEqual((value['accountWxid'], value['talkerId'], value['conversationId']), ('wxid_self_0001', 'wxid_self_0001', '101'))
        self.assertEqual(value['sourceLocalId'], '29')
        self.assertIsNone(push_payload('wxid_test_friend', {'isSend': True, 'senderUsername': 'wxid_imposter'}, {}, 'wxid_self_0001', '101'))
        self.assertIsNone(push_payload('wxid_test_friend', {'isSend': True}, {}, 'wxid_self_0001'))

    def test_new_contact_and_group_reach_history_sessions_images_and_actual_poll(self):
        r = self.r
        self.assertEqual(r.selected_talkers(), ['wxid_old'])
        with self.assertRaises(PermissionError):
            r.messages('wxid_new')
        applied = self.apply()
        self.assertGreater(applied['revision'], 0)
        self.assertEqual(set(r.selected_talkers()), set(r.names))
        self.assertTrue(r.image_talker_allowed('wxid_new'))
        self.assertEqual({x['username'] for x in r.sessions()}, set(r.names))
        r.open_messages = lambda: []
        scope['nt'] = types.SimpleNamespace(get_messages=lambda *a, **kw: {'messages': [{'localType': 0, 'text': 'synthetic history'}]})
        self.assertEqual(r.messages('wxid_new')[0]['text'], 'synthetic history')
        # Execute the actual poll producer with a fake row source, real payload
        # conversion and its real queue fanout. No transport is started.
        r.messages = lambda talker, **kw: [{'isSend': True, 'senderUsername': r.own_wxid, 'localType': 3,
            'localId': 29, 'serverId': '90029', 'createTime': int(time.time())},
            {'isSend': False, 'senderUsername': 'wxid_friend', 'localType': 1, 'fullText': 'new incoming text',
             'localId': 30, 'serverId': '90030', 'createTime': int(time.time())}]
        r.started_at, r.image_index, r.seen, r.pushed = int(time.time()), {}, OrderedDict(), 0
        r.stop = types.SimpleNamespace(is_set=lambda: r.pushed >= 6, wait=lambda _: None)
        r.clients = {queue.Queue()}
        r.pump_sticker_collection = r.pump_sticker_pool_review = lambda: None
        with contextlib.redirect_stdout(io.StringIO()):
            r.poll()
        self.assertEqual(r.pushed, 6)
        events = next(iter(r.clients))
        payloads = [events.get_nowait() for _ in range(6)]
        self.assertEqual({x['conversationId'] for x in payloads}, {'101', '102', '201'})
        self.assertEqual({x['conversationId'] for x in payloads if not x.get('isSend')}, {'101', '102', '201'})
        self.assertTrue(all(x['accountWxid'] == r.own_wxid for x in payloads if x.get('isSend')))
        self.assertEqual(self.config.read_text(), self.original)

    def test_cas_revocation_expiry_and_account_change_preserve_legacy_config(self):
        first = self.apply()
        with self.assertRaises(ValueError):
            self.apply(revision=0)
        current = self.r.product_subscription(self.sid)
        self.assertEqual(current['private'], ['102'])
        with self.assertRaises(ValueError):
            candidate = {**current, 'version': 99}
            self.r.product_subscription(self.sid, candidate)
        second = self.apply(private=[], groups=[], revision=first['revision'])
        self.assertGreater(second['revision'], first['revision'])
        self.assertEqual(self.r.selected_talkers(), ['wxid_old'])
        third = self.apply(revision=second['revision'])
        self.r.product_subscriptions[self.sid]['expiresAt'] = time.time() - 1
        self.assertEqual(self.r.selected_talkers(), ['wxid_old'])
        self.assertEqual(self.r.product_subscription(self.sid)['revision'], 0)
        self.apply()
        self.r.account = pathlib.Path('another-account')
        self.assertEqual(self.r.selected_talkers(), ['wxid_old'])
        with self.assertRaises(PermissionError):
            self.apply()
        self.assertEqual(self.config.read_text(), self.original)

    def test_actual_http_subscription_interface_auth_version_and_conflict(self):
        r = self.r
        r.stop = threading.Event()
        r.poll = lambda: None
        r.sticker_executor = r.sticker_review_executor = types.SimpleNamespace(shutdown=lambda **kw: None)
        servers = queue.Queue()
        def server_factory(port, handler):
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            server.daemon_threads = True
            servers.put(server)
            return server
        scope['create_reader_server'] = server_factory
        thread = threading.Thread(target=scope['serve'], args=(r, 0, 'synthetic-token'), daemon=True)
        with contextlib.redirect_stdout(io.StringIO()):
            thread.start()
            server = servers.get(timeout=3)
            def request(method, body=None, auth=True):
                connection = http.client.HTTPConnection(*server.server_address, timeout=3)
                headers = {'Authorization': 'Bearer synthetic-token'} if auth else {}
                route = '/api/v1/product/subscription' + ('?subscriptionId='+self.sid if method == 'GET' else '')
                connection.request(method, route, json.dumps(body) if body else None, headers)
                response = connection.getresponse()
                result = response.status, json.loads(response.read())
                connection.close()
                return result
            try:
                self.assertEqual(request('GET', auth=False)[0], 401)
                self.assertEqual(request('POST', auth=False)[0], 401)
                self.assertEqual(request('GET')[1]['revision'], 0)
                body = dict(version=1, subscriptionId=self.sid, expectedRevision=0,
                    accountDirectory='synthetic-account', ownWxid=r.own_wxid, private=['102'], groups=['201'])
                code, applied = request('POST', body)
                self.assertEqual(code, 200)
                self.assertEqual(request('GET')[1]['revision'], applied['revision'])
                self.assertEqual(set(r.selected_talkers()), set(r.names))
                self.assertEqual(request('POST', body)[0], 409)
                self.assertEqual(request('POST', {**body, 'version': 99, 'expectedRevision': applied['revision']})[0], 409)
                self.assertEqual(request('POST', {**body, 'accountDirectory': 'wrong-account', 'expectedRevision': applied['revision']})[0], 409)
                self.assertEqual(request('GET')[1]['private'], ['102'])
                self.assertEqual(self.config.read_text(), self.original)
            finally:
                server.shutdown()
                thread.join(timeout=3)
        self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    if '--payload' in sys.argv:
        print(json.dumps(own_payload(), ensure_ascii=False))
    else:
        unittest.main()
