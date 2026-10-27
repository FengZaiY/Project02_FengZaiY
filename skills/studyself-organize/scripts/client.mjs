import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function call(method, input = {}, requestId, env = process.env) {
  const url = new URL(env.STUDYSELF_AGENT_URL || '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('STUDYSELF_AGENT_URL must be the loopback address shown by FengZai·Y');
  }
  if (!['/', '/mcp'].includes(url.pathname)) throw new Error('STUDYSELF_AGENT_URL must point to /mcp');
  if (!env.STUDYSELF_AGENT_TOKEN) throw new Error('STUDYSELF_AGENT_TOKEN is required');
  const signal = AbortSignal.timeout(30000);
  let protocol;
  async function send(method, params, notification = false) {
    const id = notification ? undefined : randomUUID();
    const response = await fetch(new URL('/mcp', url), {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${env.STUDYSELF_AGENT_TOKEN}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close',
        ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    if (notification && response.status === 202) return;
    const message = await response.json();
    if (!response.ok || message.error) throw new Error(`${message.error?.data?.code || 'INVALID'}: ${message.error?.message || 'MCP request failed'}`);
    if (message.jsonrpc !== '2.0' || message.id !== id) throw new Error('INVALID: MCP response does not match request');
    return message.result;
  }
  const initialized = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'studyself-skill', version: '1.0.0' } });
  protocol = initialized.protocolVersion;
  if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(protocol)) throw new Error('INVALID: Unsupported MCP protocol version');
  await send('notifications/initialized', {}, true);
  const name = `studyself_${method.replace(/[A-Z]/g, value => `_${value.toLowerCase()}`)}`;
  const tools = await send('tools/list', {});
  if (!tools.tools?.some(tool => tool.name === name)) throw new Error('FORBIDDEN: MCP 未提供此工具');
  const result = await send('tools/call', { name, arguments: { ...input, ...(requestId === undefined ? {} : { requestId }) } });
  if (result.isError) {
    const text = result.content?.find(item => item.type === 'text')?.text || 'MCP tool failed';
    let failure;
    try { failure = JSON.parse(text).error; } catch {}
    throw new Error(`${failure?.code || 'INVALID'}: ${failure?.message || text}`);
  }
  if (result.structuredContent && Object.hasOwn(result.structuredContent, 'value')) return result.structuredContent.value;
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), method = args[0];
    if (!method) throw new Error('Usage: client.mjs <method> [--input file.json] [--request-id id]');
    const index = args.indexOf('--input'), request = args.indexOf('--request-id');
    const input = index < 0 ? {} : JSON.parse(fs.readFileSync(args[index + 1], 'utf8').replace(/^\uFEFF/, ''));
    console.log(JSON.stringify(await call(method, input, request < 0 ? undefined : args[request + 1]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
