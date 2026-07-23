// The BMC's video-session RC4 layer, gated per-frame by the FrameHeader's
// RC4Enable flag. The fixed key below is a wire-protocol constant (both sides
// must agree on it for the stream to decrypt at all), not a secret.
const DECODE_KEYS = new TextEncoder().encode("fedcba9876543210");

export function keysExpansion(key) {
  const n = key.length;
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = key[i % n];
  return out;
}

export function newRc4State() {
  return { x: 0, y: 0, m: new Int32Array(256) };
}

export function decodeRC4Setup(state, expandedKey) {
  state.x = 0;
  state.y = 0;
  for (let i = 0; i < 256; i++) state.m[i] = i;
  let j = 0;
  let keyIdx = 0;
  for (let i = 0; i < 256; i++) {
    const v = state.m[i];
    j = (j + v + ((expandedKey[keyIdx] << 24) >> 24)) & 0xff;
    state.m[i] = state.m[j];
    state.m[j] = v;
    keyIdx++;
  }
}

// XORs n words of buf (starting at index 0) with the RC4 keystream — applied
// at 32-bit word granularity, matching the AST firmware's framing exactly
// (this only ever touches the low byte of each word).
export function rc4Crypt(state, buf, n) {
  let x = state.x;
  let y = state.y;
  const m = state.m;
  for (let i = 0; i < n; i++) {
    x = (x + 1) & 0xff;
    const a = m[x];
    y = (y + a) & 0xff;
    const b = m[y];
    m[x] = b;
    m[y] = a;
    buf[i] = (buf[i] ^ m[(a + b) & 0xff]) >>> 0;
  }
  state.x = x;
  state.y = y;
}

export function runSetup() {
  return keysExpansion(DECODE_KEYS);
}
