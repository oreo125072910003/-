import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function imagePython() {
  try {
    const { workspace } = JSON.parse(fs.readFileSync(path.join(root, 'config/wechat-locations.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'config/wechatagent.json'), 'utf8'));
    if (fs.existsSync(config.runtime?.python)) return config.runtime.python;
  } catch { /* Other development machines may use their normal Python. */ }
  return process.env.XIAOZHUSHOU_IMAGE_TEST_PYTHON || 'python';
}

test('real image normalization preserves screenshot text scale, selects clear copies and refreshes old cache', () => {
  const result = spawnSync(imagePython(), ['-B', path.join(root, 'tests/wechat_image_quality.py')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
