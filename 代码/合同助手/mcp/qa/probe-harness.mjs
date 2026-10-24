import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire('file:///F:/deepseek%20harness/resources/app.asar/dsh/package.json');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const executable = process.argv[2];
const output = process.argv[3];
const client = new Client({ name: 'contract-helper-harness-check', version: '1.0.0' }, { capabilities: {} });
try {
  await client.connect(new StdioClientTransport({ command: executable, args: ['--output-dir', output, '--data-dir', output + '/isolated-harness-data'] }));
  const listed = await client.listTools();
  const { assertSupportedJsonSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  for (const tool of listed.tools) assertSupportedJsonSchema(tool.inputSchema);
  const result = await client.callTool({ name: 'get_contract_schema', arguments: {} });
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  const resources = await client.listResources();
  const report = { passed: true, client: 'DeepSeek Harness bundled MCP SDK 2.2.0', harnessSchemaValidation: true, tools: listed.tools.map(t => t.name), buyer: data.locked_fields['甲方名称'], resourceCount: resources.resources.length };
  if (process.argv[4]) {
    const opened = await client.callTool({ name: 'open_contract_desktop', arguments: { progress_path: process.argv[4] } });
    if (opened.isError) throw new Error(opened.content[0].text);
    report.desktop = opened.structuredContent ?? JSON.parse(opened.content[0].text);
  }
  if (report.tools.length !== 28 || report.buyer !== '上海交通大学') throw new Error('Incomplete server discovery.');
  fs.writeFileSync(output + '/harness-sdk-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await client.close(); }
