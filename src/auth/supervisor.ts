// Supervisor sign-in: full name plus ID number (D111). ID numbers are short, so a slow hash
// would not save them if the database leaked; what protects them is the key. The hash is an
// HMAC with PIN_SALT, which lives only in Cloudflare secrets (D058). The same number always
// gives the same hash, which is what lets the database refuse a number already in use.
import { hmac, sha256, toBase64Url } from './session.ts';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// Digits only, 4 to 12 long. Always text, never a number, so leading zeros are kept (D111).
export const isValidPin = (pin: string) => /^[0-9]{4,12}$/.test(pin);

export const hashPin = async (pin: string, salt: string) => hex(await hmac(salt, pin));

// Refused sign-ups count per address (D113), kept only as a keyed hash so no IP address is stored.
export const hashAddress = async (address: string, salt: string) => hex(await hmac(salt, `address:${address}`)).slice(0, 16);

// The cookie holds a random token; the session table holds only its hash, so reading the
// database does not give anyone a working cookie.
export const newSessionToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const sessionIdOf = async (token: string) => hex(await sha256(token));
