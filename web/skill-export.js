// Store-only ZIP keeps the portable skill export independent of server-side paths.
export function skillZip(files) {
  const encoder = new TextEncoder(), chunks = [], directory = [];
  let offset = 0;
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const value of data) {
      crc ^= value;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const [filename, text] of Object.entries(files)) {
    const name = encoder.encode(`studyself-organize/${filename}`), data = encoder.encode(text), crc = crc32(data);
    const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), dir = new DataView(central.buffer);
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, directory.length, true); view.setUint16(10, directory.length, true);
  view.setUint32(12, directory.reduce((sum, item) => sum + item.length, 0), true); view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}

export function skillExportFiles({ files, preferences, skillVersion, exportVersion }) {
  if (preferences.conflict) throw new Error('请先合并整理偏好冲突，再导出 Skill');
  return { ...files, 'references/preferences.md': `${preferences.baseline}\n\n## 用户补充（导出快照）\n\n${preferences.content || '暂无补充'}\n\n偏好版本：${preferences.version}\n`,
    ...(skillVersion && exportVersion ? { 'manifest.json': JSON.stringify({ name: 'studyself-organize', protocolVersion: 1, skillVersion, preferencesVersion: preferences.version, exportVersion }, null, 2) } : {}) };
}
export function downloadSkill(bundle) {
  const url = URL.createObjectURL(skillZip(skillExportFiles(bundle))), link = document.createElement('a');
  link.href = url; link.download = 'studyself-organize.zip'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
