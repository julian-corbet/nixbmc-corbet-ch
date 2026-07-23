import { lookKbits, skipKbits } from "./bitreader.js";
import { convertYUVtoRGB } from "./yuv.js";

// decompressVQ fills a 16×16 (or 8×8 in 4:4:4) tile from a 1/2/4-entry 24-bit
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
