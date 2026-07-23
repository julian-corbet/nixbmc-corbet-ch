import * as T from "./tables.js";
import { lookKbits, skipKbits, getKbits, toInt8, toInt16 } from "./bitreader.js";
import { wordHiLo, u16 } from "./huffman.js";

// multiply ports the reference's `(int32 a * int32 b) >> 8` — the product
// must wrap at 32 bits the same way Go's int32 multiplication does, hence
// Math.imul rather than plain `*` (which would silently lose precision
// differently than two's-complement wraparound for large operands).
function multiply(a, b) {
  return Math.imul(a, b) >> 8;
}

// dequant ports `int32((int64(c) * q) >> 16)` — c*q routinely exceeds 32 bits
// (q carries a 16-bit fixed-point shift), so this needs true (double-precision,
// exact within Number.MAX_SAFE_INTEGER) multiplication and a floor-division
// arithmetic shift, not a 32-bit bitwise one.
function dequant(c, q) {
  return Math.floor((c * q) / 65536) | 0;
}

// decodeHuffmanDataUnit reads one 8×8 block's DC+AC coefficients into
// st.dctCoeff[off..off+63], returning the updated DC predictor.
export function decodeHuffmanDataUnit(st, dcTbl, acTbl, dcPred, off) {
  st.dctCoeff.fill(0);

  const htDC = st.htDC[dcTbl];
  const b3 = htDC.Len[(st.recv[0] >>> 16) & 0xffff];
  const look = lookKbits(st, b3);
  skipKbits(st, b3);
  const dcIdx = u16(wordHiLo(toInt8(b3), toInt8(look - htDC.minorCode[b3])));
  const b4 = toInt8(htDC.V[dcIdx]);
  if (b4 === 0) {
    st.dctCoeff[off + 0] = dcPred;
  } else {
    st.dctCoeff[off] = dcPred + getKbits(st, b4);
    dcPred = toInt16(st.dctCoeff[off]);
  }

  const htAC = st.htAC[acTbl];
  let b5 = 1;
  for (;;) {
    const b6 = htAC.Len[(st.recv[0] >>> 16) & 0xffff];
    const look2 = lookKbits(st, b6);
    skipKbits(st, b6);
    const acIdx = u16(wordHiLo(toInt8(b6), toInt8(look2 - htAC.minorCode[b6])));
    const b7 = toInt8(htAC.V[acIdx]);
    const b8 = b7 & 15; // magnitude bits
    const b9 = (b7 >> 4) & 15; // zero run
    if (b8 === 0) {
      if (b9 === 15) {
        b5 += 16;
      } else {
        return dcPred;
      }
    } else {
      const b10 = b5 + b9;
      st.dctCoeff[off + T.dezigzag[b10]] = getKbits(st, b8);
      b5 = b10 + 1;
    }
    if (b5 >= 64) break;
  }
  return dcPred;
}

// inverseDCT dequantizes st.dctCoeff (an 8×8 block at `off`) using st.qt[qtIdx]
// and writes the spatial-domain result into st.yuvTile at `off`. This is the
// AAN-style integer IDCT — the 277/362/473/669 constants and the >>3/&1023
// range-limit addressing are the AST firmware's exact transform; substituting
// a textbook IDCT here would decode a subtly different image than the encoder
// actually produced.
export function inverseDCT(st, off, qtIdx) {
  const qt = st.qt[qtIdx];
  const c = st.dctCoeff;
  const ws = st.workspace;

  let i4 = off, i2 = 0, i3 = 0;
  for (let col = 8; col > 0; col--) {
    if ((c[i4 + 8] | c[i4 + 16] | c[i4 + 24] | c[i4 + 32] | c[i4 + 40] | c[i4 + 48] | c[i4 + 56]) === 0) {
      const dc = dequant(c[i4 + 0], qt[i2 + 0]);
      ws[i3 + 0] = dc; ws[i3 + 8] = dc; ws[i3 + 16] = dc; ws[i3 + 24] = dc;
      ws[i3 + 32] = dc; ws[i3 + 40] = dc; ws[i3 + 48] = dc; ws[i3 + 56] = dc;
      i4++; i2++; i3++;
      continue;
    }
    const t0 = dequant(c[i4 + 0], qt[i2 + 0]);
    const t1 = dequant(c[i4 + 16], qt[i2 + 16]);
    const t2 = dequant(c[i4 + 32], qt[i2 + 32]);
    const t3 = dequant(c[i4 + 48], qt[i2 + 48]);
    const tmp10 = t0 + t2;
    const tmp11 = t0 - t2;
    const tmp13 = t1 + t3;
    const tmp12 = multiply(t1 - t3, 362) - tmp13;
    const a0 = tmp10 + tmp13;
    const a3 = tmp10 - tmp13;
    const a1 = tmp11 + tmp12;
    const a2 = tmp11 - tmp12;

    const s0 = dequant(c[i4 + 8], qt[i2 + 8]);
    const s1 = dequant(c[i4 + 24], qt[i2 + 24]);
    const s2 = dequant(c[i4 + 40], qt[i2 + 40]);
    const s3 = dequant(c[i4 + 56], qt[i2 + 56]);
    const z13 = s2 + s1;
    const z10 = s2 - s1;
    const z11 = s0 + s3;
    const z12 = s0 - s3;
    const u7 = z11 + z13;
    const u11 = multiply(z11 - z13, 362);
    const z5 = multiply(z10 + z12, 473);
    const u10 = multiply(z12, 277) - z5;
    const u12 = multiply(z10, -669) + z5 - u7;
    const v6 = u11 - u12;
    const v5 = u10 + v6;

    ws[i3 + 0] = a0 + u7; ws[i3 + 56] = a0 - u7;
    ws[i3 + 8] = a1 + u12; ws[i3 + 48] = a1 - u12;
    ws[i3 + 16] = a2 + v6; ws[i3 + 40] = a2 - v6;
    ws[i3 + 32] = a3 + v5; ws[i3 + 24] = a3 - v5;
    i4++; i2++; i3++;
  }

  let w = 0;
  for (let r = 0; r < 8; r++) {
    const base = off + r * 8;
    const tmp10 = ws[w + 0] + ws[w + 4];
    const tmp11 = ws[w + 0] - ws[w + 4];
    const tmp13 = ws[w + 2] + ws[w + 6];
    const tmp12 = multiply(ws[w + 2] - ws[w + 6], 362) - tmp13;
    const a0 = tmp10 + tmp13;
    const a3 = tmp10 - tmp13;
    const a1 = tmp11 + tmp12;
    const a2 = tmp11 - tmp12;

    const z13 = ws[w + 5] + ws[w + 3];
    const z10 = ws[w + 5] - ws[w + 3];
    const z11 = ws[w + 1] + ws[w + 7];
    const z12 = ws[w + 1] - ws[w + 7];
    const u7 = z11 + z13;
    const u11 = multiply(z11 - z13, 362);
    const z5 = multiply(z10 + z12, 473);
    const u10 = multiply(z12, 277) - z5;
    const u12 = multiply(z10, -669) + z5 - u7;
    const v6 = u11 - u12;
    const v5 = u10 + v6;

    st.yuvTile[base + 0] = st.rangeLimitTableShort[128 + (((a0 + u7) >> 3) & 1023) + 256];
    st.yuvTile[base + 7] = st.rangeLimitTableShort[128 + (((a0 - u7) >> 3) & 1023) + 256];
    st.yuvTile[base + 1] = st.rangeLimitTableShort[128 + (((a1 + u12) >> 3) & 1023) + 256];
    st.yuvTile[base + 6] = st.rangeLimitTableShort[128 + (((a1 - u12) >> 3) & 1023) + 256];
    st.yuvTile[base + 2] = st.rangeLimitTableShort[128 + (((a2 + v6) >> 3) & 1023) + 256];
    st.yuvTile[base + 5] = st.rangeLimitTableShort[128 + (((a2 - v6) >> 3) & 1023) + 256];
    st.yuvTile[base + 4] = st.rangeLimitTableShort[128 + (((a3 + v5) >> 3) & 1023) + 256];
    st.yuvTile[base + 3] = st.rangeLimitTableShort[128 + (((a3 - v5) >> 3) & 1023) + 256];
    w += 8;
  }
}
