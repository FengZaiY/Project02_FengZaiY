import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { lexer, walkTokens } from 'marked';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = [
  'AGENTS.md', 'README.md', 'CONTRIBUTING.md',
  '.editorconfig', '.gitattributes', '.gitignore', 'package.json', 'package-lock.json',
  'docs/README.md', 'docs/project-status.md', 'docs/architecture.md',
  'docs/verification.md', 'docs/baidu-acceptance.md',
  'docs/plans/README.md', 'docs/decisions/README.md',
  'docs/decisions/0001-local-first-folder-sync.md',
  'src/core/store.mjs', 'src/core/service.mjs', 'src/core/transport.mjs',
  'src/core/current-sync.mjs', 'src/core/sync-state.mjs', 'src/core/resumable-files.mjs',
  'src/core/device-management.mjs', 'tests/device-management.test.mjs', 'scripts/test-devices-ui.mjs', 'web/device-manager.css',
  'src/core/hierarchy.mjs', 'src/core/local-hierarchy.mjs', 'web/hierarchy-ui.js', 'tests/hierarchy.test.mjs',
  'src/core/note-hierarchy.mjs', 'tests/note-hierarchy.test.mjs',
  'src/core/note-order.mjs', 'tests/note-order.test.mjs',
  'src/core/draft-workflow.mjs', 'web/draft-workflow.js', 'web/draft-workflow.css', 'tests/draft-workflow.test.mjs', 'scripts/test-draft-workflow.mjs',
  'web/record-navigation.js', 'web/record-navigation.css',
  'web/skill-manager.js', 'web/skill-manager.css', 'scripts/test-skill-manager.mjs',
  'src/core/skill-installations.mjs', 'web/skill-installations.js', 'tests/skill-installations.test.mjs',
  'src/desktop/updates.mjs', 'src/desktop/update-source.mjs', 'web/update-manager.js', 'web/update-manager.css',
  'tests/updates.test.mjs', 'scripts/test-updates-ui.mjs', 'scripts/release-config.mjs', 'docs/online-updates.md',
  'web/note-tree-drag.js', 'scripts/test-note-tree-drag.mjs',
  'src/core/asset-management.mjs', 'web/asset-manager.js', 'web/assets.css', 'tests/asset-management.test.mjs', 'scripts/test-assets-ui.mjs',
  'src/core/asset-merge.mjs', 'tests/asset-merge.test.mjs', 'scripts/test-asset-dedup.mjs',
  'web/asset-storage.js', 'scripts/test-asset-storage.mjs',
  'src/core/agent-access.mjs', 'src/core/agent-mcp.mjs', 'web/agent-mcp.js', 'web/agent-mcp.css', 'tests/agent-mcp.test.mjs', 'docs/agent-mcp.md', 'skills/studyself-organize/SKILL.md', 'src/desktop/main.mjs',
  'src/desktop/preload.cjs', 'src/server.mjs', 'web/app.js', 'tests/core.test.mjs',
  'src/core/rich-schema.mjs', 'src/core/rich-content.mjs', 'src/core/media.mjs',
  'src/core/presentation-schema.mjs', 'src/core/presentation.mjs', 'web/presentation-view.js', 'web/presentation-worker.js', 'web/presentation-mode.js', 'tests/presentation.test.mjs', 'scripts/test-presentation.mjs',
  'web/rich-editor.js', 'web/rich-canvas.js', 'web/rich.css', 'tests/rich.test.mjs', 'scripts/test-rich-ui.mjs',
  'web/mindmap-editor.js', 'web/mindmap-model.js', 'web/mindmap.css', 'tests/mindmap.test.mjs', 'scripts/test-mindmap-ui.mjs'
];
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
for (const name of required) {
  assert.ok(fs.statSync(path.join(root, name)).isFile(), `Missing project file: ${name}`);
}

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
assert.equal(lock.name, pkg.name, 'Lockfile project name mismatch');
assert.equal(lock.version, pkg.version, 'Lockfile project version mismatch');
for (const field of ['dependencies', 'devDependencies']) {
  assert.deepEqual(lock.packages[''][field] || {}, pkg[field] || {}, `Lockfile ${field} mismatch`);
}
const scripts = {
  'check:project': 'node scripts/check-project.mjs',
  test: 'node --test tests/*.test.mjs',
  'test:ui': 'node scripts/test-ui.mjs',
  'test:libraries': 'node scripts/test-libraries-ui.mjs',
  'test:note-drag': 'node scripts/test-note-tree-drag.mjs',
  'test:drafts': 'node scripts/test-draft-workflow.mjs',
    'test:skills': 'node scripts/test-skill-manager.mjs',
  'test:updates': 'node scripts/test-updates-ui.mjs',
  'test:assets': 'node scripts/test-assets-ui.mjs',
  'test:dedup': 'node scripts/test-asset-dedup.mjs',
  'test:asset-storage': 'node scripts/test-asset-storage.mjs',
  'test:attachment-drag': 'node scripts/test-attachment-drag.mjs',
  'test:asset-previews': 'node scripts/test-asset-previews.mjs',
  'test:agents': 'node scripts/test-agents-ui.mjs',
  'test:rich': 'node scripts/test-rich-ui.mjs',
  'test:presentation': 'node scripts/test-presentation.mjs',
  'test:mindmap': 'node scripts/test-mindmap-ui.mjs',
  'test:document': 'node scripts/test-document-flow.mjs',
  'test:experience': 'node scripts/test-editor-experience.mjs',
  'test:trash': 'node scripts/test-trash-ui.mjs',
  'test:desktop': 'node scripts/test-desktop.mjs',
  'test:devices': 'node scripts/test-devices-ui.mjs',
  'test:packaged': 'node scripts/test-desktop.mjs --packaged',
  benchmark: 'node scripts/benchmark.mjs'
};
for (const [name, command] of Object.entries(scripts)) {
  assert.equal(pkg.scripts[name], command, `Update the documented script contract: ${name}`);
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.isFile() && file.endsWith('.md') ? [file] : [];
  });
}
const docs = [
  ...['AGENTS.md', 'README.md', 'CONTRIBUTING.md'].map(name => path.join(root, name)),
  ...markdownFiles(path.join(root, 'docs'))
];
let links = 0;
for (const file of docs) {
  walkTokens(lexer(fs.readFileSync(file, 'utf8')), token => {
    if (!['link', 'image'].includes(token.type)) return;
    if (!token.href || /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(token.href)) return;
    const target = decodeURIComponent(token.href.split(/[?#]/)[0]);
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)),
      `Broken local link in ${path.relative(root, file)}: ${token.href}`);
    links++;
  });
}
console.log(`PASS: ${required.length} required files, ${docs.length} documents, ${links} local links, script contracts and lockfile consistency.`);
