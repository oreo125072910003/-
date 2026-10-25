import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as asar from '@electron/asar';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'dist', 'releases', metadata.version);
const application = path.join(release, '小助手-win32-x64');
const archive = path.join(application, 'resources', 'app.asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
if (packaged.version !== metadata.version || manifest.version !== metadata.version) throw Error('Release version mismatch');
if (hash(fs.readFileSync(path.join(application, '小助手.exe'))) !== manifest.sha256) throw Error('Executable hash mismatch');
const checked = [];
for (const entry of asar.listPackage(archive)) {
  const name = entry.replace(/^[/\\]+/, '').replaceAll('\\', '/');
  if (/(^|\/)(state|logs|\.assistant-data)(\/|$)|(^|\/)(secrets\.protected\.json|desktop-install\.local\.json|runtime-locations\.json|wechat-locations\.json)$/.test(name)) throw Error('Unexpected local data: ' + name);
  if (name === 'package.json' || name.startsWith('node_modules/')) continue;
  const source = path.join(root, ...name.split('/'));
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
  const bytes = asar.extractFile(archive, name.split('/').join(path.sep));
  if (!bytes.equals(fs.readFileSync(source))) throw Error('Packaged source differs: ' + name);
  checked.push({ path: name, sha256: hash(bytes) });
}
for (const name of ['合同填写小助手.exe', '合同助手MCP.exe']) {
  const source = path.join(root, '代码', '合同助手', 'desktop', 'out', 'desktop-release', name);
  const installed = path.join(application, 'resources', 'contract-resource', name);
  if (hash(fs.readFileSync(source)) !== hash(fs.readFileSync(installed))) throw Error('Contract resource differs: ' + name);
}
const testsLog = fs.readFileSync(path.join(root, 'dist', `tests-full-${metadata.version}.log`), 'utf8');
const tests = { total: Number(testsLog.match(/ℹ tests (\d+)/)?.[1]), passed: Number(testsLog.match(/ℹ pass (\d+)/)?.[1]), failed: Number(testsLog.match(/ℹ fail (\d+)/)?.[1]) };
if (!tests.total || tests.failed || tests.passed !== tests.total) throw Error('Full test suite has not passed');
const smokeFile = path.join(root, 'dist', `smoke-${metadata.version}`, 'desktop-smoke.json');
const smoke = fs.existsSync(smokeFile) ? JSON.parse(fs.readFileSync(smokeFile, 'utf8')) : null;
if (!smoke?.ok || smoke.version !== metadata.version) throw Error('Packaged desktop smoke test has not passed');
const result = { ok: true, version: metadata.version, executableSha256: manifest.sha256, matchedSourceFiles: checked.length,
  noMachineConfiguration: true, contractResourcesMatched: true, tests, desktopSmokePassed: true, checked };
fs.writeFileSync(path.join(release, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, checked: undefined }));
