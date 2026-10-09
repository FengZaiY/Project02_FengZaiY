import { createHash, randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export const sha = data => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function check(condition, message, code = 'INVALID') {
  if (!condition) throw Object.assign(new Error(message), { code });
}
export const isId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function inside(root, relative) {
  check(typeof relative === 'string' && !path.isAbsolute(relative), 'Invalid relative path');
  const result = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), result);
  check(rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'Path outside allowed directory');
  return result;
}
export function noSymlink(file) {
  let current = path.resolve(file);
  while (true) {
    if (fs.existsSync(current)) check(!fs.lstatSync(current).isSymbolicLink(), 'Symbolic links are not accepted');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${uuid()}.partial`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function encrypt(data, key, aad = '') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
export function decrypt(box, key, aad = '') {
  check(box && typeof box.iv === 'string' && typeof box.tag === 'string' && typeof box.data === 'string', 'Invalid encrypted record');
  const iv = Buffer.from(box.iv, 'base64');
  const tag = Buffer.from(box.tag, 'base64');
  check(iv.length === 12 && tag.length === 16, 'Invalid encryption parameters');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()]);
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function prettyError(error) {
  return { message: error.message || String(error), code: error.code || 'ERROR' };
}
export function outside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
