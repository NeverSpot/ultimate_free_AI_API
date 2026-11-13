import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey).digest();
}

export function encryptAes256Gcm(
  plaintext: string,
  masterKey: string,
): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const key = deriveKey(masterKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: encrypted, iv, authTag: cipher.getAuthTag() };
}

export function decryptAes256Gcm(
  ciphertext: Buffer,
  iv: Buffer,
  authTag: Buffer,
  masterKey: string,
): string {
  const key = deriveKey(masterKey);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return salt.toString('hex') + ':' + key.toString('hex');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
}
