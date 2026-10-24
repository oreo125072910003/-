import fs from 'node:fs';
import { createRequire } from 'node:module';
const root = 'F:/deepseek harness/resources/app.asar/dsh/node_modules/';
const { parse } = await import('file:///F:/deepseek%20harness/resources/app.asar/dsh/node_modules/yaml/dist/index.js');
for (const profile of ['desktop', 'headless']) {
  const rows = parse(fs.readFileSync(`C:/Users/ADMIN/.dsh/profiles/${profile}/cordis.patch.yml`, 'utf8'));
  const found = [];
  function visit(items) {
    for (const row of items ?? []) {
      if (/mcp/.test(`${row.id ?? ''} ${row.name ?? ''}`)) found.push({ id: row.id, name: row.name, configKeys: Object.keys(row.config ?? {}) });
      visit(row.insert); visit(row.children);
    }
  }
  visit(rows); console.log(JSON.stringify({ profile, mcp: found }));
}
const pkg = JSON.parse(fs.readFileSync(root + '@modelcontextprotocol/client/package.json', 'utf8'));
const require = createRequire('file:///F:/deepseek%20harness/resources/app.asar/dsh/package.json');
console.log(JSON.stringify({ version: pkg.version, exports: pkg.exports, entry: require.resolve('@modelcontextprotocol/client'), stdio: require.resolve('@modelcontextprotocol/client/stdio') }));
