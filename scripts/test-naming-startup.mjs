import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Service } from '../src/core/service.mjs';
import { UI_PROTOCOL } from '../src/core/ui-protocol.mjs';

const root = path.resolve('artifacts/fengzaiy-naming'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'startup-'));
const service = new Service(directory);
const library = service.store.saveLibrary({ title: '启动原库' });
const note = service.store.write({ type: 'note', data: { title: '保留原笔记', domain: library.id, content: '命名变更不会创建空工作区' } });
const events = service.store.allEvents(); await service.close();
const wrong = path.join(directory, 'must-not-be-opened');
const child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), windowsHide: true,
  env: { ...process.env, PORT: '0', FENGZAIY_DATA: directory, STUDYSELF_DATA: wrong }, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = once(child, 'close');
let output = '', errors = '';
child.stderr.on('data', data => { errors += data; });
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI startup timed out: ${errors}`)), 20000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); reject(new Error(`CLI startup exited ${code}: ${errors}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/FengZaiY preview: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const html = await (await fetch(url)).text(), token = html.match(/name="local-token" content="([^"]+)"/)?.[1];
  assert.ok(token);
  const call = async (method, input = {}) => (await (await fetch(`${url}/api`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FengZaiY-Token': token }, body: JSON.stringify({ method, input }) })).json()).value;
  const state = await call('state');
  assert.equal(state.localDataDirectory, directory); assert.equal(state.uiProtocol, UI_PROTOCOL);
  assert.equal(state.counts.note, 1); assert.equal(state.libraries[0].id, library.id);
  assert.equal((await call('record', { id: note.id })).data.content, note.data.content);
  assert.ok(!fs.existsSync(wrong));
  console.log(JSON.stringify({ result: 'PASS', configuration: 'FENGZAIY_DATA', directory, uiProtocol: state.uiProtocol, preservedNote: note.id, legacyFallbackIgnored: true }));
} finally { if (child.exitCode === null) child.kill(); await closed; }
const reopened = new Service(directory);
try { assert.deepEqual(reopened.store.allEvents(), events); console.log('PASS: CLI main entry selects FENGZAIY_DATA and retains exact original events.'); }
finally { await reopened.close(); }
