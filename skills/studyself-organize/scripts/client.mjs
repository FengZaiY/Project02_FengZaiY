import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function call(method, input = {}, requestId, env = process.env) {
  const url = new URL(env.STUDYSELF_AGENT_URL || '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('STUDYSELF_AGENT_URL must be the loopback address shown by StudySelf');
  }
  if (!env.STUDYSELF_AGENT_TOKEN) throw new Error('STUDYSELF_AGENT_TOKEN is required');
  const response = await fetch(new URL('/v1/rpc', url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${env.STUDYSELF_AGENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, input, requestId })
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`${result.error?.code || response.status}: ${result.error?.message || 'Request failed'}`);
  return result.value;
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
