import fs from 'node:fs';
import { updateSource } from '../src/desktop/update-source.mjs';

export function releaseConfig(environment = process.env) {
  const { STUDYSELF_UPDATE_URL: url, STUDYSELF_UPDATE_GITHUB: github } = environment;
  if (url && github) throw new Error('发布只能指定 STUDYSELF_UPDATE_URL 或 STUDYSELF_UPDATE_GITHUB 中的一个');
  if (github && github.split('/').length !== 2) throw new Error('STUDYSELF_UPDATE_GITHUB 格式为 owner/repo');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = updateSource(url ? { provider: 'generic', url } : github ? { provider: 'github', owner: github.split('/')[0], repo: github.split('/')[1] } : pkg.studyselfUpdateSource);
  if (!source) throw new Error('尚未配置发布来源');
  return { ...pkg.build, publish: [source], extraMetadata: { studyselfUpdateSource: source } };
}

export default () => releaseConfig();
