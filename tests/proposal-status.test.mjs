import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { proposalProgress, matchesProposalStatus } from '../src/core/proposal-status.mjs';
import { Service } from '../src/core/service.mjs';

test('confirmation includes material items and keeps empty/partial/conflicted proposals actionable', () => {
  const record = { data: { items: [{ status: 'accepted' }], materialItems: [{ status: 'pending' }] } };
  assert.deepEqual(proposalProgress(record), { status: 'partial', total: 2, accepted: 1, pending: 1, label: '部分确认' });
  assert.equal(matchesProposalStatus(record, 'active'), true);
  assert.equal(matchesProposalStatus(record, 'accepted'), false);
  record.data.materialItems[0].status = 'accepted';
  assert.equal(proposalProgress(record).status, 'accepted');
  assert.equal(matchesProposalStatus(record, 'active'), false);
  record.conflict = true;
  assert.equal(proposalProgress(record).status, 'conflict');
  assert.equal(matchesProposalStatus(record, 'active'), true);
  assert.equal(proposalProgress({ data: { items: [], materialItems: [{ status: 'accepted' }] } }).status, 'accepted');
  assert.equal(proposalProgress({ data: { items: [] } }).status, 'pending');
});

test('service filters confirmation before limits, preserves search/scope and never writes during listing', async t => {
  const root = path.resolve('artifacts/proposal-status-tests'); fs.mkdirSync(root, { recursive: true });
  const service = new Service(fs.mkdtempSync(path.join(root, 'case-')));
  await service.ready; t.after(() => service.close());
  const domain = service.store.saveLibrary({ title: '方案隔离验证' }).id;
  const make = title => service.call('propose', { title, domain, items: [{ title: `${title}笔记`, content: 'isolated' }] });
  const pending = await make('待办');
  for (let i = 0; i < 4; i++) {
    const record = await make(`已办${i}`);
    await service.call('approve', { id: record.id, parents: record.heads, itemIds: record.data.items.map(item => item.id) });
  }
  const events = service.store.allEvents();
  const all = await service.call('records', { type: 'proposal', proposalStatus: 'all' });
  assert.notEqual(all[0].id, pending.id);
  const active = await service.call('records', { type: 'proposal', proposalStatus: 'active', limit: 1, preview: true });
  assert.deepEqual(active.map(row => row.id), [pending.id]);
  assert.equal((await service.call('records', { type: 'proposal', proposalStatus: 'accepted' })).length, 4);
  assert.equal((await service.call('records', { type: 'proposal', proposalStatus: 'active', query: '已办' })).length, 0);
  assert.equal((await service.call('records', { type: 'proposal', proposalStatus: 'accepted', query: '已办1', domain })).length, 1);
  await assert.rejects(service.call('records', { type: 'proposal', proposalStatus: 'invalid' }), /确认状态/);
  assert.deepEqual(service.store.allEvents(), events);
});
