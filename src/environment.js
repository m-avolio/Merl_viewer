export async function uploadDefaultEnvironment(gl, texture, supportsFloatLinear) {
  const response = await fetch("./public/env/manifest.json", { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  const manifest = await response.json();
  if (manifest.encoding === "rgb16f-tonemapped-srgb") {
    const result = await uploadRawEnvTexture(gl, texture, `./${manifest.url}`, manifest.dimensions, supportsFloatLinear);
    return { ...result, label: manifest.source ?? "Default env map" };
  }

  const result = await uploadImageEnvTexture(gl, texture, `./${manifest.url}`);
  return { ...result, label: manifest.source ?? "Default env map" };
}

export async function uploadEnvFile(gl, texture, file) {
  const image = new Image();
  image.decoding = "async";
  image.src = URL.createObjectURL(file);

  try {
    await image.decode();
    const result = uploadImage(gl, texture, image);
    return { ...result, label: file.name };
  } finally {
    URL.revokeObjectURL(image.src);
  }
}

async function uploadRawEnvTexture(gl, texture, url, dimensions, supportsFloatLinear) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  const buffer = await response.arrayBuffer();
  const [width, height] = dimensions;
  const expectedBytes = width * height * 3 * 2;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`${url} has ${buffer.byteLength} bytes, expected ${expectedBytes}`);
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, width, height, 0, gl.RGB, gl.HALF_FLOAT, new Uint16Array(buffer));

  const halfData = new Uint16Array(buffer);
  const rgb = halfToFloatRgb(halfData);
  return {
    width,
    height,
    linear: supportsFloatLinear,
    importance: createEnvironmentImportance(width, height, rgb)
  };
}

async function uploadImageEnvTexture(gl, texture, url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return uploadImage(gl, texture, image);
}

function uploadImage(gl, texture, image) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, image);

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const rgb = imageToFloatRgb(image, width, height);
  return { width, height, linear: true, importance: createEnvironmentImportance(width, height, rgb) };
}

export function createEnvironmentImportance(width, height, rgb) {
  const conditionalCdf = new Float32Array(width * height);
  const marginalCdf = new Float32Array(height);
  const rowWeights = new Float64Array(height);
  let totalWeight = 0;

  for (let y = 0; y < height; y += 1) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const solidAngle = ((2 * Math.PI) / width) * (Math.PI / height) * Math.max(Math.sin(theta), 1e-6);
    let rowWeight = 0;
    const rowStart = y * width;

    for (let x = 0; x < width; x += 1) {
      const index = rowStart + x;
      const offset = index * 3;
      const luminance = 0.2126 * rgb[offset] + 0.7152 * rgb[offset + 1] + 0.0722 * rgb[offset + 2];
      rowWeight += Math.max(luminance, 1e-6) * solidAngle;
      conditionalCdf[index] = rowWeight;
    }

    rowWeights[y] = rowWeight;
    totalWeight += rowWeight;

    if (rowWeight > 0) {
      for (let x = 0; x < width; x += 1) {
        conditionalCdf[rowStart + x] /= rowWeight;
      }
      conditionalCdf[rowStart + width - 1] = 1;
    } else {
      for (let x = 0; x < width; x += 1) {
        conditionalCdf[rowStart + x] = (x + 1) / width;
      }
    }
  }

  let rowAccumulation = 0;
  for (let y = 0; y < height; y += 1) {
    rowAccumulation += rowWeights[y];
    marginalCdf[y] = totalWeight > 0 ? rowAccumulation / totalWeight : (y + 1) / height;
  }
  marginalCdf[height - 1] = 1;

  return {
    width,
    height,
    totalWeight,
    conditionalCdf,
    marginalCdf
  };
}

function halfToFloatRgb(values) {
  const rgb = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    rgb[i] = halfToFloat(values[i]);
  }
  return rgb;
}

function imageToFloatRgb(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const rgb = new Float32Array(width * height * 3);

  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgb[j] = pixels[i] / 255;
    rgb[j + 1] = pixels[i + 1] / 255;
    rgb[j + 2] = pixels[i + 2] / 255;
  }

  return rgb;
}

function halfToFloat(value) {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const mantissa = value & 0x03ff;

  if (exponent === 0) {
    return sign * Math.pow(2, -14) * (mantissa / 1024);
  }

  if (exponent === 31) {
    return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }

  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}
