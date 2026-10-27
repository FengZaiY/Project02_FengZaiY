import { randomBytes, randomInt, scrypt as derive } from 'node:crypto';
import { promisify } from 'node:util';
import { canonical, check, encrypt, decrypt, uuid, sha } from './util.mjs';

const scrypt = promisify(derive);
export const VAULT_ID = '7fe9ba92-43ef-4de6-b674-c5bd2034673c';
const kdf = { name: 'scrypt', N: 131072, r: 8, p: 1 };
const aad = (keyId, kind) => `fengzai-vault:1:${keyId}:${kind}`;
const secretId = id => { const hash = sha(`fengzai-vault-secret:${id}`); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`; };
async function passwordKey(password, salt) {
  check(typeof password === 'string' && password.length >= 12 && password.length <= 1000, '主密码请使用 12 至 1000 个字符');
  return scrypt(password, Buffer.from(salt, 'hex'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}
function cleanSecret(value) {
  check(value && Object.keys(value).every(k => ['password', 'recoveryCodes', 'secretNotes'].includes(k)), '秘密字段无效');
  const result = {};
  for (const key of ['password', 'recoveryCodes', 'secretNotes']) {
    check(value[key] === undefined || typeof value[key] === 'string' && value[key].length <= 12000, '秘密内容过长');
    result[key] = value[key] || '';
  }
  return result;
}
export class PasswordVault {
  constructor(store, { clock = Date.now, idleMs = 600000 } = {}) {
    this.store = store; this.clock = clock; this.idleMs = idleMs; this.generation = 0;
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  expire() { if (this.pending && this.pending.expires <= this.clock() || this.key && (this.clock() - this.lastUsed >= this.idleMs || canonical(this.store.headIds(VAULT_ID)) !== this.heads)) this.lock(); }
  status() { this.expire(); const config = this.store.get(VAULT_ID); return { initialized: !!config, unlocked: !!this.key, pendingSetup: !!this.pending, conflict: !!config?.conflict,
    configurations: config?.versions.map(v => ({ id: v.id, keyId: v.data.keyId, createdAt: v.createdAt, deviceId: v.deviceId })) || [], idleMinutes: this.idleMs / 60000 }; }
  lock() { const active = !!(this.key || this.pending); for (const key of this.keys?.values() || []) key.fill(0); this.keys = null; this.key?.fill(0); this.key = null; this.pending?.key.fill(0); this.pending = null; this.generation++; if (active) this.onLock?.(); return { unlocked: false }; }
  close() { clearInterval(this.timer); this.lock(); }
  requireUnlocked() { this.expire(); check(this.key, '请先解锁密码库', 'VAULT_LOCKED'); this.lastUsed = this.clock(); return this.key; }
  keyring(data, key) {
    const keys = new Map([[data.keyId, key]]);
    try { for (const item of data.keyBoxes || []) { const legacy = decrypt(item.box, key, aad(data.keyId, `legacy:${item.keyId}`)); check(legacy.length === 32, '历史密钥无效'); keys.set(item.keyId, legacy); } return keys; }
    catch (error) { for (const value of keys.values()) if (value !== key) value.fill(0); throw error; }
  }
  async setup({ password }) {
    check(!this.store.get(VAULT_ID), '密码库已存在');
    this.lock(); const generation = this.generation, key = randomBytes(32), recovery = randomBytes(32), salt = randomBytes(16).toString('hex'), keyId = uuid();
    let derived;
    try {
      derived = await passwordKey(password, salt);
      check(generation === this.generation && !this.store.get(VAULT_ID), '密码库状态已变化，请重试', 'CONFLICT');
      const data = { title: '密码库', keyId, kdf, salt, passwordBox: encrypt(key, derived, aad(keyId, 'password')), recoveryBox: encrypt(key, recovery, aad(keyId, 'recovery')) };
      this.pending = { key, data, token: uuid(), expires: this.clock() + 600000 };
      return { token: this.pending.token, recoveryKey: recovery.toString('hex'), message: '恢复密钥仅此一次显示，请保存在系统外的安全位置。' };
    } catch (error) { key.fill(0); throw error; }
    finally { derived?.fill(0); recovery.fill(0); }
  }
  confirmSetup({ token, confirmed }) {
    const pending = this.pending;
    check(confirmed === true && pending?.token === token && pending.expires > this.clock() && canonical(this.store.headIds(VAULT_ID)) === canonical(pending.parents || []), '请确认已保存恢复密钥，或重新初始化');
    this.store.write({ id: VAULT_ID, type: 'vaultConfig', data: pending.data, parents: pending.parents || [] });
    this.key = pending.key; this.keyId = pending.data.keyId; this.pending = null;
    this.keys = this.keyring(pending.data, this.key);
    this.heads = canonical(this.store.headIds(VAULT_ID)); this.lastUsed = this.clock();
    return this.status();
  }
  async unlock({ password, recoveryKey, revision }) {
    this.lock(); const generation = this.generation, current = this.store.get(VAULT_ID);
    check(current && !current.deleted && (!current.conflict || revision && current.heads.includes(revision)), '密码库配置有冲突，请选择对应版本解锁或合并配置', 'CONFLICT');
    const config = { ...current, data: revision ? current.versions.find(v => v.id === revision)?.data : current.data }; check(config.data, '配置版本无效');
    const heads = canonical(config.heads); let derived, key;
    try {
      if (recoveryKey !== undefined) { check(/^[a-f0-9]{64}$/i.test(recoveryKey), '恢复密钥格式无效'); derived = Buffer.from(recoveryKey, 'hex'); }
      else derived = await passwordKey(password, config.data.salt);
      try { key = decrypt(recoveryKey !== undefined ? config.data.recoveryBox : config.data.passwordBox, derived, aad(config.data.keyId, recoveryKey !== undefined ? 'recovery' : 'password')); }
      catch { throw Object.assign(new Error('主密码或恢复密钥不正确'), { code: 'VAULT_AUTH' }); }
      check(generation === this.generation && heads === canonical(this.store.headIds(VAULT_ID)), '密码库状态已变化，请重新解锁', 'CONFLICT');
      check(key.length === 32, '密码库密钥无效');
      this.keys = this.keyring(config.data, key); this.key = key; key = null; this.keyId = config.data.keyId; this.heads = heads; this.lastUsed = this.clock();
      return this.status();
    } finally { derived?.fill(0); key?.fill(0); }
  }
  async resetMaster({ password }) {
    const key = Buffer.from(this.requireUnlocked()), heads = this.heads, generation = this.generation;
    const salt = randomBytes(16).toString('hex'); let derived;
    try {
      derived = await passwordKey(password, salt);
      this.requireUnlocked(); check(generation === this.generation && heads === this.heads, '密码库状态已变化', 'CONFLICT');
      const config = this.store.get(VAULT_ID);
      check(!config.conflict, '请先合并密码库配置，再重设主密码', 'CONFLICT');
      this.store.write({ id: VAULT_ID, type: 'vaultConfig', parents: config.heads, data: { ...config.data, salt, passwordBox: encrypt(key, derived, aad(this.keyId, 'password')) } });
      this.heads = canonical(this.store.headIds(VAULT_ID)); return this.status();
    } finally { key.fill(0); derived?.fill(0); }
  }
  read({ accountId, revision }) {
    this.requireUnlocked(); const record = this.store.get(secretId(accountId));
    if (!record) return { id: secretId(accountId), parents: [], value: cleanSecret({}), conflict: false };
    if (!revision && record.deleted && !record.conflict) return { id: record.id, parents: record.heads, value: cleanSecret({}), conflict: false };
    const event = revision ? this.store.event(revision) : record.versions[0];
    check(event?.entityId === record.id && this.keys.has(event.data.keyId) && !event.deleted, '密码版本不可用；其他密码库分支须先解锁或合并配置');
    check(revision || !record.conflict, '密码存在并发修改，请逐个查看版本再选择保存', 'CONFLICT');
    return { id: record.id, parents: record.heads, value: JSON.parse(decrypt(event.data.box, this.keys.get(event.data.keyId), aad(event.data.keyId, `secret:${accountId}`)).toString()), conflict: record.conflict };
  }
  history({ accountId }) {
    this.requireUnlocked(); return this.store.history(secretId(accountId)).map(event => ({ id: event.id, createdAt: event.createdAt, deviceId: event.deviceId, deleted: event.deleted }));
  }
  save({ accountId, parents = [], value }) {
    const key = this.requireUnlocked(), account = this.store.get(accountId);
    check(account?.type === 'loginAccount' && !account.deleted && !account.conflict, '账号不可用');
    const data = { title: '加密密码', accountId, keyId: this.keyId, box: encrypt(Buffer.from(canonical(cleanSecret(value))), key, aad(this.keyId, `secret:${accountId}`)) };
    const record = this.store.change('保存密码', '用户', () => this.store.write({ id: secretId(accountId), type: 'vaultSecret', parents, data }));
    this.store.local(`vaultDraft:${accountId}`, null);
    return { id: record.id, parents: record.heads };
  }
  draft({ accountId, value, parents = [], clear = false }) {
    const key = this.requireUnlocked();
    check(this.store.get(accountId)?.type === 'loginAccount', '账号不存在');
    if (clear) this.store.local(`vaultDraft:${accountId}`, null);
    else if (value !== undefined) this.store.local(`vaultDraft:${accountId}`, { keyId: this.keyId, box: encrypt(Buffer.from(canonical({ value: cleanSecret(value), parents })), key, aad(this.keyId, `draft:${accountId}`)) });
    const draft = this.store.local(`vaultDraft:${accountId}`);
    return draft && this.keys.has(draft.keyId) ? JSON.parse(decrypt(draft.box, this.keys.get(draft.keyId), aad(draft.keyId, `draft:${accountId}`)).toString()) : null;
  }
  async resolveSetup({ credentials, password }) {
    this.lock(); const generation = this.generation, config = this.store.get(VAULT_ID);
    check(config?.conflict && Array.isArray(credentials) && credentials.length === config.heads.length && new Set(credentials.map(c => c.revision)).size === config.heads.length, '请为每个并发密码库配置提供解锁信息');
    const heads = canonical(config.heads), collected = new Map(), key = randomBytes(32), recovery = randomBytes(32), keyId = uuid(), salt = randomBytes(16).toString('hex');
    let derived;
    try {
      for (const credential of credentials) {
        const event = config.versions.find(v => v.id === credential.revision); check(event, '配置已变化');
        const data = event.data; let wrapping, branchKey;
        try {
          if (credential.recoveryKey !== undefined) { check(/^[a-f0-9]{64}$/i.test(credential.recoveryKey), '恢复密钥格式无效'); wrapping = Buffer.from(credential.recoveryKey, 'hex'); }
          else wrapping = await passwordKey(credential.password, data.salt);
          try { branchKey = decrypt(credential.recoveryKey !== undefined ? data.recoveryBox : data.passwordBox, wrapping, aad(data.keyId, credential.recoveryKey !== undefined ? 'recovery' : 'password')); }
          catch { throw Object.assign(new Error('某个配置的主密码或恢复密钥不正确'), { code: 'VAULT_AUTH' }); }
          for (const [id, value] of this.keyring(data, branchKey)) {
            if (collected.has(id)) { check(collected.get(id).equals(value), '相同密钥身份出现不同内容，不能自动合并'); value.fill(0); }
            else collected.set(id, value);
          }
          branchKey = null;
        } finally { wrapping?.fill(0); branchKey?.fill(0); }
      }
      check(collected.size <= 100, '历史密钥过多，暂不能合并');
      derived = await passwordKey(password, salt);
      check(generation === this.generation && heads === canonical(this.store.headIds(VAULT_ID)), '配置已变化，请重新核对', 'CONFLICT');
      const data = { title: '密码库', keyId, kdf, salt, passwordBox: encrypt(key, derived, aad(keyId, 'password')), recoveryBox: encrypt(key, recovery, aad(keyId, 'recovery')),
        keyBoxes: [...collected].map(([id, value]) => ({ keyId: id, box: encrypt(value, key, aad(keyId, `legacy:${id}`)) })) };
      this.pending = { key, data, parents: config.heads, token: uuid(), expires: this.clock() + 600000 };
      return { token: this.pending.token, recoveryKey: recovery.toString('hex') };
    } catch (error) { key.fill(0); throw error; }
    finally { for (const value of collected.values()) value.fill(0); derived?.fill(0); recovery.fill(0); }
  }
  generate({ length = 24 } = {}) {
    this.requireUnlocked(); check(Number.isInteger(length) && length >= 16 && length <= 128, '密码长度应为 16 至 128');
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?';
    return Array.from({ length }, () => chars[randomInt(chars.length)]).join('');
  }
}
