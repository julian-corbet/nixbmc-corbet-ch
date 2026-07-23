import { toInt16 } from "./bitreader.js";

// A fast Huffman decode table: per-bit-length min/max code, a direct value
// lookup keyed by a (length,offset) word, and a 64k bit-length lookup keyed by
// the top 16 bits of the register (Len[]) so the decoder never walks the code
// tree bit-by-bit.
export function newHuffmanTable() {
  return {
    length: new Uint8Array(17),
    minorCode: new Int16Array(17),
    majorCode: new Int16Array(17),
    V: new Int16Array(65536),
    Len: new Uint8Array(65536),
  };
}

export function wordHiLo(hi, lo) {
  return toInt16(((hi & 0xff) << 8) | (lo & 0xff));
}

export function u16(v) {
  return v & 0xffff;
}

export function loadHuffmanTable(ht, nrcodes, values, huffcode) {
  for (let b = 1; b <= 16; b++) ht.length[b] = nrcodes[b];

  let i = 0;
  for (let b4 = 1; b4 <= 16; b4++) {
    for (let b6 = 0; b6 < ht.length[b4]; b6++) {
      ht.V[u16(wordHiLo(b4, b6))] = values[i];
      i++;
    }
  }

  let i2 = 0;
  for (let b8 = 1; b8 <= 16; b8++) {
    ht.minorCode[b8] = toInt16(i2);
    for (let b10 = 1; b10 <= ht.length[b8]; b10++) i2++;
    ht.majorCode[b8] = toInt16(i2 - 1);
    i2 *= 2;
    if (ht.length[b8] === 0) {
      ht.minorCode[b8] = -1;
      ht.majorCode[b8] = 0;
    }
  }

  ht.Len[0] = 2;
  let i3 = 2;
  for (let i4 = 1; i4 < 65535; i4++) {
    if (i4 < huffcode[i3]) {
      ht.Len[i4] = huffcode[i3 + 1] & 255;
    } else {
      i3 += 2;
      ht.Len[i4] = huffcode[i3 + 1] & 255;
    }
  }
  return ht;
}

export function initHuffmanTables(T) {
  const htDC = [newHuffmanTable(), newHuffmanTable(), newHuffmanTable(), newHuffmanTable()];
  const htAC = [newHuffmanTable(), newHuffmanTable(), newHuffmanTable(), newHuffmanTable()];
  // Only slots 0 (luminance) and 1 (chrominance) are ever selected — see
  // decoder.js's yDCnr/cbDCnr/crDCnr component-table selectors.
  loadHuffmanTable(htDC[0], T.stdDCLuminanceNrcodes, T.stdDCLuminanceValues, T.dcLuminanceHuffmancode);
  loadHuffmanTable(htAC[0], T.stdACLuminanceNrcodes, T.stdACLuminanceValues, T.acLuminanceHuffmancode);
  loadHuffmanTable(htDC[1], T.stdDCChrominanceNrcodes, T.stdDCChrominanceValues, T.dcChrominanceHuffmancode);
  loadHuffmanTable(htAC[1], T.stdACChrominanceNrcodes, T.stdACChrominanceValues, T.acChrominanceHuffmancode);
  return { htDC, htAC };
}
