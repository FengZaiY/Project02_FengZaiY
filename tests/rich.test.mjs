import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { Store, validateEvent } from '../src/core/store.mjs';
import { FolderTransport, makePairingKey } from '../src/core/transport.mjs';
import { BackupManager } from '../src/core/backup.mjs';
import { createServer } from '../src/server.mjs';
import { richReferences } from '../src/core/rich-content.mjs';
import { validateBlock, validateLayout, parseNoteLink, safeNoteLink, encodeBlock } from '../src/core/rich-schema.mjs';
import { uuid, sha } from '../src/core/util.mjs';
import { call } from '../skills/studyself-organize/scripts/client.mjs';

const root = path.resolve('artifacts/rich-tests'); fs.mkdirSync(root, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(root, 'case-'));
const blockHtml = block => `<figure data-ss-block="${JSON.stringify(block).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"><figcaption>${block.label}</figcaption></figure>`;
const fixture = { v: 1, kind: 'formula', label: '公式', source: 'x^2 + y^2 = z^2' };

test('rich schemas validate bounded shapes and safe portable links', () => {
  assert.deepEqual(validateBlock(fixture), fixture);
  const arrows = { v: 1, kind: 'diagram', label: '箭头', source: 'flowchart TD\n A-->B' };
  assert.ok(!encodeBlock(arrows).includes('-->')); assert.deepEqual(JSON.parse(encodeBlock(arrows)), arrows);
  assert.throws(() => validateBlock({ ...fixture, v: 2 }));
  assert.throws(() => validateBlock({ ...fixture, path: 'C:/secret' }));
  assert.throws(() => validateBlock({ v: 1, kind: 'image', label: 'bad', assetId: 'file:///C:/secret' }));
  assert.throws(() => validateBlock({ v: 1, kind: 'canvas', label: 'bad', shapes: [{ type: 'rect', id: '1', x: Infinity, y: 0, width: 1, height: 1, text: '', fill: '#123456' }] }));
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://user:pass@example.com', 'studyself://note/not-an-id']) assert.equal(safeNoteLink(url), false);
  const id = uuid(); assert.deepEqual(parseNoteLink(`studyself://note/${id}`), { kind: 'note', id });
  assert.equal(safeNoteLink('https://example.com/report.pdf'), true);
});

test('HTML parser discovers embedded media, encoded links and Markdown links independently of declared IDs', () => {
  const asset = uuid(), note = uuid(), local = uuid();
  const content = blockHtml({ v: 1, kind: 'image', label: '图', assetId: asset }) + `<a href="studyself&#58;//note/${note}">笔记</a><a href="studyself://local/${local}">本机文件</a>`;
  assert.deepEqual(new Set(richReferences({ content, format: 'html' }).refs), new Set([asset, note]));
  assert.deepEqual(richReferences({ content: `[笔记](studyself://note/${note})` }).refs, [note]);
  assert.deepEqual(richReferences({ url: `studyself://asset/${asset}` }).assets, [asset]);
});

test('layout metadata is bounded and nested rows retain all attachment references', () => {
  assert.deepEqual(validateLayout({ width: 50, height: null, align: 'center' }), { width: 50, height: null, align: 'center' });
  for (const layout of [{ width: 0, height: null, align: 'left' }, { width: 50, height: 2000, align: 'left' },
    { width: 50, height: null, align: 'url(file:secret)' }, { width: 50, height: null, align: 'left', path: 'C:/private' }]) assert.throws(() => validateLayout(layout));
  const id = uuid(), another = uuid();
  const content = `<div data-ss-row="true"><section data-ss-container="true" data-ss-layout="{&quot;width&quot;:50,&quot;height&quot;:null,&quot;align&quot;:&quot;left&quot;}"><p><a href="studyself://asset/${another}">附件</a></p></section>${blockHtml({ v: 1, kind: 'image', label: '图', assetId: id })}</div>`;
  assert.deepEqual(new Set(richReferences({ content, format: 'html' }).assets), new Set([id, another]));
  assert.throws(() => richReferences({ content: '<section data-ss-layout="{&quot;width&quot;:999}"></section>', format: 'html' }));
});

test('embedded references allow all libraries and sensitivity while checking existence and idempotency', async t => {
  const service = new Service(temp()); t.after(() => service.close());
  const store = service.store, a = store.saveLibrary({ title: '可访问' }), b = store.saveLibrary({ title: '未授权' });
  const other = store.write({ type: 'note', data: { title: '另一库', domain: b.data.domain, content: 'private' } });
  const sensitive = store.write({ type: 'asset', data: { title: '敏感图片', domain: a.data.domain, sensitive: true, filename: 'secret.png', mime: 'image/png', size: 1, sha256: sha('x'), priority: 'normal' } });
  const grant = service.agents.createGrant({ name: '测试', domains: [a.data.domain] }); await service.agents.configure(true);
  const env = { STUDYSELF_AGENT_URL: service.agents.status().url, STUDYSELF_AGENT_TOKEN: grant.token };
  const rpc = (method, input, requestId) => call(method, input, requestId, env);
  const write = data => rpc('draftCreate', { data, preferencesVersion: service.agents.preferences().version }, uuid());
  for (const content of [`<a href="studyself://note/${other.id}">链接</a>`, blockHtml({ v: 1, kind: 'image', label: '图', assetId: sensitive.id })]) {
    const data = { title: '嵌入引用', domain: a.data.domain, format: 'html', content };
    assert.equal((await write(data)).data.content, content);
    const old = store.write({ type: 'note', data });
    assert.equal((await rpc('record', { id: old.id })).id, old.id);
    store.write({ id: old.id, type: 'note', parents: old.heads, data: { ...data, content: '公开正文', assetIds: [] } });
    assert.equal((await rpc('history', { id: old.id })).length, 2);
  }
  await assert.rejects(rpc('sourceCreate', { data: { title: '缺失引用', domain: a.data.domain, url: `studyself://note/${uuid()}` }, preferencesVersion: service.agents.preferences().version }, uuid()), /FORBIDDEN/);
  const data = { title: '公式', domain: a.data.domain, format: 'html', content: blockHtml(fixture) }, requestId = uuid();
  const input = { data, preferencesVersion: service.agents.preferences().version };
  const first = await rpc('draftCreate', input, requestId), replay = await rpc('draftCreate', input, requestId);
  assert.deepEqual(first, replay); assert.equal(store.list({ type: 'draft' }).length, 3);
  service.agents.revoke(grant.id); await assert.rejects(rpc('draftCreate', input, requestId), /UNAUTHORIZED/);
});

test('rich HTML survives history, encrypted transfer and independent restore; local file bindings stay local', async t => {
  const directory = temp(), a = new Store(path.join(directory, 'a')), b = new Store(path.join(directory, 'b')), c = new Store(path.join(directory, 'c'));
  t.after(() => { a.close(); b.close(); c.close(); });
  const content = '<h6>六级标题</h6><aside data-callout="note"><p>重点</p></aside>' + blockHtml(fixture)
    + blockHtml({ v: 1, kind: 'canvas', label: '画板', shapes: [{ id: 'one', type: 'rect', x: -300, y: 40, width: 180, height: 90, text: '可编辑', fill: '#d8efe8' }] });
  const note = a.write({ type: 'note', data: { title: '富内容', domain: '测试', content, format: 'html' } });
  const original = a.history(note.id)[0]; validateEvent(original);
  a.local('localFileLinks', { [uuid()]: 'C:\\private\\report.pdf' });
  const folder = path.join(directory, 'transfer'), key = makePairingKey();
  const ta = new FolderTransport(a), tb = new FolderTransport(b); ta.configure(folder, key); tb.configure(folder, key);
  await ta.cycle(); await tb.cycle(); assert.equal(b.get(note.id).data.content, content); assert.equal(b.local('localFileLinks'), null);
  const backup = await new BackupManager(a).create(path.join(directory, 'backups'), true);
  await new BackupManager(c).restore(backup.directory); assert.equal(c.get(note.id).data.content, content); assert.equal(c.local('localFileLinks'), null);
  assert.deepEqual(c.history(note.id)[0], original);
});

test('media endpoint authenticates, supports bounded ranges and rejects tampered/deleted files', async t => {
  const app = await createServer({ directory: temp(), port: 0 }); t.after(() => app.close());
  const file = path.join(app.service.store.directory, 'test.webm'), bytes = Buffer.from('media-test-bytes'); fs.writeFileSync(file, bytes);
  const asset = await app.service.call('assetImport', { path: file, domain: '测试' });
  const url = `${app.url}/media/${asset.id}?token=${app.token}`;
  assert.equal((await fetch(`${app.url}/media/${asset.id}`)).status, 403);
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 400);
  const response = await fetch(url, { headers: { Range: 'bytes=2-5' } }); assert.equal(response.status, 206); assert.equal(await response.text(), bytes.subarray(2, 6).toString());
  const suffix = await fetch(url, { headers: { Range: 'bytes=-5' } }); assert.equal(await suffix.text(), bytes.subarray(-5).toString());
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-1000' } })).status, 416);
  assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
  assert.equal((await fetch(url, { method: 'POST' })).status, 400);
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal(await head.text(), '');
  const location = app.service.store.assetLocation(asset.id); fs.writeFileSync(location.path, Buffer.alloc(bytes.length, 'X'));
  assert.equal((await fetch(url)).status, 400);
  fs.writeFileSync(location.path, bytes); app.service.store.remove(asset.id, asset.heads); assert.equal((await fetch(url)).status, 400);
});
