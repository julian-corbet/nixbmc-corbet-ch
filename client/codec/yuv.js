// YUV->BGR conversion (the AST engine's own fixed-point color-matrix tables,
// built once in decoder.js's initColorTable). Output goes to st.decodeBuf as
// 24-bit BGR (3 bytes/pixel).

export function clampRange(st, v) {
  return v >= 0 ? st.rangeLimitTable[v + 256] : 0;
}

export function clamp255(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

export function convertYUVtoRGB(st, tx, ty) {
  if (st.mode420 === 0) {
    // 4:4:4 path — one 8×8 tile.
    for (let i = 0; i < 64; i++) st.yTile[i] = st.yuvTile[i];
    for (let i = 0; i < 64; i++) {
      st.cbTile[i] = st.yuvTile[64 + i];
      st.crTile[i] = st.yuvTile[128 + i];
    }
    const x0 = tx * 8;
    const y0 = ty * 8;
    let off = y0 * st.realWidth + x0;
    let limit = st.realWidth - x0;
    if (limit === 0 || limit > 8) limit = 8;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < limit; c++) {
        const idx = (r << 3) + c;
        const pi = (off + c) * 3;
        const yv = st.yTile[idx];
        const cb = st.cbTile[idx];
        const cr = st.crTile[idx];
        st.prevYUV[pi] = yv;
        st.prevYUV[pi + 1] = cb;
        st.prevYUV[pi + 2] = cr;
        const blue = st.calcRGBofY[yv] + st.calcRGBofCbToB[cb];
        const green = st.calcRGBofY[yv] + st.calcRGBofCbToG[cb] + st.calcRGBofCrToG[cr];
        const red = st.calcRGBofY[yv] + st.calcRGBofCrToR[cr];
        if (pi < st.realWidth * st.realH * 3) {
          st.decodeBuf[pi] = clampRange(st, blue);
          st.decodeBuf[pi + 1] = clampRange(st, green);
          st.decodeBuf[pi + 2] = clampRange(st, red);
        }
      }
      off += st.realWidth;
    }
    return;
  }

  // 4:2:0 path — 16×16 tile: 4 luma 8×8 blocks + one 8×8 Cb + one 8×8 Cr.
  let p = 0;
  for (let blk = 0; blk < 4; blk++) {
    for (let i = 0; i < 64; i++) {
      st.yTile420[blk][i] = st.yuvTile[p];
      p++;
    }
  }
  for (let i = 0; i < 64; i++) {
    st.cbTile[i] = st.yuvTile[p];
    st.crTile[i] = st.yuvTile[p + 64];
    p++;
  }
  const x0 = tx * 16;
  const y0 = ty * 16;
  // Faithful to the reference: the offset is seeded with the padded WIDTH
  // (y0*st.width) but rows advance by the unpadded realWidth below — this
  // asymmetry only matters when width isn't a multiple of 16 and must match
  // the encoder's own addressing, not be "normalized".
  let off = y0 * st.width + x0;
  const ic = [0, 0, 0, 0];
  let rows = 16;
  if (st.height === 608 && ty === 37) rows = 8; // reference special-case
  for (let r = 0; r < rows; r++) {
    const blkRow = (r >> 3) * 2;
    const yRow = (r >> 1) << 3;
    for (let c = 0; c < 16; c++) {
      const blk = blkRow + (c >> 3);
      const pos = ic[blk];
      ic[blk]++;
      const pi = (off + c) * 3;
      const chroma = yRow + (c >> 1);
      const yv = st.yTile420[blk][pos];
      const cb = st.cbTile[chroma];
      const cr = st.crTile[chroma];
      const blue = st.calcRGBofY[yv] + st.calcRGBofCbToB[cb];
      const green = st.calcRGBofY[yv] + st.calcRGBofCbToG[cb] + st.calcRGBofCrToG[cr];
      const red = st.calcRGBofY[yv] + st.calcRGBofCrToR[cr];
      st.decodeBuf[pi] = blue >= 0 ? st.rangeLimitTable[blue + 256] : 0;
      st.decodeBuf[pi + 1] = green >= 0 ? st.rangeLimitTable[green + 256] : 0;
      st.decodeBuf[pi + 2] = red >= 0 ? st.rangeLimitTable[red + 256] : 0;
    }
    off += st.realWidth;
  }
}

// convertYUVToRGBPass2 is a delta refinement over the previous frame's YUV
// (444 mode only — the reference no-ops this for 420).
export function convertYUVToRGBPass2(st, tx, ty) {
  if (st.mode420 !== 0) return;
  for (let i = 0; i < 64; i++) st.yTile[i] = st.yuvTile[i];
  for (let i = 0; i < 64; i++) {
    st.cbTile[i] = st.yuvTile[64 + i];
    st.crTile[i] = st.yuvTile[128 + i];
  }
  const x0 = tx * 8;
  const y0 = ty * 8;
  let off = y0 * st.realWidth + x0;
  let limit = st.realWidth - x0;
  if (limit === 0 || limit > 8) limit = 8;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < limit; c++) {
      const idx = (r << 3) + c;
      const pi = (off + c) * 3;
      const yv = clamp255(st.prevYUV[pi] + (st.yTile[idx] - 128));
      const cb = clamp255(st.prevYUV[pi + 1] + (st.cbTile[idx] - 128));
      const cr = clamp255(st.prevYUV[pi + 2] + (st.crTile[idx] - 128));
      const blue = st.calcRGBofY[yv] + st.calcRGBofCbToB[cb];
      const green = st.calcRGBofY[yv] + st.calcRGBofCbToG[cb] + st.calcRGBofCrToG[cr];
      const red = st.calcRGBofY[yv] + st.calcRGBofCrToR[cr];
      if (pi < st.realWidth * st.realH * 3) {
        st.decodeBuf[pi] = clampRange(st, blue);
        st.decodeBuf[pi + 1] = clampRange(st, green);
        st.decodeBuf[pi + 2] = clampRange(st, red);
      }
    }
    off += st.realWidth;
  }
}
