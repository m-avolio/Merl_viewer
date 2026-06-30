import { BRDF_DIMS } from "./config.js";

export async function loadMaterialManifest() {
  const response = await fetch("./public/merl/manifest.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("MERL manifest missing");
  }
  return response.json();
}

export function pickDefaultMaterial(materials) {
  return (
    materials.find((material) => material.name === "gold-metallic-paint") ??
    materials.find((material) => material.name === "red-plastic") ??
    materials.find((material) => material.name === "silver-paint") ??
    materials.find((material) => material.name === "chrome") ??
    materials[0]
  );
}

export async function uploadMaterial(gl, texture, material, supportsFloatLinear) {
  const response = await fetch(`./${material.url}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${material.url}`);
  }

  const buffer = await response.arrayBuffer();
  const upload = prepareMaterialUpload(gl, material, buffer, supportsFloatLinear);
  if (buffer.byteLength !== upload.expectedBytes) {
    throw new Error(`${material.name} has ${buffer.byteLength} bytes, expected ${upload.expectedBytes}`);
  }

  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    upload.internalFormat,
    BRDF_DIMS[0],
    BRDF_DIMS[1],
    BRDF_DIMS[2],
    0,
    gl.RGB,
    upload.type,
    upload.data
  );

  return { linear: upload.linear };
}

function prepareMaterialUpload(gl, material, buffer, supportsFloatLinear) {
  const sampleBytes = BRDF_DIMS[0] * BRDF_DIMS[1] * BRDF_DIMS[2] * 3;

  if (material.encoding === "rgb16f-log") {
    return {
      data: new Uint16Array(buffer),
      expectedBytes: sampleBytes * 2,
      internalFormat: gl.RGB16F,
      type: gl.HALF_FLOAT,
      linear: supportsFloatLinear
    };
  }

  throw new Error(`Unsupported material encoding: ${material.encoding}`);
}
