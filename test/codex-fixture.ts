import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function writeCodexFixture(directory: string) {
  const fixture = join(directory, 'codex-acp');
  writeFileSync(
    fixture,
    `#!${process.execPath}
import { agent, ndJsonStream, RequestError } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/@agentclientprotocol/sdk/dist/acp.js')).href)};
import { Writable } from 'node:stream';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ok';
writeFileSync(${JSON.stringify(join(directory, 'pid'))}, String(process.pid));
const record = (method, params) => appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ method, params }) + '\\n');
let mcp;
let model = 'small';
let reasoning = 'low';
const options = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: model, options: [{group: 'models', name: 'Models', options: [{value: 'small', name: 'Small'}, {value: 'large', name: 'Large'}]}] },
  { id: 'reasoning_effort', name: 'Reasoning', type: 'select', currentValue: reasoning, options: (model === 'small' ? ['low'] : ['medium', 'high']).map(value => ({value, name: value})) }
];
agent().onRequest('initialize', ({params}) => {
  record('initialize', params);
  if (mode === 'crash') process.exit(1);
  if (mode === 'hang') { process.on('SIGTERM', () => {}); return new Promise(() => {}); }
  return { protocolVersion: mode === 'version' ? 999 : 1, agentCapabilities: {}, agentInfo: {name: 'fixture', version: '1'} };
}).onRequest('session/new', ({params}) => {
  record('session/new', params);
  mcp = params.mcpServers[0];
  if (mode === 'auth') throw RequestError.authRequired();
  if (mode === 'malformed') return {sessionId: 42};
  return { sessionId: 'session', configOptions: mode === 'missing-options' ? [] : options() };
}).onRequest('session/set_config_option', ({params}) => {
  record('session/set_config_option', params);
  if (mode !== 'ignore') {
    if (params.configId === 'model') { model = params.value; reasoning = model === 'small' ? 'low' : 'medium'; }
    else reasoning = params.value;
  }
  return { configOptions: options() };
}).onRequest('session/prompt', async ({params}) => {
  record('session/prompt', params);
  writeFileSync('agent-change.txt', params.prompt[0].text);
  if (mode === 'execute-wait') {
    while (!existsSync(${JSON.stringify(join(directory, 'release'))})) await Bun.sleep(20);
  }
  if (mode !== 'execute-missing') {
    const step = (params.prompt[0].text.match(/, step ([^,]+), attempt/) || [])[1];
    const report = () => {
      if (mode === 'route-left' && step === 'classify') return { status: 'completed', output: 'left', summary: 'Fixture route' };
      if (mode === 'route-no-output' && step === 'classify') return { status: 'completed', summary: 'Fixture result' };
      if (mode === 'route-wrong-output' && step === 'classify') return { status: 'completed', output: 'middle', summary: 'Fixture result' };
      if (mode === 'route-stray-output') return { status: 'completed', output: 'left', summary: 'Fixture route' };
      return { status: mode === 'execute-blocked' ? 'blocked' : 'completed', summary: 'Fixture result' };
    };
    const response = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(mcp.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report_result', arguments: report() } }) });
    const body = await response.json();
    if (body.result?.isError || !response.ok) {
      appendFileSync(${JSON.stringify(join(directory, 'tool-errors.txt'))}, ((body.result && body.result.content && body.result.content[0] && body.result.content[0].text) || String(body)) + '\\n');
      throw new Error(JSON.stringify(body));
    }
  }
  if (mode === 'execute-crash') process.exit(1);
  if (mode === 'execute-report-wait') {
    while (!existsSync(${JSON.stringify(join(directory, 'release'))})) await Bun.sleep(20);
  }
  return { stopReason: 'end_turn' };
}).connect(ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  return fixture;
}
