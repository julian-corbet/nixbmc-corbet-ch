// Bit-level reader over the packed little-endian uint32 tile stream. Two
// working registers (recv[0]/recv[1]) hold the current window; `index` points
// at the next word to pull in, `newbits` tracks how many valid bits remain in
// register 1. All register values are forced through `>>> 0` to keep them in
// the unsigned 32-bit domain the bit-packing math assumes.
export const VIRT_ADD = 0;

// lookKbits returns the top b bits of register 0, truncated/sign-extended to
// 16 bits (matching the reference's `int16(...)` cast — relevant when b=16
// and the extracted value's bit 15 is set, which real 16-bit-long Huffman
// codes do exercise).
export function lookKbits(st, b) {
  return toInt16(st.recv[0] >>> (32 - b));
}

export function skipKbits(st, b) {
  if (st.newbits - b <= 0) {
    let idx = VIRT_ADD + st.index;
    if (idx > st.recv.length - 1) idx = st.recv.length - 1;
    const r0 = st.recv[0] >>> 0;
    const r1 = st.recv[1] >>> 0;
    const refill = st.recv[idx] >>> 0;
    st.recv[0] = ((r0 << b) >>> 0) | (((r1 | (refill >>> st.newbits)) >>> (32 - b)) >>> 0);
    st.recv[1] = (refill << (b - st.newbits)) >>> 0;
    st.newbits = 32 + st.newbits - b;
    st.index++;
    return;
  }
  const r0 = st.recv[0] >>> 0;
  const r1 = st.recv[1] >>> 0;
  st.recv[0] = ((r0 << b) >>> 0) | (r1 >>> (32 - b));
  st.recv[1] = (r1 << b) >>> 0;
  st.newbits -= b;
}

export function updateReadBuf(st, i) {
  if (st.newbits - i <= 0) {
    const idx = VIRT_ADD + st.index;
    const readbuf = st.recv[idx] >>> 0;
    st.index++;
    const r0 = st.recv[0] >>> 0;
    const r1 = st.recv[1] >>> 0;
    st.recv[0] = ((r0 << i) >>> 0) | (((r1 | (readbuf >>> st.newbits)) >>> (32 - i)) >>> 0);
    st.recv[1] = (readbuf << (i - st.newbits)) >>> 0;
    st.newbits = 32 + st.newbits - i;
    return;
  }
  const r0 = st.recv[0] >>> 0;
  const r1 = st.recv[1] >>> 0;
  st.recv[0] = ((r0 << i) >>> 0) | (r1 >>> (32 - i));
  st.recv[1] = (r1 << i) >>> 0;
  st.newbits -= i;
}

// getKbits reads b bits and sign-extends via the negPow2 table (short
// arithmetic — the result is truncated to 16 bits, matching the reference's
// use of Java `short`/Go `int16` for coefficient magnitudes).
export function getKbits(st, b) {
  let v = lookKbits(st, b);
  if ((toInt16(1 << (b - 1)) & v) === 0) {
    v = toInt16(v + st.negPow2[b]);
  }
  st.signedWordvalue = v;
  skipKbits(st, b);
  return v;
}

export function toInt16(v) {
  return (v << 16) >> 16;
}

export function toInt8(v) {
  return (v << 24) >> 24;
}
