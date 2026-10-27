import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Service } from '../src/core/service.mjs';
import { requiresNamingFormat, assertNamingFormat } from '../src/core/naming-format.mjs';
import { check, isId, uuid } from '../src/core/util.mjs';

test('new naming references require an explicit reader capability while original event bytes stay untouched', () => {
  const old = { data: { content: '[引用](studyself://asset/11111111-1111-1111-1111-111111111111)' } };
  assert.equal(requiresNamingFormat(old), false);
  assertNamingFormat(7, [old]);
  for (const data of [{ content: '[引用](fengzaiy://asset/11111111-1111-1111-1111-111111111111)' },
    { url: 'FengZaiY://note/11111111-1111-1111-1111-111111111111' },
    { items: [{ data: { content: '%% fengzaiy-mindmap:{}' } }] }]) {
    const event = { data }, before = JSON.stringify(event);
    assert.throws(() => assertNamingFormat(7, [event]), /format 8/);
    assertNamingFormat(8, [event]); assert.equal(JSON.stringify(event), before);
  }
});

test('local manifest preparation gates new links before the previous reader can accept a record', async t => {
  const root = path.resolve('artifacts/naming-format-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-')), service = new Service(path.join(dir, 'workspace'));
  t.after(() => service.close());
  const library = service.store.saveLibrary({ title: '格式检查' });
  const target = service.store.write({ type: 'note', data: { title: '目标', domain: library.id, content: '' } });
  service.store.write({ type: 'note', data: { title: '新引用', domain: library.id, content: `[目标](fengzaiy://note/${target.id})` } });
  const original = service.store.allEvents(), folder = path.join(dir, 'delivery');
  service.transport.configure(folder, 'a'.repeat(64));
  await service.transport.plan();
  const plan = service.transport.value('plan');
  assert.equal(plan.manifest.format, 8);
  service.transport.validateManifest(plan.manifest, service.store.deviceId);
  assert.deepEqual(service.store.allEvents(), original);
  const channelRoot = service.transport.channel().root;
  assert.ok(!fs.existsSync(channelRoot) || !fs.readdirSync(channelRoot).some(name => name.endsWith('.sscurrent')));
  // Execute the committed pre-rename validation method, rather than simulating an older reader.
  const previous = execFileSync('git', ['show', '001d6ce152bcf38b296ae077d0a2b7c1818c50e6:src/core/current-sync.mjs'], { encoding: 'utf8' });
  const body = previous.match(/  validateManifest\(manifest, deviceId\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(body);
  const legacyValidate = new Function('check', 'isId', 'manifest', 'deviceId', body);
  assert.throws(() => legacyValidate(check, isId, plan.manifest, service.store.deviceId), /无效的最新内容清单/);
  assert.throws(() => service.transport.validateManifest({ ...plan.manifest, format: 99, id: uuid() }, service.store.deviceId));
});
