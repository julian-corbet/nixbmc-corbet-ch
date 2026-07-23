// Decodes the AMI/ASPEED KVM video stream: a tile-based hybrid of VQ (vector
// quantization) and JPEG (DCT + Huffman + quantization), YUV 4:2:0, with
// optional RC4 encryption of the entropy-coded data and delta (skip) tiles
// relative to the previous frame. See ../../docs/codec-notes.md for the
// protocol facts this implements and where they came from.
import { initHuffmanTables } from "./huffman.js";
import { decodeFrame, roundUp } from "./decode.js";
import { newRc4State } from "./rc4.js";
import * as STD_TABLES from "./tables.js";
import { toInt16 } from "./bitreader.js";

const VIDEO_HEADER_SIZE = 86;
const MAX_RESOLUTION = 1500;

function parseFrameHeader(frame) {
  if (frame.byteLength < VIDEO_HEADER_SIZE) {
    throw new Error(`kvm/codec: frame too short: ${frame.byteLength} < ${VIDEO_HEADER_SIZE}`);
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const h = {
    sourceX: dv.getUint16(4, true),
    sourceY: dv.getUint16(6, true),
    destX: dv.getUint16(13, true),
    destY: dv.getUint16(15, true),
    compressionMode: dv.getUint8(42),
    jpegScaleFactor: dv.getUint8(43),
    jpegTableSelector: dv.getUint8(44),
    jpegYUVTableMapping: dv.getUint8(45),
    sharpModeSelection: dv.getUint8(46),
    advanceTableSelector: dv.getUint8(47),
    advanceScaleFactor: dv.getUint8(48),
    numberOfMB: dv.getInt32(49, true),
    rc4Enable: dv.getUint8(53),
    rc4Reset: dv.getUint8(54),
    mode420: dv.getUint8(55),
    compressSize: dv.getInt32(69, true),
  };
  return { h, compressed: frame.subarray(VIDEO_HEADER_SIZE) };
}

function makeIntArray(bytes) {
  const n = bytes.length;
  const pad = (4 - (n % 4)) % 4;
  const out = new Uint32Array((n + pad) / 4);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    let v = bytes[j + 0] >>> 0;
    if (j + 1 < n) v |= bytes[j + 1] << 8;
    if (j + 2 < n) v |= bytes[j + 2] << 16;
    if (j + 3 < n) v |= bytes[j + 3] << 24;
    out[i] = v >>> 0;
  }
  return out;
}

function initColorTable(st) {
  const half = 65536 >> 1;
  const fixG = (v) => Math.trunc(v * 65536.0 + 0.5);
  let cr = -128;
  for (let i = 0; i < 256; i++) {
    st.calcRGBofCrToR[i] = Math.floor((fixG(1.597656) * cr + half) / 65536);
    st.calcRGBofCbToB[i] = Math.floor((fixG(2.015625) * cr + half) / 65536);
    st.calcRGBofCrToG[i] = Math.floor((-fixG(0.8125) * cr + half) / 65536);
    st.calcRGBofCbToG[i] = Math.floor((-fixG(0.390625) * cr + half) / 65536);
    cr++;
  }
  let yv = -16;
  for (let i = 0; i < 256; i++) {
    st.calcRGBofY[i] = Math.floor((fixG(1.164) * yv + half) / 65536);
    yv++;
  }
}

function initRangeLimitTable(st) {
  for (let s = 0; s < 256; s++) {
    st.rangeLimitTable[256 + s] = s;
    st.rangeLimitTableShort[256 + s] = s;
  }
  for (let i = 512; i < 895; i++) {
    st.rangeLimitTable[i] = 0xff;
    st.rangeLimitTableShort[i] = 255;
  }
  for (let s = 1280; s < 1408; s++) {
    st.rangeLimitTable[s] = s & 0xff;
    st.rangeLimitTableShort[s] = s & 255;
  }
}

// createDecoder returns fresh, persistent decoder state — one instance per
// KVM session, reused frame-to-frame (quant/Huffman tables, the previous-
// frame YUV for delta tiles, and RC4 keystream state all carry over).
export function createDecoder() {
  const st = {
    width: 0, height: 0, realWidth: 0, realH: 0,
    tmpWidthBy16: 0, tmpHeightBy16: 0, mode420: 1,

    scaleFactor: 16, scaleFactorUV: 16, advanceScaleFactor: 16, advanceScaleFactorUV: 16,
    selector: 0, advanceSelector: 0, mapping: 0,

    qt: [new Float64Array(64), new Float64Array(64), new Float64Array(64), new Float64Array(64)],

    htDC: null, htAC: null,

    dcY: 0, dcCb: 0, dcCr: 0,
    yDCnr: 0, cbDCnr: 1, crDCnr: 1,
    yACnr: 0, cbACnr: 1, crACnr: 1,

    recv: new Uint32Array(0), index: 0, newbits: 32,

    dctCoeff: new Int32Array(384),
    workspace: new Int32Array(64),
    yuvTile: new Int32Array(768),
    yTile420: [new Int32Array(64), new Int32Array(64), new Int32Array(64), new Int32Array(64)],
    cbTile: new Int32Array(64),
    crTile: new Int32Array(64),
    yTile: new Int32Array(64),

    decodeBuf: new Uint8Array(0),
    bufStride: 0,
    bufAlloc: 0,
    prevYUV: new Int32Array(0),

    rangeLimitTable: new Uint8Array(1408),
    rangeLimitTableShort: new Int16Array(1408),
    calcRGBofY: new Int32Array(256),
    calcRGBofCrToR: new Int32Array(256),
    calcRGBofCbToB: new Int32Array(256),
    calcRGBofCrToG: new Int32Array(256),
    calcRGBofCbToG: new Int32Array(256),
    negPow2: new Int16Array(17),

    rc4: newRc4State(),
    rc4SetupDone: false,

    vq: { Color: new Uint32Array(4), Index: new Int32Array(4), BitMapBits: 0 },

    txb: 0, tyb: 0,
    signedWordvalue: 0,
  };

  for (let i = 1; i < 17; i++) st.negPow2[i] = toInt16(1 - (1 << i));
  const { htDC, htAC } = initHuffmanTables(STD_TABLES);
  st.htDC = htDC;
  st.htAC = htAC;
  initColorTable(st);
  initRangeLimitTable(st);
  return st;
}

// decodeVideoFrame turns one reassembled CMD_VIDEO_PACKETS payload into an
// RGBA frame ready for canvas ImageData (alpha forced to 255 — the reference
// target was an RFB raw blit with an ignored padding byte, not real alpha).
//
// The payload (immediately after the 8-byte IVTP header) is NOT just the
// 86-byte VideoHeader + compressed data — it's prefixed with a 2-byte
// fragment number the vendor's own video_worker.js explicitly skips
// (`this.sock.pos += 2` before reading the VideoHeader). Skipping only the
// IVTP header and not this field silently misaligns every VideoHeader field
// by 2 bytes, which reads as plausible-looking but wrong resolutions rather
// than an outright parse failure — worth flagging since it's easy to miss.
//
// This only handles the non-fragmented case (a full frame in one
// CMD_VIDEO_PACKETS payload) — real multi-fragment continuation (tracked by
// the vendor client's `prev_complete` flag) isn't implemented yet.
export function decodeVideoFrame(st, framePayload) {
  const { h, compressed } = parseFrameHeader(framePayload.subarray(2));
  if (h.destX <= 0 || h.destY <= 0 || h.destX > MAX_RESOLUTION || h.destY > MAX_RESOLUTION) {
    throw new Error(`kvm/codec: bad resolution ${h.destX}x${h.destY}`);
  }
  const recv = makeIntArray(compressed);
  decodeFrame(st, h, recv);

  const w = st.realWidth;
  const hh = st.realH;
  const pix = new Uint8ClampedArray(w * hh * 4);
  const src = st.decodeBuf;
  let di = 0;
  for (let y = 0; y < hh; y++) {
    const row = y * st.bufStride * 3;
    for (let x = 0; x < w; x++) {
      const si = row + x * 3;
      pix[di + 0] = src[si + 2]; // R
      pix[di + 1] = src[si + 1]; // G
      pix[di + 2] = src[si + 0]; // B
      pix[di + 3] = 255;
      di += 4;
    }
  }
  return { w, h: hh, pix };
}

export { roundUp };
