import { legacyNames } from '../src/core/legacy-names.mjs';
import fs from 'node:fs';
import { updateSource } from '../src/desktop/update-source.mjs';

export function releaseConfig(environment = process.env) {
  const url = environment.FENGZAIY_UPDATE_URL ?? environment[legacyNames.updateUrlEnvironment];
  const github = environment.FENGZAIY_UPDATE_GITHUB ?? environment[legacyNames.updateGithubEnvironment];
  if (url && github) throw new Error('发布只能指定 FENGZAIY_UPDATE_URL 或 FENGZAIY_UPDATE_GITHUB 中的一个');
  if (github && github.split('/').length !== 2) throw new Error('FENGZAIY_UPDATE_GITHUB 格式为 owner/repo');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = updateSource(url ? { provider: 'generic', url } : github ? { provider: 'github', owner: github.split('/')[0], repo: github.split('/')[1] } : pkg.fengzaiyUpdateSource ?? pkg[legacyNames.updateSource]);
  if (!source) throw new Error('尚未配置发布来源');
  return { ...pkg.build, publish: [source], extraMetadata: { fengzaiyUpdateSource: source } };
}

export default () => releaseConfig();
