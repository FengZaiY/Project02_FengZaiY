import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';
import { skillExportFiles } from '../web/skill-export.js';
import { lockFile } from '../src/core/workspace-lock.mjs';
import { sha } from '../src/core/util.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fengzaiy-skill-'));
  const service = new Service(path.join(root, 'workspace'));
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const manager = service.skillInstallations;
  function install(name = 'agent') {
    const directory = path.join(root, name, 'fengzaiy'); fs.mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(skillExportFiles(service.agents.skillPackage()))) {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), content);
    }
    return directory;
  }
  function confirm(input) { return manager.confirm({ token: manager.preview(input).token, confirmed: true }); }
  function preference(content) { service.agents.savePreferences({ content, parents: service.agents.preferences().heads }); }
  return { root, service, manager, install, confirm, preference };
}

test('legacy installation names retain ownership and pause updates until the renamed Skill is installed', t => {
  const { manager, install, confirm } = setup(t);
  const fresh = install(), directory = path.join(path.dirname(fresh), 'studyself-organize');
  fs.renameSync(fresh, directory);
  const entry = path.join(directory, 'SKILL.md');
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace('name: fengzaiy', 'name: studyself-organize'));
  fs.writeFileSync(path.join(directory, 'extra.txt'), 'keep');
  const linked = confirm({ directory });
  fs.renameSync(path.join(directory, '.fengzaiy-install.json'), path.join(directory, '.studyself-install.json'));
  assert.equal(manager.check()[0].status, 'rename-required');
  assert.throws(() => confirm({ id: linked.id, action: 'update' }), { code: 'RETIRED' });
  assert.throws(() => manager.configure({ id: linked.id, mode: 'auto', confirmed: true }), { code: 'RETIRED' });
  manager.check({ automatic: true });
  assert.match(fs.readFileSync(entry, 'utf8'), /name: studyself-organize/);
  assert.equal(fs.readFileSync(path.join(directory, 'extra.txt'), 'utf8'), 'keep');
  manager.unlink({ id: linked.id, confirmed: true });
  assert.ok(!fs.existsSync(path.join(directory, '.studyself-install.json')));
  const renamed = install('renamed');
  assert.equal(confirm({ directory: renamed }).status, 'current');
});

test('existing installations are explicit, local and update exactly the export package while preserving other files', t => {
  const { manager, install, confirm, preference, service } = setup(t);
  const directory = install(); fs.writeFileSync(path.join(directory, 'my-notes.txt'), 'keep');
  const linked = confirm({ directory }); assert.equal(linked.mode, 'manual'); assert.equal(linked.status, 'current');
  preference('新的个人规则');
  assert.equal(manager.check()[0].status, 'outdated');
  assert.equal(service.state().skillInstallations.attention, 1);
  const preview = manager.preview({ id: linked.id, action: 'update' });
  assert.deepEqual(preview.files.sort(), ['manifest.json', 'references/preferences.md']);
  const result = manager.confirm({ token: preview.token, confirmed: true });
  assert.equal(result.status, 'current'); assert.equal(result.canRestore, true);
  for (const [name, content] of Object.entries(skillExportFiles(service.agents.skillPackage()))) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), content);
  assert.equal(fs.readFileSync(path.join(directory, 'my-notes.txt'), 'utf8'), 'keep');
  assert.equal(service.store.list({ type: 'agentPreferences' }).length, 1);
  assert.equal(manager.list()[0].backup, undefined);
  assert.throws(() => manager.confirm({ token: preview.token, confirmed: true }), /预览已失效/);
  manager.unlink({ id: linked.id, confirmed: true });
  assert.equal(manager.list().length, 0); assert.ok(fs.existsSync(path.join(directory, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(directory, '.fengzaiy-install.json')));
});

test('automatic mode updates only opted-in unchanged installations, pauses hand edits and supports explicit restore', t => {
  const { manager, install, confirm, preference } = setup(t);
  const a = confirm({ directory: install('a') }), b = confirm({ directory: install('b') });
  manager.configure({ id: a.id, mode: 'auto', confirmed: true });
  preference('version two'); manager.tick();
  assert.equal(manager.list().find(i => i.id === a.id).status, 'current');
  assert.equal(manager.list().find(i => i.id === b.id).status, 'outdated');
  const file = path.join(a.directory, 'references/api.md'); fs.appendFileSync(file, '\nmanual change');
  preference('version three'); manager.check({ automatic: true });
  assert.equal(manager.list()[0].status, 'modified'); assert.match(fs.readFileSync(file, 'utf8'), /manual change/);
  const preview = manager.preview({ id: a.id, action: 'update' }); assert.deepEqual(preview.modified, ['references/api.md']);
  manager.confirm({ token: preview.token, confirmed: true }); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /manual change/);
  confirm({ id: a.id, action: 'restore' });
  assert.match(fs.readFileSync(file, 'utf8'), /manual change/); assert.equal(manager.list()[0].mode, 'manual');
  manager.check({ automatic: true }); assert.match(fs.readFileSync(file, 'utf8'), /manual change/);
});

test('stale previews, missing confirmation, other workspaces and concurrent writers cannot overwrite files', t => {
  const { manager, install, confirm, preference, root } = setup(t);
  const directory = install(), linked = confirm({ directory }); preference('changed');
  const input = { id: linked.id, action: 'update' };
  const preview = manager.preview(input);
  assert.throws(() => manager.confirm({ token: preview.token }), /确认/);
  fs.appendFileSync(path.join(directory, 'references/api.md'), '\nhand edit');
  assert.throws(() => manager.confirm({ token: preview.token, confirmed: true }), /已变化/);
  const changed = manager.preview(input); preference('another');
  assert.throws(() => manager.confirm({ token: changed.token, confirmed: true }), /已变化/);
  const settings = manager.preview(input); manager.configure({ id: linked.id, mode: 'auto', confirmed: true });
  assert.throws(() => manager.confirm({ token: settings.token, confirmed: true }), /设置已变化/);
  const release = lockFile(path.join(directory, '.fengzaiy-update.lock'));
  try { assert.throws(() => confirm(input), /另一个实例/); } finally { release(); }
  const other = new Service(path.join(root, 'other'));
  try { assert.throws(() => other.skillInstallations.preview({ directory }), /另一个工作区/); } finally { other.close(); }
  fs.renameSync(directory, directory + '-moved');
  assert.equal(manager.check()[0].status, 'error');
  manager.unlink({ id: linked.id, confirmed: true }); assert.equal(manager.list().length, 0);
});

test('unknown folders, source workspace, oversized files, symlinks and hardlinks are rejected', t => {
  const { manager, install, root, service } = setup(t);
  const directory = install();
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'not a skill'); assert.throws(() => manager.preview({ directory }), /不是/);
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'x'.repeat(1024 * 1024 + 1)); assert.throws(() => manager.preview({ directory }), /大小/);
  assert.throws(() => manager.preview({ directory: 'relative/FengZaiY' }), /完整目录/);
  const nested = path.join(service.store.directory, 'fengzaiy'); fs.mkdirSync(nested);
  assert.throws(() => manager.preview({ directory: nested }), /工作区/);
  const actual = install('actual'), linked = path.join(root, 'linked', 'fengzaiy'); fs.mkdirSync(path.dirname(linked));
  fs.symlinkSync(actual, linked, 'junction');
  assert.throws(() => manager.preview({ directory: linked }), /链接/);
  const hard = path.join(actual, 'references/api.md'); fs.unlinkSync(hard); fs.linkSync(path.join(actual, 'SKILL.md'), hard);
  assert.throws(() => manager.preview({ directory: actual }), /硬链接/);
});

test('partial write failure rolls back previous files and disables automatic updates', t => {
  const { manager, install, confirm, preference } = setup(t);
  const directory = install(), linked = confirm({ directory }); preference('will fail');
  const old = fs.readFileSync(path.join(directory, 'references/preferences.md'), 'utf8');
  const original = fs.renameSync; let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(directory, 'manifest.json') && !failed) { failed = true; throw new Error('injected disk failure'); }
    return original(from, to);
  });
  assert.throws(() => confirm({ id: linked.id, action: 'update' }), /injected disk/);
  assert.equal(fs.readFileSync(path.join(directory, 'references/preferences.md'), 'utf8'), old);
  assert.equal(manager.list()[0].mode, 'manual'); assert.equal(manager.list()[0].status, 'error');
  assert.equal(manager.records()[0].journal, null);
});

test('restart recovers a durable interrupted write, but retains an externally modified recovery conflict', async t => {
  const { manager, install, confirm, service } = setup(t);
  const directory = install(), linked = confirm({ directory });
  const names = Object.keys(manager.records()[0].hashes), before = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(directory, name)).toString('base64')]));
  const after = { ...before, 'references/api.md': Buffer.from('interrupted').toString('base64') };
  const record = manager.records()[0]; record.journal = { before, after }; record.mode = 'auto'; manager.save(record);
  fs.writeFileSync(path.join(directory, 'references/api.md'), 'interrupted');
  const workspace = service.store.directory; await service.close();
  const reopened = new Service(workspace);
  try {
    reopened.skillInstallations.tick();
    assert.equal(fs.readFileSync(path.join(directory, 'references/api.md')).toString('base64'), before['references/api.md']);
    assert.equal(reopened.skillInstallations.list()[0].mode, 'manual');
    const conflicted = reopened.skillInstallations.records()[0]; conflicted.journal = { before, after }; reopened.skillInstallations.save(conflicted);
    fs.writeFileSync(path.join(directory, 'references/api.md'), 'external after crash');
    reopened.skillInstallations.check();
    assert.match(reopened.skillInstallations.list()[0].error, /中断后文件又被修改/);
    assert.throws(() => reopened.skillInstallations.unlink({ id: linked.id, confirmed: true }), /未完成/);
    assert.equal(fs.readFileSync(path.join(directory, 'references/api.md'), 'utf8'), 'external after crash');
    const preview = reopened.skillInstallations.preview({ id: linked.id, action: 'restore' });
    assert.ok(preview.modified.includes('references/api.md'));
    reopened.skillInstallations.confirm({ token: preview.token, confirmed: true });
    assert.equal(fs.readFileSync(path.join(directory, 'references/api.md')).toString('base64'), before['references/api.md']);
    assert.equal(Buffer.from(reopened.skillInstallations.records()[0].backup.files['references/api.md'], 'base64').toString(), 'external after crash');
  } finally { await reopened.close(); }
});

test('legacy installation without a manifest can update and restore without deleting extra files', t => {
  const { manager, install, confirm } = setup(t);
  const directory = install(); fs.unlinkSync(path.join(directory, 'manifest.json'));
  fs.unlinkSync(path.join(directory, 'scripts/client.mjs')); fs.writeFileSync(path.join(directory, 'scripts/custom.txt'), 'keep');
  const linked = confirm({ directory }); assert.equal(linked.status, 'incomplete');
  confirm({ id: linked.id, action: 'update' }); assert.ok(fs.existsSync(path.join(directory, 'scripts/client.mjs')));
  confirm({ id: linked.id, action: 'restore' }); assert.ok(!fs.existsSync(path.join(directory, 'scripts/client.mjs')));
  assert.equal(fs.readFileSync(path.join(directory, 'scripts/custom.txt'), 'utf8'), 'keep');
});

test('missing owned package files pause automatic writes and support confirmed repair and restore', t => {
  const { manager, install, confirm, service } = setup(t);
  const directory = install(), linked = confirm({ directory });
  const files = Object.keys(skillExportFiles(service.agents.skillPackage()));
  fs.writeFileSync(path.join(directory, '_user_meta.json'), '{"keep":true}');
  manager.configure({ id: linked.id, mode: 'auto', confirmed: true });
  for (const name of files) fs.unlinkSync(path.join(directory, name));
  const state = manager.check({ automatic: true })[0];
  assert.equal(state.status, 'incomplete'); assert.deepEqual(state.missingFiles.sort(), files.sort());
  for (const name of files) assert.ok(!fs.existsSync(path.join(directory, name)));
  assert.throws(() => manager.preview({ id: linked.id, action: 'update' }), /缺少 SKILL.md/);
  const preview = manager.preview({ id: linked.id, action: 'repair' });
  assert.deepEqual(preview.missing.sort(), files.sort());
  assert.throws(() => manager.confirm({ token: preview.token }), /确认/);
  assert.ok(!fs.existsSync(path.join(directory, 'SKILL.md')));
  const repaired = manager.confirm({ token: preview.token, confirmed: true });
  assert.equal(repaired.status, 'current'); assert.deepEqual(repaired.missingFiles, []);
  for (const [name, content] of Object.entries(skillExportFiles(service.agents.skillPackage()))) {
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), content);
  }
  assert.equal(fs.readFileSync(path.join(directory, '_user_meta.json'), 'utf8'), '{"keep":true}');
  assert.throws(() => manager.preview({ id: linked.id, action: 'repair' }), /已补全/);
  assert.deepEqual(manager.preview({ id: linked.id, action: 'restore' }).targetMissing.sort(), files.sort());
  const restored = confirm({ id: linked.id, action: 'restore' });
  assert.equal(restored.status, 'incomplete'); assert.equal(restored.mode, 'manual');
  assert.equal(manager.check({ automatic: true })[0].status, 'incomplete');
  assert.ok(!fs.existsSync(path.join(directory, 'SKILL.md')));
  assert.equal(confirm({ id: linked.id, action: 'repair' }).status, 'current');
});

test('repair requires existing ownership and rejects changed previews or a different Skill identity', t => {
  const { manager, install, confirm } = setup(t);
  const unknown = install('unknown'); fs.unlinkSync(path.join(unknown, 'SKILL.md'));
  assert.throws(() => manager.preview({ directory: unknown }), /缺少 SKILL.md/);
  assert.throws(() => manager.preview({ directory: unknown, action: 'repair' }), /关联不存在/);
  const directory = install(), linked = confirm({ directory });
  fs.unlinkSync(path.join(directory, 'SKILL.md'));
  fs.appendFileSync(path.join(directory, 'references/api.md'), '\nmanual');
  const preview = manager.preview({ id: linked.id, action: 'repair' });
  assert.ok(preview.modified.includes('references/api.md'));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: other-skill\n---\n');
  assert.throws(() => manager.confirm({ token: preview.token, confirmed: true }), /已变化/);
  assert.throws(() => manager.preview({ id: linked.id, action: 'repair' }), /已补全/);
  fs.unlinkSync(path.join(directory, 'manifest.json'));
  assert.throws(() => manager.preview({ id: linked.id, action: 'repair' }), /不是/);
  assert.equal(manager.check()[0].status, 'error');
  fs.unlinkSync(path.join(directory, 'SKILL.md'));
  const changedMarker = manager.preview({ id: linked.id, action: 'repair' });
  fs.writeFileSync(path.join(directory, '.fengzaiy-install.json'), '{}');
  assert.throws(() => manager.confirm({ token: changedMarker.token, confirmed: true }), /归属已变化/);
  assert.throws(() => manager.preview({ id: linked.id, action: 'repair' }), /归属已变化/);
  assert.equal(manager.check({ automatic: true })[0].status, 'error');
  assert.ok(!fs.existsSync(path.join(directory, 'SKILL.md')));
  assert.match(fs.readFileSync(path.join(directory, 'references/api.md'), 'utf8'), /manual/);
});

test('repair write failure restores missing files and preserves existing customizations', t => {
  const { manager, install, confirm } = setup(t);
  const directory = install(), linked = confirm({ directory });
  fs.unlinkSync(path.join(directory, 'SKILL.md'));
  fs.unlinkSync(path.join(directory, 'manifest.json'));
  fs.appendFileSync(path.join(directory, 'references/api.md'), '\nmanual');
  const old = fs.readFileSync(path.join(directory, 'references/api.md'), 'utf8');
  const rename = fs.renameSync; let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(directory, 'manifest.json') && !failed) { failed = true; throw new Error('injected disk failure'); }
    return rename(from, to);
  });
  assert.throws(() => confirm({ id: linked.id, action: 'repair' }), /injected disk/);
  assert.ok(!fs.existsSync(path.join(directory, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(directory, 'manifest.json')));
  assert.equal(fs.readFileSync(path.join(directory, 'references/api.md'), 'utf8'), old);
  assert.equal(manager.records()[0].journal, null);
  assert.equal(manager.list()[0].mode, 'manual');
  assert.equal(manager.check()[0].status, 'incomplete');
});

test('unchanged periodic checks do not invalidate confirmation and preference conflicts block writes', t => {
  const { manager, install, confirm, preference, service } = setup(t);
  const linked = confirm({ directory: install() }); preference('first');
  const preview = manager.preview({ id: linked.id, action: 'update' }); manager.check();
  manager.confirm({ token: preview.token, confirmed: true });
  const prefs = service.agents.preferences();
  service.agents.savePreferences({ content: 'branch a', parents: prefs.heads });
  service.store.write({ id: prefs.id, type: 'agentPreferences', parents: prefs.heads, allowBranch: true, data: { title: '偏好', domain: '__settings__', content: 'branch b' } });
  manager.configure({ id: linked.id, mode: 'auto', confirmed: true }); manager.check({ automatic: true });
  assert.equal(manager.list()[0].status, 'conflict');
  assert.throws(() => manager.preview({ id: linked.id, action: 'update' }), /偏好存在冲突/);
  assert.equal(sha(fs.readFileSync(path.join(linked.directory, 'references/preferences.md'))), manager.records()[0].hashes['references/preferences.md']);
});
