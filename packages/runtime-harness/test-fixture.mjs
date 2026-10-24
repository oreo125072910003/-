// Offline protocol fixture. This process never opens a network connection or calls a model.
import readline from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
if (process.argv.includes('--version')) { console.log(process.env.FIXTURE_VERSION || '0.2.1-rc.2'); process.exit(0); }
const home = process.env.DSH_HOME;
const scenario = process.env.FIXTURE_CASE || 'success';
const trace = path.join(home, 'fixture-trace.jsonl');
const log = data => appendFileSync(trace, JSON.stringify(data) + '\n');
log({ type: 'start', pid: process.pid, home, parentSecret: Boolean(process.env.RUNTIME_PARENT_SECRET), explicitKey: process.env.DEEPSEEK_API_KEY || null, args: process.argv.slice(2), telemetry: process.env.DSH_TELEMETRY_MODE });
let session;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (message, result) => send({ id: message.id, result });
const event = (type, data, sessionId = session) => send({ method: 'session.event', params: { sessionId, event: { type, data } } });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  log({ type: 'request', method: message.method });
  if (message.method === 'initialize') {
    if (scenario === 'initialize-hang') return;
    reply(message, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
  } else if (message.method === 'session/resume') {
    let stored; try { stored = JSON.parse(readFileSync(path.join(home, 'fixture-session.json'), 'utf8')); } catch {}
    if (stored?.sessionId !== message.params.sessionId) send({ id: message.id, error: { code: -32000, message: 'missing persisted session' } });
    else {
      if (scenario === 'resume-stale') event('assistant/message', { message: { content: [{ type: 'text', text: 'STALE RESTORED ANSWER' }] } }, message.params.sessionId);
      reply(message, {});
    }
  } else if (message.method === 'session/prompt') {
    log({ type: 'prompt', text: message.params.contentBlocks[0]?.text });
    session = message.params.sessionId;
    writeFileSync(path.join(home, 'fixture-session.json'), JSON.stringify({ sessionId: session }));
    event('assistant/message', { message: { content: [{ type: 'text', text: 'OTHER SESSION PRIVATE' }] } }, 'unrelated-session');
    reply(message, { messageId: 'queued-prompt' });
    if (scenario === 'crash') { process.stderr.write('simulated private stderr'); process.exit(9); }
    event('agent/inbox/spliced', { inserted: [{ id: 'queued-prompt' }] });
    if (scenario === 'hang' || scenario === 'ignore-eof') return;
    if (scenario === 'tool-call') event('tool/call', { name: 'shell', arguments: { command: 'not executed by fixture' } });
    if (scenario === 'malformed') event('assistant/message', { message: {} });
    else if (scenario !== 'empty' && scenario !== 'resume-stale') event('assistant/message', { message: { content: [{ type: 'text', text: '真实协议夹具回答' }] }, usage: { inputTokens: 7, outputTokens: 9 } });
    event('turn/end', { reason: { kind: scenario === 'model-error' ? 'error' : scenario === 'truncated' ? 'max-tokens' : 'completed' } });
  } else if (message.method === 'session/wait') {
    if (scenario !== 'hang' && scenario !== 'ignore-eof') setTimeout(() => reply(message, {}), 15);
  } else if (message.method === 'shutdown') {
    reply(message, {}); setTimeout(() => process.exit(0), 10);
  }
});
rl.on('close', () => { if (scenario === 'ignore-eof') setInterval(() => {}, 1000); else process.exit(0); });
