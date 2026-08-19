import { lookKbits, skipKbits } from "./bitreader.js";
import { convertYUVtoRGB } from "./yuv.js";

// DEFECT — this writes only the 4:4:4 tile layout (Y/Cb/Cr at yuvTile 0/64/128,
// 64 pixels). In 4:2:0 the consumer, yuv.js, reads four luma blocks at 0–255,
// Cb at 256–319 and Cr at 320–383, so luma blocks 1 and 2 get the Cb/Cr values
// as luma while luma block 3 and both chroma blocks keep the previous tile's
// contents. Affects macro-block codes 5/6/7/13/14/15. See README "Status".
//
// decompressVQ is MEANT to fill a 16×16 (or 8×8 in 4:4:4) tile from a 1/2/4-entry 24-bit
// colour cache (packed 0xYYCbCr — the AST VQ path stores YCbCr, not RGB, in
// the 24-bit cache word), optionally reading a per-pixel index of BitMapBits
// bits, then runs the same YUV->RGB conversion as the JPEG path.
export function decompressVQ(st, tx, ty) {
  let idx = 0;
  if (st.vq.BitMapBits === 0) {
    const color = st.vq.Color[st.vq.Index[0]];
    const yv = (color & 0x00ff0000) >>> 16;
    const cb = (color & 0x0000ff00) >>> 8;
    const cr = color & 0x000000ff;
    for (let i = 0; i < 64; i++) {
      st.yuvTile[idx + 0] = yv;
      st.yuvTile[idx + 64] = cb;
      st.yuvTile[idx + 128] = cr;
      idx++;
    }
  } else {
    const bits = st.vq.BitMapBits;
    for (let i = 0; i < 64; i++) {
      const sel = lookKbits(st, bits);
      const color = st.vq.Color[st.vq.Index[sel]];
      st.yuvTile[idx + 0] = (color & 0x00ff0000) >>> 16;
      st.yuvTile[idx + 64] = (color & 0x0000ff00) >>> 8;
      st.yuvTile[idx + 128] = color & 0x000000ff;
      idx++;
      skipKbits(st, bits);
    }
  }
  convertYUVtoRGB(st, tx, ty);
}
