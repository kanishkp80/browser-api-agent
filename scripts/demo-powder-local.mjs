import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

// A real external MCP client. Only the separately running service gets model
// and infrastructure credentials. This process supplies a request and follows it.
const repo = process.cwd();
const directory = resolve(repo, '.browser-api/powder-local-demo');
const statePath = resolve(directory, 'caller-state.json');
const logPath = resolve(directory, 'caller-events.ndjson');
const serviceUrl = 'http://127.0.0.1:8765';
const serviceToken = readFileSync(resolve(directory, 'service-token'), 'utf8').trim();
const pdf = resolve(process.env.POWDER_DEMO_PDF || 'output/pdf/powder-synthetic-brokerage-statement.pdf');
const started = performance.now();
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { cursor: 0 };
let controlBrowser;
let controlPage;
let lastHandoff;
let lastStatus;

function record(event, details = {}) {
  const line = JSON.stringify({ event, elapsed_ms: Math.round(performance.now() - started), ...details }).split(serviceToken).join('[redacted]') + '\n';
  appendFileSync(logPath, line, {mode:0o600});
  process.stdout.write(line);
}
function checkpoint() {
  writeFileSync(statePath, JSON.stringify(state, null, 2), {mode:0o600});
}
const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','TMPDIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(repo, 'dist/mcp.js')],
  cwd: repo,
  env: {...env, BROWSER_API_SERVICE_URL:serviceUrl, BROWSER_API_SERVICE_TOKEN:serviceToken},
  stderr: 'pipe',
});
const client = new Client({name:'powder-local-demo-calling-agent',version:'0.1.0'});
async function call(name, args) {
  const result = await client.callTool({name,arguments:args});
  const body = result.structuredContent ?? JSON.parse(result.content.find(item=>item.type==='text').text);
  if (!body.ok) throw new Error(`${name}: ${body.error.code}: ${body.error.message}`);
  return body.data;
}
async function showHandoff(operation) {
  const handoff = operation.human_action;
  if (lastHandoff === handoff.handoff_id) return;
  lastHandoff = handoff.handoff_id;
  const url = new URL(handoff.control_url);
  if (url.origin !== serviceUrl) throw new Error('Unexpected human control origin');
  record('human_action_required', {operation_id:operation.operation_id, control_url:handoff.control_url, reason:handoff.reason, instructions:handoff.instructions});
  if (!controlBrowser) {
    controlBrowser = await chromium.launch({headless:false});
    const context = await controlBrowser.newContext();
    // Unlock our own control page without putting its service token in a URL
    // or asking the user to handle infrastructure credentials. The human still
    // explicitly claims control and performs the Powder login in its own window.
    await context.addInitScript(({origin,token}) => {
      if (location.origin === origin) sessionStorage.setItem('browser-api-service-token',token);
    }, {origin:serviceUrl,token:serviceToken});
    controlPage = await context.newPage();
  }
  await controlPage.goto(handoff.control_url,{waitUntil:'domcontentloaded'});
  await controlPage.bringToFront();
  record('human_control_page_open', {control_url:handoff.control_url, caller_connected:true, auto_claimed:false});
}

await client.connect(transport);
const tools = await client.listTools();
record('mcp_connected', {transport:'stdio', tools:tools.tools.map(tool=>tool.name)});
if (!state.operation_id) {
  const spec=JSON.parse(readFileSync(resolve(repo,'examples/pilots/powder-pilot-openapi-2026-09-08.json'),'utf8'));
  await call('register_site', {
    site_id:'powder-local-demo', account_id:'powder-test-account',
    base_url:'https://app.powderfi.com/login',
    allowed_origins:['https://powderfi.com','https://www.powderfi.com','https://app.powderfi.com','https://auth.powderfi.com'],
    spec,
  });
  const endpoints = await call('list_endpoints',{site_id:'powder-local-demo'});
  record('endpoint_discovered', {endpoint:endpoints.find(endpoint=>endpoint.key==='file_uploads')?.key});
  const artifact=await call('upload_artifact',{name:basename(pdf),media_type:'application/pdf',data_base64:readFileSync(pdf).toString('base64')});
  record('caller_artifact_uploaded', {artifact_id:artifact.artifact_id,name:artifact.name,bytes:artifact.bytes});
  const operation=await call('execute_endpoint',{
    request_id:'powder-local-brokerage-demo-001', site_id:'powder-local-demo', endpoint:'file_uploads',
    input:{body:{file:{artifact_id:artifact.artifact_id},statement_type:'brokerage'}},
  });
  state={operation_id:operation.operation_id,cursor:0,artifact_id:artifact.artifact_id};
  checkpoint();
  record('request_accepted', {operation_id:state.operation_id});
} else record('caller_reconnected', {operation_id:state.operation_id,cursor:state.cursor});

for (;;) {
  const update=await call('wait_operation',{operation_id:state.operation_id,after:state.cursor,timeout_ms:30_000});
  for (const event of update.events) record('service_event', {sequence:event.sequence,type:event.type,message:event.message});
  state.cursor=update.cursor;
  checkpoint();
  const operation=update.operation;
  const status=JSON.stringify([operation.state,operation.phase,operation.error?.code]);
  if (status!==lastStatus) {
    lastStatus=status;
    record('operation_status',{operation_id:operation.operation_id,state:operation.state,phase:operation.phase,error:operation.error});
  }
  if (operation.state==='waiting_for_human') await showHandoff(operation);
  if (['succeeded','failed','cancelled'].includes(operation.state)) {
    const result=await call('get_result',{operation_id:state.operation_id});
    writeFileSync(resolve(directory,'caller-result.json'),JSON.stringify(result,null,2),{mode:0o600});
    record('operation_finished',{operation_id:state.operation_id,state:operation.state,result_file:resolve(directory,'caller-result.json')});
    await client.close();
    break;
  }
  if (update.events.length===0) record('caller_waiting',{operation_id:state.operation_id,state:operation.state,caller_connected:true});
}
