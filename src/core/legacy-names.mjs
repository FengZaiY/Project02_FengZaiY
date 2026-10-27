import fs from 'node:fs';
import path from 'node:path';

// Compatibility values are not current product names. Never rewrite immutable history or ID seeds.
export const legacyNames = Object.freeze({
  profile: 'studyself', skill: 'studyself-organize', toolPrefix: 'studyself_',
  scheme: 'studyself', mediaScheme: 'studyself-media', header: 'x-studyself-token',
  libraryMarker: '.studyself-library.json', incompleteMarker: '.studyself-incomplete.json',
  workspaceLock: '.studyself-lock.json', skillMarker: '.studyself-install.json', skillLock: '.studyself-update.lock',
  syncRoot: 'StudySelfSync', librarySeed: 'studyself-legacy-library:', treeSeed: 'studyself-note-tree-v1:',
  retiredWorkspaceSeed: 'studyself-retired-ai-workspace:', mindmap: '%% studyself-mindmap:',
  listSummary: 'studyself-list-summary', reading: 'studyself-reading',
  dataEnvironment: 'STUDYSELF_DATA', updateUrlEnvironment: 'STUDYSELF_UPDATE_URL', updateGithubEnvironment: 'STUDYSELF_UPDATE_GITHUB',
  updateSource: 'studyselfUpdateSource'
});

export function compatiblePath(directory, currentName, previousName) {
  const current = path.join(directory, currentName), previous = path.join(directory, previousName);
  if (fs.existsSync(current) && fs.existsSync(previous)) {
    throw Object.assign(new Error('新旧命名位置同时存在，请先核对保留位置，系统不会自动覆盖或合并。'), { code: 'CONFLICT' });
  }
  return fs.existsSync(previous) ? previous : current;
}

export const libraryMarkerPath = directory => compatiblePath(directory, '.fengzaiy-library.json', legacyNames.libraryMarker);
export const incompleteMarkerPath = directory => compatiblePath(directory, '.fengzaiy-incomplete.json', legacyNames.incompleteMarker);
export const desktopProfilePath = appData => compatiblePath(appData, 'FengZaiY', legacyNames.profile);
export const syncRootPath = folder => compatiblePath(folder, 'FengZaiYSync', legacyNames.syncRoot);
