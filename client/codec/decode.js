import { keysExpansion, decodeRC4Setup, rc4Crypt } from "./rc4.js";
import {
  loadLuminanceQuantizationTable,
  loadChrominanceQuantizationTable,
  loadPass2LuminanceQuantizationTable,
  loadPass2ChrominanceQuantizationTable,
} from "./quant.js";
import { decodeHuffmanDataUnit, inverseDCT } from "./idct.js";
import { decompressVQ } from "./vq.js";
import { convertYUVtoRGB, convertYUVToRGBPass2 } from "./yuv.js";
import { updateReadBuf } from "./bitreader.js";

const DECODE_KEYS = new TextEncoder().encode("fedcba9876543210");

export function roundUp(v, n) {
  return v % n !== 0 ? v + n - (v % n) : v;
}

function readSkipPosition(st) {
  st.txb = (st.recv[0] & 0x0ff00000) >>> 20;
  st.tyb = (st.recv[0] & 0x000ff000) >>> 12;
}

function readVQHeader(st, bits, count) {
  st.vq.BitMapBits = bits;
  for (let i = 0; i < count; i++) {
    st.vq.Index[i] = (st.recv[0] >>> 29) & 3;
    if (((st.recv[0] >>> 31) & 1) === 0) {
      updateReadBuf(st, 3);
    } else {
      st.vq.Color[st.vq.Index[i]] = (st.recv[0] >>> 5) & 0x00ffffff;
      updateReadBuf(st, 27);
    }
  }
}

function decompressJPEG(st, tx, ty, b) {
  st.dcY = decodeHuffmanDataUnit(st, st.yDCnr, st.yACnr, st.dcY, 0);
  inverseDCT(st, 0, b);
  if (st.mode420 === 1) {
    st.dcY = decodeHuffmanDataUnit(st, st.yDCnr, st.yACnr, st.dcY, 64);
    inverseDCT(st, 64, b);
    st.dcY = decodeHuffmanDataUnit(st, st.yDCnr, st.yACnr, st.dcY, 128);
    inverseDCT(st, 128, b);
    st.dcY = decodeHuffmanDataUnit(st, st.yDCnr, st.yACnr, st.dcY, 192);
    inverseDCT(st, 192, b);
    st.dcCb = decodeHuffmanDataUnit(st, st.cbDCnr, st.cbACnr, st.dcCb, 256);
    inverseDCT(st, 256, b + 1);
    st.dcCr = decodeHuffmanDataUnit(st, st.crDCnr, st.crACnr, st.dcCr, 320);
    inverseDCT(st, 320, b + 1);
  } else {
    st.dcCb = decodeHuffmanDataUnit(st, st.cbDCnr, st.cbACnr, st.dcCb, 64);
    inverseDCT(st, 64, b + 1);
    st.dcCr = decodeHuffmanDataUnit(st, st.crDCnr, st.crACnr, st.dcCr, 128);
    inverseDCT(st, 128, b + 1);
  }
  convertYUVtoRGB(st, tx, ty);
}

// decompressJPEGPass2Block ports decompressJPEGPass2 — note this is only used
// by the two dedicated pass2 macro-block codes (2/10); codes 4/12 ("low
// JPEG") call decompressJPEG above with quant index 2, not this — that's the
// reference's actual dispatch, not a simplification.
function decompressJPEGPass2Block(st, tx, ty, b) {
  st.dcY = decodeHuffmanDataUnit(st, st.yDCnr, st.yACnr, st.dcY, 0);
  inverseDCT(st, 0, b);
  st.dcCb = decodeHuffmanDataUnit(st, st.cbDCnr, st.cbACnr, st.dcCb, 64);
  inverseDCT(st, 64, b + 1);
  st.dcCr = decodeHuffmanDataUnit(st, st.crDCnr, st.crACnr, st.dcCr, 128);
  inverseDCT(st, 128, b + 1);
  convertYUVToRGBPass2(st, tx, ty);
}

function moveBlockIndex(st) {
  st.txb++;
  if (st.mode420 === 0) {
    if (st.txb >= Math.floor(st.tmpWidthBy16 / 8)) {
      st.tyb++;
      if (st.tyb >= Math.floor(st.tmpHeightBy16 / 8)) st.tyb = 0;
      st.txb = 0;
    }
  } else if (st.txb >= Math.floor(st.tmpWidthBy16 / 16)) {
    st.tyb++;
    if (st.tyb >= Math.floor(st.tmpHeightBy16 / 16)) st.tyb = 0;
    st.txb = 0;
  }
}

export function ensureBuffers(st) {
  st.bufStride = st.mode420 === 0 ? st.realWidth : st.width;
  const need = st.width * st.height * 3;
  if (need > st.bufAlloc) {
    st.decodeBuf = new Uint8Array(need);
    st.prevYUV = new Int32Array(need);
    st.bufAlloc = need;
  }
}

// decodeFrame ports Decoder.decode(VideoEngineInfo, int[]) — the macro-block
// dispatch loop that walks the whole tile-coded compressed buffer.
export function decodeFrame(st, h, recv) {
  st.vq.Index[0] = 0; st.vq.Index[1] = 1; st.vq.Index[2] = 2; st.vq.Index[3] = 3;
  st.vq.Color[0] = 0x00008080;
  st.vq.Color[1] = 0x00ff8080;
  st.vq.Color[2] = 0x00808080;
  st.vq.Color[3] = 0x00c08080;

  st.width = h.destX;
  st.height = h.destY;
  st.realWidth = h.destX;
  st.realH = h.destY;
  st.mode420 = h.mode420;

  if (st.mode420 === 1) {
    st.width = roundUp(st.width, 16);
    st.height = roundUp(st.height, 16);
  } else {
    st.width = roundUp(st.width, 8);
    st.height = roundUp(st.height, 8);
  }

  st.tmpWidthBy16 = h.destX;
  st.tmpHeightBy16 = h.destY;
  if (st.mode420 === 1) {
    st.tmpWidthBy16 = roundUp(st.tmpWidthBy16, 16);
    st.tmpHeightBy16 = roundUp(st.tmpHeightBy16, 16);
  } else {
    st.tmpWidthBy16 = roundUp(st.tmpWidthBy16, 8);
    st.tmpHeightBy16 = roundUp(st.tmpHeightBy16, 8);
  }

  ensureBuffers(st);

  const compressWords = Math.floor(h.compressSize / 4);

  if (h.rc4Enable === 1) {
    if (!st.rc4SetupDone) {
      decodeRC4Setup(st.rc4, keysExpansion(DECODE_KEYS));
      st.rc4SetupDone = true;
    }
    let n = compressWords * 4;
    if (n > recv.length) n = recv.length;
    rc4Crypt(st.rc4, recv, n);
  }

  st.scaleFactor = 16;
  st.scaleFactorUV = 16;
  st.advanceScaleFactor = 16;
  st.advanceScaleFactorUV = 16;
  st.selector = h.jpegTableSelector;
  st.advanceSelector = h.advanceTableSelector;
  st.mapping = h.jpegYUVTableMapping;

  loadLuminanceQuantizationTable(st, st.qt[0]);
  loadChrominanceQuantizationTable(st, st.qt[1]);
  loadPass2LuminanceQuantizationTable(st, st.qt[2]);
  loadPass2ChrominanceQuantizationTable(st, st.qt[3]);

  st.recv = recv;
  st.index = 2;
  st.tyb = 0;
  st.txb = 0;
  st.newbits = 32;
  st.dcY = 0;
  st.dcCb = 0;
  st.dcCr = 0;

  if (recv.length < 2) return;

  for (;;) {
    const code = (st.recv[0] >>> 28) & 15;
    switch (code) {
      case 0: updateReadBuf(st, 4); decompressJPEG(st, st.txb, st.tyb, 0); moveBlockIndex(st); break;
      case 8: readSkipPosition(st); updateReadBuf(st, 20); decompressJPEG(st, st.txb, st.tyb, 0); moveBlockIndex(st); break;
      case 2: updateReadBuf(st, 4); decompressJPEGPass2Block(st, st.txb, st.tyb, 2); moveBlockIndex(st); break;
      case 10: readSkipPosition(st); updateReadBuf(st, 20); decompressJPEGPass2Block(st, st.txb, st.tyb, 2); moveBlockIndex(st); break;
      case 5: updateReadBuf(st, 4); readVQHeader(st, 0, 1); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 13: readSkipPosition(st); updateReadBuf(st, 20); readVQHeader(st, 0, 1); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 6: updateReadBuf(st, 4); readVQHeader(st, 1, 2); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 14: readSkipPosition(st); updateReadBuf(st, 20); readVQHeader(st, 1, 2); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 7: updateReadBuf(st, 4); readVQHeader(st, 2, 4); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 15: readSkipPosition(st); updateReadBuf(st, 20); readVQHeader(st, 2, 4); decompressVQ(st, st.txb, st.tyb); moveBlockIndex(st); break;
      case 4: updateReadBuf(st, 4); decompressJPEG(st, st.txb, st.tyb, 2); moveBlockIndex(st); break;
      case 12: readSkipPosition(st); updateReadBuf(st, 20); decompressJPEG(st, st.txb, st.tyb, 2); moveBlockIndex(st); break;
      case 9: return; // FRAME_END_CODE
      default: updateReadBuf(st, 3); moveBlockIndex(st); break;
    }
    if (st.index >= compressWords) return;
  }
}
