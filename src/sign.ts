// The signature every request between spredr's ai, agents and backends carries: ed25519 over the method, the path with
// its query as sent, the time, a one-time nonce and the body's sha256. Each side keeps only the other's public key.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

export const HEADERS = { from: 'x-spredr-from', time: 'x-spredr-time', nonce: 'x-spredr-nonce', signature: 'x-spredr-signature' } as const;
/** Who ai is when it signs a delivery or a callback. */
export const AI_SIGNER = 'ai';
const SKEW_MS = 5 * 60_000;
const NONCE = /^[0-9a-f]{32}$/;

export const privateKeyOf = (base64: string): KeyObject => createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
export const publicKeyOf = (base64: string): KeyObject => createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });

/** A new key pair for a backend that brings its own public key: keep `privateKey` secret, give spredr `publicKey`. */
export function newKeys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

const bytesToSign = (method: string, path: string, time: string, nonce: string, body: string | Uint8Array): Buffer =>
  Buffer.from([method.toUpperCase(), path, time, nonce, createHash('sha256').update(body).digest('hex')].join('\n'));

export function signedHeaders(from: string, key: KeyObject, method: string, path: string, body: string | Uint8Array): Record<string, string> {
  const time = new Date().toISOString();
  const nonce = randomBytes(16).toString('hex');
  return { [HEADERS.from]: from, [HEADERS.time]: time, [HEADERS.nonce]: nonce, [HEADERS.signature]: sign(null, bytesToSign(method, path, time, nonce, body), key).toString('base64') };
}

export interface Incoming {
  method: string;
  /** The path with its query, exactly as it arrived (Node's request.url). */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | Uint8Array;
}

/** Checks that a request was signed by ai, recently, and never seen before. One instance per process. */
export function aiVerifier(aiPublicKey: string) {
  const key = publicKeyOf(aiPublicKey);
  const seen = new Map<string, number>();
  return (request: Incoming): boolean => {
    const header = (name: string): string => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : '';
    };
    const time = header(HEADERS.time);
    const nonce = header(HEADERS.nonce);
    const at = Date.parse(time);
    if (header(HEADERS.from) !== AI_SIGNER || !Number.isFinite(at) || Math.abs(Date.now() - at) > SKEW_MS || !NONCE.test(nonce) || seen.has(nonce)) return false;
    let genuine = false;
    try {
      genuine = verify(null, bytesToSign(request.method, request.path, time, nonce, request.body), key, Buffer.from(header(HEADERS.signature), 'base64'));
    } catch {
      genuine = false;
    }
    if (!genuine) return false;
    const now = Date.now();
    for (const [old, until] of seen) {
      if (until > now) break;
      seen.delete(old);
    }
    seen.set(nonce, now + 2 * SKEW_MS);
    return true;
  };
}
