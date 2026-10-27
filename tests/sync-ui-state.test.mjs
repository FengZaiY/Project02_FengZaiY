import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncSendState, syncReceiveState } from '../web/sync-model.js';

const status = overrides => ({ config: { configured: true }, busy: false, pendingChanges: 0, pendingControl: false,
  latest: { id: 'latest', userConfirmedAt: null }, job: null, ...overrides });

test('sync actions distinguish setup, frozen publication, confirmation and local changes', () => {
  assert.equal(syncSendState(status({ config: { configured: false } })).canPublish, false);
  assert.equal(syncSendState(status({ pendingChanges: 2 })).title, '有本机更新待发送');
  assert.equal(syncSendState(status()).title, '等待确认百度上传');
  assert.equal(syncSendState(status()).canConfirmUpload, true);
  assert.equal(syncSendState(status({ latest: { userConfirmedAt: 'now' } })).title, '本次上传已确认');
  assert.equal(syncSendState(status({ latest: { userConfirmedAt: 'now' } })).canPublish, true, 'allow checking for missing unconfirmed transport files');
  const active = status({ job: { state: 'paused', completedObjects: 4, confirmedThrough: 2 } });
  assert.equal(syncSendState(active).canConfirmBatch, true);
  assert.equal(syncSendState(status({ job: { ...active.job, confirmedThrough: 4 } })).canConfirmBatch, false);
  assert.equal(syncSendState(active).label, '继续发送');
  assert.equal(syncSendState(status({ job: { state: 'ready' } })).label, '开始生成');
});

test('sync busy and device policy constrain actions without blocking management recovery', () => {
  const running = status({ busy: true, job: { state: 'running', phase: 'manifest' } });
  assert.equal(syncSendState(running).title, '正在更新最新清单');
  assert.equal(syncSendState(running).canPublish, false);
  assert.equal(syncSendState(running).canPause, true);
  assert.equal(syncSendState(status(), {}, 'sync-scan').canPublish, false);
  assert.equal(syncSendState(running, {}, 'sync-scan').canPause, false);
  for (const flag of ['suspended', 'statusConflict']) {
    const state = syncSendState(status(), { devices: [{ local: true, [flag]: true }] });
    assert.equal(state.canPublish, false);
    assert.equal(state.canIndex, false);
  }
  assert.equal(syncSendState(status(), { devices: [{ local: true, primary: true }] }).canIndex, false);
  assert.equal(syncSendState(status(), { conflict: true }).canIndex, false);
  assert.equal(syncSendState(status(), {}).canIndex, true, 'new machine can discover the primary role during server-side import validation');
});

test('receive summary separates own publication, merged records and missing transport objects', () => {
  const own = { own: true, imported: false, missing: [], invalid: [] };
  const remote = { own: false, imported: false, missing: [], invalid: [] };
  const scan = entries => ({ entries, errors: [] });
  assert.equal(syncReceiveState(null).title, '尚未检查其他电脑的更新');
  assert.equal(syncReceiveState(scan([own])).pending, 0);
  assert.equal(syncReceiveState(scan([own, remote])).pending, 1);
  const merged = syncReceiveState(scan([{ ...remote, imported: true }]));
  assert.equal(merged.title, '已发现的修改记录已合并');
  assert.doesNotMatch(merged.title, /原件|上传/);
  assert.equal(syncReceiveState(scan([{ ...remote, imported: true, missing: ['file'] }])).title, '下载文件需要检查');
  assert.equal(syncReceiveState({ entries: [], errors: [{ message: 'invalid' }] }).issues, 1);
});
