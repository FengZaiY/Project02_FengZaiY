import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UUID } from 'builder-util-runtime';
import { Service } from '../src/core/service.mjs';
import { StorageLocation } from '../src/core/storage-location.mjs';
import { createServer } from '../src/server.mjs';
import { legacyLibraryId } from '../src/core/library-directories.mjs';
import { desktopProfilePath, syncRootPath, libraryMarkerPath } from '../src/core/legacy-names.mjs';
import { lockFile, workspaceLock } from '../src/core/workspace-lock.mjs';
import { parseNoteLink, safeNoteLink } from '../src/core/rich-schema.mjs';
import { mindmapFromParsed, serializeMindmap } from '../web/mindmap-model.js';
import { skillExportFiles, skillZip } from '../web/skill-export.js';
import { sha, uuid } from '../src/core/util.mjs';
import JSZip from 'jszip';

const root = path.resolve('artifacts/branding-tests');
fs.mkdirSync(root, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(root, 'case-'));

test('new package and portable Skill use FengZaiY while retaining the prior installer upgrade GUID', async t => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(pkg.name, 'fengzaiy'); assert.equal(lock.name, pkg.name); assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.build.productName, 'FengZaiY'); assert.equal(pkg.build.appId, 'cn.fengzaiy.desktop');
  assert.equal(pkg.build.nsis.guid, UUID.v5('cn.studyself.desktop', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
  assert.ok(pkg.fengzaiyUpdateSource); assert.equal(pkg.studyselfUpdateSource, undefined);
  const service = new Service(temp()); t.after(() => service.close());
  const files = skillExportFiles(service.agents.skillPackage());
  assert.match(files['SKILL.md'], /^---\r?\nname: fengzaiy\r?\n/m);
  assert.ok(!/studyself/i.test(files['SKILL.md'] + files['references/api.md'] + files['references/preferences.md']));
  assert.equal(JSON.parse(files['manifest.json']).name, 'fengzaiy');
  const zip = await JSZip.loadAsync(await skillZip(files).arrayBuffer());
  assert.ok(Object.keys(zip.files).every(name => name.startsWith('fengzaiy/')));
});

test('existing profile and delivery roots retain their location and ambiguous roots are refused', () => {
  const directory = temp();
  assert.equal(desktopProfilePath(directory), path.join(directory, 'FengZaiY'));
  fs.mkdirSync(path.join(directory, 'studyself'));
  assert.equal(desktopProfilePath(directory), path.join(directory, 'studyself'));
  fs.mkdirSync(path.join(directory, 'FengZaiY'));
  assert.throws(() => desktopProfilePath(directory), { code: 'CONFLICT' });
  const delivery = temp();
  assert.equal(syncRootPath(delivery), path.join(delivery, 'FengZaiYSync'));
  fs.mkdirSync(path.join(delivery, 'StudySelfSync'));
  assert.equal(syncRootPath(delivery), path.join(delivery, 'StudySelfSync'));
  fs.mkdirSync(path.join(delivery, 'FengZaiYSync'));
  assert.throws(() => syncRootPath(delivery), { code: 'CONFLICT' });
});

test('new workspace locks exclude older writers and failed acquisition releases only its own lock', () => {
  const directory = temp(), previous = path.join(directory, '.studyself-lock.json'), current = path.join(directory, '.fengzaiy-lock.json');
  const oldRelease = lockFile(previous);
  assert.throws(() => workspaceLock(directory), { code: 'BUSY' }); assert.ok(!fs.existsSync(current)); oldRelease();
  const release = workspaceLock(directory);
  assert.throws(() => lockFile(previous), { code: 'BUSY' }); assert.ok(fs.existsSync(current)); release();
  assert.ok(!fs.existsSync(previous) && !fs.existsSync(current));
  const currentRelease = lockFile(current);
  assert.throws(() => workspaceLock(directory), { code: 'BUSY' }); assert.ok(!fs.existsSync(previous)); currentRelease();
});

test('legacy library markers and immutable content keep the same identity when reopening', async () => {
  const directory = temp(); let service = new Service(directory);
  const library = service.store.saveLibrary({ title: '原知识库' });
  const note = service.store.write({ type: 'note', data: { title: '原笔记', domain: library.id, content: '[旧链接](studyself://note/11111111-1111-1111-1111-111111111111)' } });
  const original = service.store.allEvents();
  const folder = service.store.directories.ensure(library);
  fs.renameSync(libraryMarkerPath(folder), path.join(folder, '.studyself-library.json'));
  await service.close();
  service = new Service(directory);
  try {
    assert.equal(service.store.directories.ensure(library), folder);
    assert.deepEqual(service.store.allEvents(), original);
    assert.equal(service.store.get(note.id).data.content, note.data.content);
    const seed = sha('studyself-legacy-library:旧分类').slice(0, 32);
    assert.equal(legacyLibraryId('旧分类').replaceAll('-', ''), seed);
    fs.writeFileSync(path.join(folder, '.fengzaiy-library.json'), '{}');
    assert.throws(() => service.store.directories.ensure(library), { code: 'CONFLICT' });
  } finally { await service.close(); }
});

test('old incomplete migration markers still prevent opening or initializing a workspace', async () => {
  const directory = temp(); fs.writeFileSync(path.join(directory, '.studyself-incomplete.json'), '{}');
  const location = new StorageLocation(directory);
  try { await assert.rejects(location.open(), /未完成迁移/); assert.ok(!fs.existsSync(path.join(directory, 'knowledge.sqlite'))); }
  finally { location.close(); }
});

test('old note links and mindmap metadata remain readable while newly serialized metadata uses the new name', () => {
  const id = uuid();
  for (const protocol of ['studyself', 'fengzaiy', 'FengZaiY']) for (const kind of ['note', 'asset', 'local']) {
    assert.deepEqual(parseNoteLink(`${protocol}://${kind}/${id}`), { kind, id });
    assert.equal(safeNoteLink(`${protocol}://${kind}/${id}?path=bad`), false);
  }
  const source = 'mindmap\n  %% studyself-mindmap:{"v":1,"layout":"right","palette":"quiet","collapsed":["m0"]}\n  root[主题]';
  const parsed = { descr: '主题', children: [] };
  const model = mindmapFromParsed(source, parsed);
  assert.equal(model.root.collapsed, true); assert.equal(model.layout, 'right');
  const output = serializeMindmap(model);
  assert.match(output, /%% fengzaiy-mindmap:/); assert.ok(!output.includes('studyself'));
  assert.throws(() => mindmapFromParsed(source + '\n%% fengzaiy-mindmap:{}', parsed), /重复布局/);
});

test('both trusted header names authenticate with the same token and protocol mismatch stays explicit', async t => {
  const app = await createServer({ directory: temp(), port: 0 }); t.after(() => app.close());
  for (const header of ['X-FengZaiY-Token', 'X-StudySelf-Token']) {
    const response = await fetch(`${app.url}/api`, { method: 'POST', headers: { [header]: app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'state' }) });
    const result = await response.json(); assert.equal(result.value.uiProtocol, 2);
  }
  const denied = await fetch(`${app.url}/api`, { method: 'POST', headers: { 'X-FengZaiY-Token': 'wrong', 'X-StudySelf-Token': app.token }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'UNAUTHORIZED');
});
