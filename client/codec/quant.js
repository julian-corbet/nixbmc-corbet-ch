import * as T from "./tables.js";

// Builds one 64-entry dequantization table from a signed-byte source table,
// a scale factor, and the AAN IDCT scale folded in as fixed point (<<16).

export function setQuantizationTable(src, scale, out) {
  for (let i = 0; i < 64; i++) {
    let v = Math.trunc((src[i] * 16) / scale);
    if (v <= 0) v = 1;
    if (v > 255) v = 255;
    out[T.zigzag[i]] = v;
  }
}

export function applyAANScale(qt) {
  let idx = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      qt[idx] = Math.trunc(qt[idx] * T.aanScaleFactor[r] * T.aanScaleFactor[c]) * 65536;
      idx++;
    }
  }
}

function buildTable(src, scale, qt) {
  const tmp = new Uint8Array(64);
  setQuantizationTable(src, scale, tmp);
  for (let i = 0; i <= 63; i++) qt[i] = tmp[T.zigzag[i]];
  applyAANScale(qt);
}

export function loadLuminanceQuantizationTable(st, qt) {
  buildTable(T.tblY[st.selector], st.scaleFactor, qt);
}

export function loadChrominanceQuantizationTable(st, qt) {
  const src = st.mapping === 1 ? T.tblY[st.selector] : T.tblUV[st.selector];
  buildTable(src, st.scaleFactorUV, qt);
}

export function loadPass2LuminanceQuantizationTable(st, qt) {
  buildTable(T.tblY[st.advanceSelector], st.advanceScaleFactor, qt);
}

export function loadPass2ChrominanceQuantizationTable(st, qt) {
  const src = st.mapping === 1 ? T.tblY[st.advanceSelector] : T.tblUV[st.advanceSelector];
  buildTable(src, st.advanceScaleFactorUV, qt);
}
