import { clamp, latLongToDirection, normalize, softBox } from "./math.js";
import { createEnvironmentImportance } from "./environment.js";

export function uploadDefaultEnvTexture(gl, texture) {
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const direction = latLongToDirection(u, v);
      const horizon = Math.max(0, 1 - Math.abs(direction[1]) * 1.35);
      const ceiling = Math.max(0, direction[1]);
      const floor = Math.max(0, -direction[1]);
      let r = 0.08 + horizon * 0.18 + ceiling * 0.1 + floor * 0.06;
      let g = 0.09 + horizon * 0.14 + ceiling * 0.14 + floor * 0.05;
      let b = 0.09 + horizon * 0.1 + ceiling * 0.16 + floor * 0.04;

      const key = softBox(direction, normalize([0.34, 0.58, 0.74]), 0.06);
      const rim = softBox(direction, normalize([-0.72, 0.26, -0.48]), 0.08);
      const warm = softBox(direction, normalize([0.2, -0.35, -0.92]), 0.05);
      r += key * 5.8 + rim * 1.2 + warm * 1.8;
      g += key * 5.5 + rim * 1.8 + warm * 1.1;
      b += key * 5.1 + rim * 2.3 + warm * 0.58;

      const offset = (y * width + x) * 3;
      data[offset] = Math.round(clamp(r / (1 + r), 0, 1) * 255);
      data[offset + 1] = Math.round(clamp(g / (1 + g), 0, 1) * 255);
      data[offset + 2] = Math.round(clamp(b / (1 + b), 0, 1) * 255);
    }
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, data);

  return {
    width,
    height,
    linear: true,
    label: "Procedural fallback",
    importance: createEnvironmentImportance(width, height, rgb8ToFloat(data))
  };
}

function rgb8ToFloat(data) {
  const rgb = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    rgb[i] = data[i] / 255;
  }
  return rgb;
}
