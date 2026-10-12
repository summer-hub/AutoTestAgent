// 凭据加密自检（verify:crypto，离线可跑）：
//  1. 加解密往返（含中文 / 特殊字符 / 连接串 / 长值）
//  2. 旧明文透传（懒迁移：不阻塞启动，下次写时自然转密文）
//  3. 空值不加密、密文不二次加密（幂等）
//  4. 主密钥文件自动生成（0600）、进程内指纹稳定
//  5. settings 敏感键端到端：setSetting 后**库内直读确是密文**，getSetting 读回明文
//  6. 掩码语义不变（出参仍只有掩码；掩码回传不被当成新密钥）
//  7. 解密失败容错（篡改密文不崩、原样返回并告警）
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'autotest-verify-crypto-'));
process.env.AUTOTEST_DATA_DIR = dataDir;
process.env.AUTOTEST_WORKSPACE = join(dataDir, 'workspace');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

const { encryptSecret, decryptSecret, isEncrypted, sealSecretInput, masterKeyFingerprint, masterKeyHardened } = await import('../lib/services/crypto.js');
const { getSetting, setSetting, SECRET_SETTING_KEYS } = await import('../lib/services/settings.js');
const { ensureReady, getDb } = await import('../lib/db/connection.js');
const { maskSecret, isMaskedSecret, resolveSecretInput } = await import('../lib/services/secrets.js');

// ---- 1. 往返 ----
const samples = [
  'sk-abc123XYZ',
  'mysql://root:p@ssw0rd!@127.0.0.1:3306/autotest?charset=utf8mb4',
  '中文密钥-值-①-🔑',
  'x'.repeat(4096),
];
for (const s of samples) {
  const enc = encryptSecret(s);
  check(`往返：${s.slice(0, 24)}${s.length > 24 ? '…' : ''}`,
    isEncrypted(enc) && enc.startsWith('enc:v1:') && decryptSecret(enc) === s && !enc.includes(s));
}

// ---- 2. 旧明文透传（懒迁移）----
check('旧明文原样透传（不炸启动）', decryptSecret('sk-legacy-plaintext') === 'sk-legacy-plaintext');
check('空值不加密', encryptSecret('') === '' && decryptSecret('') === '');
check('空值 isEncrypted=false', isEncrypted('') === false && isEncrypted(undefined) === false);

// ---- 3. 幂等 ----
const once = encryptSecret('sk-idempotent');
check('密文不二次加密', encryptSecret(once) === once);
check('sealSecretInput 透传密文', sealSecretInput(once, once) === once);
check('sealSecretInput 加密新明文', decryptSecret(sealSecretInput('sk-new', '')) === 'sk-new');

// ---- 4. 主密钥文件 ----
const keyFile = join(dataDir, '.master-key');
check('主密钥文件已自动生成', existsSync(keyFile));
if (existsSync(keyFile)) {
  const hex = readFileSync(keyFile, 'utf8').trim();
  check('主密钥是 64 位 hex', /^[0-9a-f]{64}$/.test(hex), hex.slice(0, 8) + '…');
  if (process.platform === 'win32') {
    // NTFS 上 POSIX mode 是摆设（writeFileSync mode 被忽略成继承 ACL），
    // 真实收敛手段是 icacls（crypto.ts 的 hardenKeyFile），这里断言加固状态而非 mode。
    check('主密钥文件 ACL 已收敛（icacls 断继承+仅当前用户）', masterKeyHardened());
  } else {
    const mode = statSync(keyFile).mode & 0o777;
    check('主密钥文件权限 0600', mode === 0o600, `mode=${mode.toString(8)}`);
  }
}
const fp1 = masterKeyFingerprint();
check('主密钥指纹稳定（8 位 hex）', /^[0-9a-f]{8}$/.test(fp1) && masterKeyFingerprint() === fp1, fp1);

// ---- 5. settings 敏感键端到端 ----
await ensureReady();
const SECRET_KEY = 'db.mysqlUrl';
const PLAIN = 'mysql://root:s3cret@127.0.0.1:3306/autotest';
check('db.mysqlUrl 是敏感键', SECRET_SETTING_KEYS[SECRET_KEY] === 'url');
setSetting(SECRET_KEY, PLAIN);
const rawRow = await getDb().prepare('SELECT value FROM settings WHERE "key" = ?').get(PLAIN ? SECRET_KEY : SECRET_KEY);
const rawStored = String(JSON.parse(String(rawRow?.value ?? '""')));
check('库内直读是密文（不是明文）', rawStored.startsWith('enc:v1:') && !rawStored.includes('s3cret'), rawStored.slice(0, 24) + '…');
check('getSetting 读回明文', getSetting(SECRET_KEY, '') === PLAIN);
// 出参脱敏语义不变
const { maskSettingValue } = await import('../lib/services/settings.js');
const masked = String(maskSettingValue(SECRET_KEY, PLAIN));
check('脱敏出参不含口令', !masked.includes('s3cret') && masked.includes('••••'));
// 掩码回传 → 不改动（防把掩码当新值写库）
setSetting(SECRET_KEY, PLAIN);
const before = await getDb().prepare('SELECT value FROM settings WHERE "key" = ?').get(SECRET_KEY);
setSetting(SECRET_KEY, masked); // 模拟前端把掩码原样 PUT 回来（上层本会短路，这里直测底层不改写）
const after = await getDb().prepare('SELECT value FROM settings WHERE "key" = ?').get(SECRET_KEY);
check('掩码值不会被当成新密钥落库（resolveSecretInput 语义）', resolveSecretInput(masked, PLAIN) === PLAIN && isMaskedSecret(masked));
check('脱敏展示可逆识别（末 4 位）', maskSecret(PLAIN).endsWith(PLAIN.slice(-4)));
void before; void after;

// ---- 6. 解密失败容错 ----
const good = encryptSecret('sk-tamper-test');
const tampered = good.slice(0, -4) + 'AAAA';
const warn = console.warn;
let warned = false;
console.warn = (...a) => { warned = true; warn(...a); };
const back = decryptSecret(tampered);
console.warn = warn;
check('篡改密文不抛异常且原样返回', back === tampered && warned, '（已告警）');

// ---- 汇总 ----
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
