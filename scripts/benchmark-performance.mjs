import fs from 'node:fs';
import path from 'node:path';
import { Service } from '../src/core/service.mjs';

const root = path.resolve('artifacts/performance'); fs.mkdirSync(root, { recursive: true });
const service = new Service(fs.mkdtempSync(path.join(root, 'service-')));
try {
  await service.ready;
  const domain = service.store.saveLibrary({ title: '隔离性能基准' }).id;
  service.store.transaction(() => {
    for (let i = 0; i < 1000; i++) service.store.writeRaw({ type: 'note', data: { title: `检查 ${i}`, domain, content: '性能检查内容。'.repeat(200) } });
  });
  const milliseconds = {};
  for (const [method, input] of [['state', {}], ['noteTree', {}], ['records', { type: 'note', limit: 150, preview: true }], ['state', { light: true }]]) {
    const samples = [];
    for (let i = 0; i < 3; i++) { const start = performance.now(); await service.call(method, input); samples.push(Math.round(performance.now() - start)); }
    milliseconds[input.light ? 'lightState' : method] = samples;
  }
  const report = { notes: 1000, milliseconds, environment: process.version };
  fs.writeFileSync(path.join(root, 'service-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await service.close(); }
