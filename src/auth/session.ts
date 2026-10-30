// Signed sessions and secret comparison. Works the same in the Worker and in Node tests
// (both have Web Crypto). A session is a small JSON body plus an HMAC-SHA256 signature made
// with SESSION_SECRET, which lives only in Cloudflare secrets (D058).

export const SESSION_SECONDS = 12 * 60 * 60; // 12 hours, as for supervisors (D083)

export type Session = {
  role: 'admin';
  exp: number; // expiry, seconds since the Unix epoch
};

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

// Compares every byte, so the time taken does not show how much of a guess was right.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// True when the typed value matches the stored secret. Hashing first gives both sides the
// same length, so the comparison does not leak the secret's length either.
export async function sameSecret(typed: string, stored: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(typed), sha256(stored)]);
  return equalBytes(a, b);
}

export async function signSession(session: Session, secret: string): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(session)));
  return `${body}.${toBase64Url(await hmac(secret, body))}`;
}

// The session if the token is genuine and not expired; otherwise null. Never throws.
export async function readSession(token: string, secret: string, nowMs: number): Promise<Session | null> {
  try {
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    if (!equalBytes(fromBase64Url(sig), await hmac(secret, body))) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Session;
    if (session.role !== 'admin' || typeof session.exp !== 'number') return null;
    if (session.exp * 1000 <= nowMs) return null;
    return session;
  } catch {
    return null;
  }
}
