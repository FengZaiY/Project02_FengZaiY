const hints = {
  UPDATE_REDIRECT_FAILED: '下载地址跳转失败，请重新检查更新后重试。',
  UPDATE_REDIRECT_LIMIT: '下载地址跳转次数过多，请检查发布来源。',
  UPDATE_URL_INVALID: '更新地址不符合安全要求，已停止下载，请检查发布来源。',
  UPDATE_TIMEOUT: '下载连接超时，已保留断点，可以继续下载。',
  UPDATE_RANGE_INVALID: '服务器返回的续传位置不正确，请重新下载。',
  UPDATE_SIZE_MISMATCH: '下载文件大小与预期不符，请重新下载。',
  ERR_CHECKSUM_MISMATCH: '安装包完整性校验失败，不能安装，请重新下载。',
  ENOSPC: '更新缓存所在磁盘空间不足，请释放空间后继续下载。',
  EACCES: '无法写入更新缓存，请检查目录权限或文件是否被占用。',
  EPERM: '更新文件被占用或无写入权限，请稍后重试。',
  EBUSY: '更新文件正在被占用，请稍后重试。',
  HTTP_404: '发布的安装包或更新文件不存在，请重新检查更新。',
  HTTP_403: '下载服务器拒绝访问，请重新检查更新或检查网络代理。',
  HTTP_429: '下载服务器请求过于频繁，请稍后重试。'
};

export function updateFailure(error) {
  // Extract only an error identifier, never URLs, paths, headers or remote bodies.
  const message = String(error?.message || '');
  let code = String(error?.code || error?.cause?.code || '').replace(/[^A-Z0-9_]/g, '').slice(0, 80);
  if (!code) code = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1]
    || (/Redirect was cancelled/i.test(message) ? 'UPDATE_REDIRECT_FAILED' : 'NETWORK_OR_FILE_ERROR');
  const hint = hints[code] || (/TIMED?_?OUT|TIMEOUT/.test(code) ? hints.UPDATE_TIMEOUT
    : /CERT|SSL|TLS/.test(code) ? '更新服务器的安全连接验证失败，请检查系统时间、证书或网络代理。'
      : code !== 'NETWORK_OR_FILE_ERROR' && /CONNECTION|NETWORK|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|PROXY|ECONN|ENOTFOUND|EAI_AGAIN/.test(code) ? '无法连接更新下载服务器，请检查网络或代理后重试；已有断点会保留。'
        : '请检查网络、磁盘空间与发布文件后重试。');
  return { code, message: `更新操作未完成（${code}）。${hint}` };
}
