import { Store } from '../src/core/store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('artifacts/performance');
fs.mkdirSync(root, { recursive: true });
const store = new Store(fs.mkdtempSync(path.join(root, 'profile-')));
try {
  const start = performance.now();
  store.transaction(() => {
    for (let i = 0; i < 10000; i++) store.writeRaw({ type: 'note', data: {
      title: `知识条目 ${i}`, domain: i % 2 ? 'AI' : '英语', tags: ['性能验证'],
      content: `唯一检索标记 BENCHMARK-${i}。${'知识整理与版本同步测试。'.repeat(60)}`
    } });
  });
  const creationMs = performance.now() - start;
  const summaryStart = performance.now(), summary = store.summary(), summaryMs = performance.now() - summaryStart;
  const listStart = performance.now(), list = store.list({ type: 'note', limit: 150 }), listMs = performance.now() - listStart;
  const searchStart = performance.now(), result = store.list({ type: 'note', query: 'BENCHMARK-9999' }), searchMs = performance.now() - searchStart;
  assert.equal(summary.counts.note, 10000); assert.equal(list.length, 150); assert.equal(result.length, 1);
  const report = { notes: 10000, creationMs, summaryMs, listMs, searchMs, environment: process.version };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }
