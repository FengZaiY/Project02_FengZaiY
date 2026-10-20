export function updateSource(value) {
  if (!value) return null;
  if (value.provider === 'github') {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.owner || '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.repo || '') || ['.', '..'].includes(value.repo)) {
      throw new Error('更新仓库须为公开 GitHub 仓库的 owner/repo');
    }
    return { provider: 'github', owner: value.owner, repo: value.repo, private: false, releaseType: 'release' };
  }
  if (value.provider === 'generic') {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /\.(?:yml|exe)$/i.test(url.pathname)) {
      throw new Error('更新来源须为无凭证、无查询参数的 HTTPS 文件目录');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return { provider: 'generic', url: url.href, useMultipleRangeRequest: false };
  }
  throw new Error('仅支持公开 GitHub Releases 或 HTTPS 更新目录');
}

export function sourceLabel(source) {
  return !source ? '' : source.provider === 'github' ? `https://github.com/${source.owner}/${source.repo}/releases` : source.url;
}
