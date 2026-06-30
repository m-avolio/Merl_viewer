#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(process.cwd(), args.src ?? "envmap.exr");
const outputDir = path.resolve(process.cwd(), args.outDir ?? "public/env");
const width = Number(args.width ?? 512);
const height = Number(args.height ?? 256);
const output = path.join(outputDir, args.out ?? "envmap.env16");
const manifest = path.join(outputDir, "manifest.json");
const floatScratch = new Float32Array(1);
const intScratch = new Uint32Array(floatScratch.buffer);

try {
  await access(source, constants.R_OK);
} catch {
  process.stdout.write("No envmap.exr found; using procedural browser fallback.\n");
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });

try {
  const raw = await runBuffer("magick", [
    source,
    "-resize",
    `${width}x${height}!`,
    "-auto-level",
    "-evaluate",
    "Pow",
    "0.35",
    "-colorspace",
    "sRGB",
    "-depth",
    "16",
    "rgb:-"
  ]);

  const expectedBytes = width * height * 3 * 2;
  if (raw.byteLength !== expectedBytes) {
    throw new Error(`ImageMagick returned ${raw.byteLength} bytes, expected ${expectedBytes}`);
  }

  const half = new Uint16Array(width * height * 3);
  for (let i = 0; i < half.length; i += 1) {
    half[i] = floatToHalf(raw.readUInt16BE(i * 2) / 65535);
  }

  await writeFile(output, Buffer.from(half.buffer));

  const envManifest = {
    version: 1,
    source: path.relative(process.cwd(), source),
    url: path.posix.join(args.outDir ?? "public/env", path.basename(output)),
    dimensions: [width, height],
    encoding: "rgb16f-tonemapped-srgb",
    toneMap: "auto-level + pow(0.35)"
  };

  await writeFile(manifest, `${JSON.stringify(envManifest, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), output)}\n`);
} catch (error) {
  process.stdout.write(`Could not preprocess ${path.basename(source)}: ${error.message}\n`);
  process.stdout.write("Install ImageMagick or use the in-app env upload control.\n");
}

function runBuffer(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
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
