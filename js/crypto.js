/* WebCrypto only. The app private key (setup code) and the inbox key never leave this device. */
export function b64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export function b64uEnc(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function parseSetup(code) {
  code = (code || '').replace(/\s+/g, '');
  if (!code.startsWith('PFM1.')) throw new Error('設定碼要以 PFM1. 開頭，請整段重新貼上。');
  let j;
  try { j = JSON.parse(new TextDecoder().decode(b64u(code.slice(5)))); } catch (e) { throw new Error('設定碼不完整，請整段重新貼上。'); }
  if (!j.r || !j.k) throw new Error('設定碼不完整，請整段重新貼上。');
  return j;
}
/* ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, the envelope written by pfmapp.py (same as v1). */
export async function decryptEnvelope(env, setup) {
  const AAD = new TextEncoder().encode('pfm-app-v1');
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const priv = await crypto.subtle.importKey('pkcs8', b64u(setup.k), ecdh, false, ['deriveBits']);
  const epkRaw = b64u(env.epk);
  const epk = await crypto.subtle.importKey('raw', epkRaw, ecdh, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epkRaw, info: AAD }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u(env.iv), additionalData: AAD }, key, b64u(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
/* Write-back batch: base64url(nonce ‖ AES-256-GCM(inbox key, JSON)), AAD "pfm-cmd-v1" (pfm_inbox.py unseal). */
export async function sealCommands(obj, keyB64) {
  const key = await crypto.subtle.importKey('raw', b64u(keyB64), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('pfm-cmd-v1') }, key,
    new TextEncoder().encode(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return b64uEnc(out);
}
