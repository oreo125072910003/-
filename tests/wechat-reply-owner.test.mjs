import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepare, validateConfig } from '../代码/项目/scripts/project-config.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../代码/项目/config/wechatagent.example.json', import.meta.url), 'utf8'));
const bridge = fileURLToPath(new URL('../代码/项目/components/qq-bridge/src/social-bridge.js', import.meta.url));

test('reply ownership accepts the existing default and desktop takeover, rejects unknown owners', () => {
  const config = structuredClone(example);
  delete config.runtime.replyOwner;
  assert.equal(validateConfig(config), config);
  config.runtime.replyOwner = 'desktop';
  assert.equal(validateConfig(config), config);
  config.runtime.replyOwner = 'both';
  assert.throws(() => validateConfig(config), /replyOwner/);
});

test('configuration regeneration retains desktop ownership and existing conversation data', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-reply-prepare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['config', 'roles', 'state']) fs.mkdirSync(path.join(directory, name));
  const config = structuredClone(example);
  config.runtime.replyOwner = 'desktop';
  config.wechat.whitelist.private = ['101'];
  config.persona = { default: 'test', chats: {} };
  fs.writeFileSync(path.join(directory, 'config', 'wechatagent.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(directory, 'roles', 'test.md'), '# Test\nSynthetic assistant.');
  const buffer = JSON.stringify({ chats: { 'wechat:private:101': [{ text: 'retained', processed: false }] } });
  const bufferFile = path.join(directory, 'state', 'social-messages.json');
  fs.writeFileSync(bufferFile, buffer);
  for (let attempt = 0; attempt < 2; attempt++) {
    prepare(directory);
    const generated = JSON.parse(fs.readFileSync(path.join(directory, 'state', 'bridge-config.json'), 'utf8'));
    assert.equal(generated.reply_owner, 'desktop');
    assert.deepEqual(generated.platforms.wechat.whitelist.private, ['101']);
    assert.equal(fs.readFileSync(bufferFile, 'utf8'), buffer);
  }
});

test('desktop ownership prevents a legacy responder from opening connections or reading old chat data', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-reply-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'bridge.json');
  // No tokens, account settings, or chat buffer: exit must happen before initialization.
  fs.writeFileSync(filename, JSON.stringify({ reply_owner: 'desktop' }));
  const child = spawnSync(process.execPath, [bridge, filename], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Desktop assistant owns WeChat replies/);
  assert.deepEqual(fs.readdirSync(directory), ['bridge.json']);
  fs.writeFileSync(filename, JSON.stringify({ reply_owner: 'both' }));
  const invalid = spawnSync(process.execPath, [bridge, filename], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid reply_owner/);
});
