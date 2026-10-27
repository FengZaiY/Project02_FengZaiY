// Local-only regression selection. Keep transport/device/retired backup suites out.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const output = path.resolve('artifacts/local-audit');
fs.mkdirSync(output, { recursive: true });
const excludedFiles = /^(?:asset-transfer|current-sync|device-management|git-sync|received-objects|sync-disconnect|sync-publication|sync-ui-state)\.test\.mjs$/;
const excludedNames = /two-folder|synchroniz|\bsync\b|\bv3\b|format 7|packet|backup|publish|publication|pending children|child arriving|arrivals|arriving|across devices|remote|propagates|preference conflicts|independently initialized vaults|concurrent vault secrets|encrypted old history objects|replacement publication|transport replacement|pending and rejected histories|erasure receipts|repeated import|importing tasks|another workspace|a formerly pending|unknown concurrent edit|legacy import path/i;
const coreOnly = new Set(['revision ID collision and bad checksum do not modify history', 'partial proposal approval retains pending items and supports later acceptance', 'approval against a stale target rolls back the entire selected operation', 'explicit stale branch save retains the newer edit instead of overwriting it', 'restart deletes retired tasks from every device without executing them', 'fresh workspaces have no preset libraries and model metadata does not create one', 'library rename keeps note and conversation scopes stable and rejects stale edits']);
const mode = process.argv[2] || 'core';
const inventory = [], results = [];
function run(name, args) {
  return new Promise(resolve => {
    const logfile = path.join(output, `${name}.log`), fd = fs.openSync(logfile, 'w'), start = Date.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], env: process.env });
    child.on('error', error => { fs.writeSync(fd, String(error)); });
    child.on('close', code => { fs.closeSync(fd); const result = { name, code, seconds: Math.round((Date.now() - start) / 1000), logfile }; results.push(result); console.log(JSON.stringify(result)); resolve(); });
  });
}
if (mode === 'core') {
  const files = fs.readdirSync('tests').filter(name => name.endsWith('.test.mjs'));
  const names = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join('tests', file), 'utf8');
    for (const match of source.matchAll(/^test\('([^']+)'/gm)) {
      const next = source.indexOf('\ntest(', match.index + match[0].length);
      const body = source.slice(match.index, next < 0 ? undefined : next);
      const delivery = /importEvents\(|importLatest\(|publish\(|\.configure\(folder|new CurrentSync\(|exportBackup\(|importBackup\(/.test(body);
      const selected = !excludedFiles.test(file) && !delivery && (file === 'core.test.mjs' ? coreOnly.has(match[1]) : !excludedNames.test(match[1]));
      inventory.push({ file, name: match[1], selected });
      if (selected) names.push(match[1]);
    }
  }
  // These local editor cases use one parameterized test declaration.
  for (const wrapper of ['blockquote', 'listItem', 'tableCell']) {
    const name = `nested ${wrapper} accepts media between lines and can move it out again`;
    inventory.push({ file: 'block-layout.test.mjs', name, selected: true }); names.push(name);
  }
  fs.writeFileSync(path.join(output, 'core-selection.json'), JSON.stringify(inventory, null, 2));
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await run('core', ['--test', '--test-concurrency=2', `--test-name-pattern=^(?:${names.map(escape).join('|')})$`, ...files.filter(name => !excludedFiles.test(name)).map(name => `tests/${name}`)]);
} else {
  for (const script of process.argv.slice(3)) await run(script, [`scripts/${script}.mjs`]);
}
fs.writeFileSync(path.join(output, `${mode}-results.json`), JSON.stringify(results, null, 2));
if (results.some(r => r.code !== 0)) process.exitCode = 1;
