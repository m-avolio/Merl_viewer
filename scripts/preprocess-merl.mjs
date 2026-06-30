#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SRC = "brdfs";
const DEFAULT_OUT = "public/merl";
const THETA_H = 90;
const THETA_D = 90;
const PHI_D = 180;
const SAMPLE_COUNT = THETA_H * THETA_D * PHI_D;
const COLOR_SCALES = [1 / 1500, 1.15 / 1500, 1.66 / 1500];

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const sourceDir = path.resolve(root, args.src ?? DEFAULT_SRC);
const outputDir = path.resolve(root, args.out ?? DEFAULT_OUT);
const materialDir = path.join(outputDir, "materials");
const only = args.only ? new Set(args.only.split(",").map((name) => stripExt(name.trim()))) : null;
const floatScratch = new Float32Array(1);
const intScratch = new Uint32Array(floatScratch.buffer);

await mkdir(materialDir, { recursive: true });

const sourceFiles = (await readdir(sourceDir))
  .filter((file) => file.endsWith(".binary"))
  .filter((file) => !only || only.has(stripExt(file)))
  .sort((a, b) => a.localeCompare(b));

if (sourceFiles.length === 0) {
  throw new Error(`No .binary files found in ${sourceDir}`);
}

const startedAt = Date.now();
const materials = [];

for (let index = 0; index < sourceFiles.length; index += 1) {
  const file = sourceFiles[index];
  const name = stripExt(file);
  const sourcePath = path.join(sourceDir, file);
  const targetFile = `${name}.brdf16`;
  const targetPath = path.join(materialDir, targetFile);
  const prefix = `[${index + 1}/${sourceFiles.length}]`;

  process.stdout.write(`${prefix} ${name} `);
  const result = await convertMaterial(sourcePath, targetPath);
  materials.push({
    name,
    label: labelFromName(name),
    source: path.posix.join(args.src ?? DEFAULT_SRC, file),
    url: path.posix.join(args.out ?? DEFAULT_OUT, "materials", targetFile),
    dimensions: [PHI_D, THETA_D, THETA_H],
    encoding: "rgb16f-log",
    max: result.max,
    mean: result.mean,
    bytes: result.bytes
  });
  process.stdout.write(`-> ${(result.bytes / 1024 / 1024).toFixed(2)} MB\n`);
}

const manifest = {
  version: 1,
  format: "merl-rgb16f-log",
  generatedAt: new Date().toISOString(),
  source: args.src ?? DEFAULT_SRC,
  dimensions: {
    thetaHalf: THETA_H,
    thetaDiff: THETA_D,
    phiDiff: PHI_D,
    texture: [PHI_D, THETA_D, THETA_H]
  },
  colorScales: COLOR_SCALES,
  materials
};

await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
process.stdout.write(`Wrote ${materials.length} materials and manifest in ${elapsed}s\n`);

async function convertMaterial(sourcePath, targetPath) {
  const fileBuffer = await readFile(sourcePath);
  const dims = [
    fileBuffer.readInt32LE(0),
    fileBuffer.readInt32LE(4),
    fileBuffer.readInt32LE(8)
  ];

  if (dims[0] !== THETA_H || dims[1] !== THETA_D || dims[2] !== PHI_D) {
    throw new Error(`${sourcePath} has dimensions ${dims.join(" x ")}, expected 90 x 90 x 180`);
  }

  const expectedBytes = 12 + SAMPLE_COUNT * 3 * Float64Array.BYTES_PER_ELEMENT;
  if (fileBuffer.byteLength !== expectedBytes) {
    throw new Error(`${sourcePath} is ${fileBuffer.byteLength} bytes, expected ${expectedBytes}`);
  }

  const raw = fileBuffer.subarray(12);
  const aligned = new ArrayBuffer(raw.byteLength);
  new Uint8Array(aligned).set(raw);
  const brdf = new Float64Array(aligned);

  const max = [0, 0, 0];
  const sum = [0, 0, 0];

  for (let channel = 0; channel < 3; channel += 1) {
    const offset = channel * SAMPLE_COUNT;
    const scale = COLOR_SCALES[channel];
    let channelMax = 0;
    let channelSum = 0;

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const value = Math.max(0, brdf[offset + i] * scale);
      channelMax = Math.max(channelMax, value);
      channelSum += value;
    }

    max[channel] = channelMax;
    sum[channel] = channelSum;
  }

  const denom = max.map((value) => Math.log1p(Math.max(value, 1e-12)));
  const encoded = new Uint16Array(SAMPLE_COUNT * 3);

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = Math.max(0, brdf[channel * SAMPLE_COUNT + i] * COLOR_SCALES[channel]);
      const normalized = Math.log1p(value) / denom[channel];
      const clamped = Math.max(0, Math.min(1, normalized));
      encoded[i * 3 + channel] = floatToHalf(clamped);
    }
  }

  const bytes = Buffer.from(encoded.buffer);
  await writeFile(targetPath, bytes);

  return {
    max: max.map((value) => Number(value.toPrecision(8))),
    mean: sum.map((value) => Number((value / SAMPLE_COUNT).toPrecision(8))),
    bytes: bytes.byteLength
  };
}

function floatToHalf(value) {
  floatScratch[0] = value;
  const bits = intScratch[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;

  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }

  if (exponent >= 31) {
    return sign | 0x7c00;
  }

  mantissa += 0x1000;
  if (mantissa & 0x800000) {
    mantissa = 0;
    exponent += 1;
  }

  if (exponent >= 31) {
    return sign | 0x7c00;
  }

  return sign | (exponent << 10) | (mantissa >>> 13);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }

  return parsed;
}

function stripExt(file) {
  return file.replace(/\.binary$/i, "");
}

function labelFromName(name) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
