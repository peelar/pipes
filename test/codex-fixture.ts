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
import { appendFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'ok';
writeFileSync(${JSON.stringify(join(directory, 'pid'))}, String(process.pid));
const record = (method, params) => appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))}, JSON.stringify({ method, params }) + '\\n');
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
}).connect(ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  return fixture;
}
