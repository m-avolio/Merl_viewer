#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

const float PI = 3.141592653589793;
const int MAX_ENV_SAMPLES = {{MAX_ENV_SAMPLES}};
const int CDF_SEARCH_STEPS = 12;
const float IMPORTANCE_LUMINANCE_FLOOR = 1e-6;
const float ENV_SAMPLE_WEIGHT = 0.4;
const float COSINE_SAMPLE_WEIGHT = 0.35;
const float SPECULAR_SAMPLE_WEIGHT = 0.25;
const float SPECULAR_SAMPLE_EXPONENT = 96.0;
const uint CMJ_GRID_SIZE = 64u;
const uint CMJ_GRID_MASK = 63u;
const uint CMJ_SAMPLE_COUNT = 4096u;
const float CMJ_GRID_SIZE_FLOAT = 64.0;

uniform sampler3D uBrdfTexture;
uniform sampler2D uEnvTexture;
uniform sampler2D uEnvConditionalCdf;
uniform sampler2D uEnvMarginalCdf;
uniform vec3 uBrdfMax;
uniform vec3 uCameraPosition;
uniform vec3 uPointLightPosition;
uniform vec3 uPointLightColor;
uniform vec2 uEnvMapSize;
uniform float uPointIntensity;
uniform float uEnvIntensity;
uniform float uEnvTotalWeight;
uniform float uFrameIndex;
uniform int uLightMode;
uniform int uEnvSampleCount;
uniform int uRenderMode;

in vec3 vWorldPosition;
in vec3 vWorldNormal;
out vec4 outColor;

vec3 rotateZ(vec3 value, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return vec3(c * value.x - s * value.y, s * value.x + c * value.y, value.z);
}

vec3 rotateY(vec3 value, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return vec3(c * value.x + s * value.z, value.y, -s * value.x + c * value.z);
}

vec3 toLocal(vec3 worldDirection, vec3 normal) {
  vec3 helper = abs(normal.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  return vec3(dot(worldDirection, tangent), dot(worldDirection, bitangent), dot(worldDirection, normal));
}

vec3 fromLocal(vec3 localDirection, vec3 normal) {
  vec3 helper = abs(normal.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, normal));
  vec3 bitangent = cross(normal, tangent);
  return normalize(localDirection.x * tangent + localDirection.y * bitangent + localDirection.z * normal);
}

vec3 fromAxisLocal(vec3 localDirection, vec3 axis) {
  vec3 helper = abs(axis.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tangent = normalize(cross(helper, axis));
  vec3 bitangent = cross(axis, tangent);
  return normalize(localDirection.x * tangent + localDirection.y * bitangent + localDirection.z * axis);
}

vec3 decodeBrdf(vec3 encoded) {
  return exp(encoded * log(vec3(1.0) + max(uBrdfMax, vec3(1e-12)))) - vec3(1.0);
}

vec3 sampleMerl(vec3 incomingWorld, vec3 outgoingWorld, vec3 normalWorld) {
  vec3 wi = normalize(toLocal(incomingWorld, normalWorld));
  vec3 wo = normalize(toLocal(outgoingWorld, normalWorld));

  if (wi.z <= 0.0 || wo.z <= 0.0) {
    return vec3(0.0);
  }

  vec3 halfVector = normalize(wi + wo);
  if (halfVector.z <= 0.0) {
    return vec3(0.0);
  }

  float thetaHalf = acos(clamp(halfVector.z, 0.0, 1.0));
  float phiHalf = atan(halfVector.y, halfVector.x);
  vec3 diff = rotateY(rotateZ(wi, -phiHalf), -thetaHalf);
  float thetaDiff = acos(clamp(diff.z, 0.0, 1.0));
  float phiDiff = atan(diff.y, diff.x);

  if (phiDiff < 0.0) {
    phiDiff += 2.0 * PI;
  }
  if (phiDiff >= PI) {
    phiDiff -= PI;
  }

  float thetaHalfIndex = clamp(sqrt(thetaHalf / (0.5 * PI)) * 90.0, 0.0, 89.0);
  float thetaDiffIndex = clamp(thetaDiff / (0.5 * PI) * 90.0, 0.0, 89.0);
  float phiDiffIndex = clamp(phiDiff / PI * 180.0, 0.0, 179.0);
  vec3 uvw = vec3(
    (phiDiffIndex + 0.5) / 180.0,
    (thetaDiffIndex + 0.5) / 90.0,
    (thetaHalfIndex + 0.5) / 90.0
  );

  return decodeBrdf(texture(uBrdfTexture, uvw).rgb);
}

vec3 pointLight(vec3 normal, vec3 outgoing) {
  vec3 toLight = uPointLightPosition - vWorldPosition;
  float distanceSquared = max(dot(toLight, toLight), 0.02);
  vec3 incoming = normalize(toLight);
  float ndotl = max(dot(normal, incoming), 0.0);
  vec3 brdf = sampleMerl(incoming, outgoing, normal);
  vec3 radiance = uPointLightColor * uPointIntensity / distanceSquared;
  return brdf * radiance * ndotl;
}

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

uint hashUint(uint value) {
  value ^= value >> 16;
  value *= 0x7feb352du;
  value ^= value >> 15;
  value *= 0x846ca68bu;
  value ^= value >> 16;
  return value;
}

float randomFloat(uint value) {
  return float(hashUint(value)) * (1.0 / 4294967296.0);
}

uint pixelSeed(uint stream, uint cycle) {
  uint x = uint(gl_FragCoord.x);
  uint y = uint(gl_FragCoord.y);
  return hashUint(x * 0x9e3779b9u ^ y * 0x85ebca6bu ^ stream * 0xc2b2ae35u ^ cycle * 0x27d4eb2fu);
}

uint permuteCmj(uint value, uint seed) {
  uint multiplier = (seed & (CMJ_GRID_MASK - 1u)) | 1u;
  uint offset = (seed >> 8) & CMJ_GRID_MASK;
  return (value * multiplier + offset) & CMJ_GRID_MASK;
}

uint globalSampleIndex(int sampleIndex) {
  return uint(max(uFrameIndex, 0.0)) * uint(max(uEnvSampleCount, 1)) + uint(sampleIndex);
}

vec2 cmj2(int sampleIndex, uint stream) {
  uint globalIndex = globalSampleIndex(sampleIndex);
  uint cycle = globalIndex / CMJ_SAMPLE_COUNT;
  uint sampleInTile = globalIndex - cycle * CMJ_SAMPLE_COUNT;
  uint seed = pixelSeed(stream, cycle);
  uint sx = permuteCmj(sampleInTile & CMJ_GRID_MASK, seed * 0xa511e9b3u);
  uint sy = permuteCmj(sampleInTile / CMJ_GRID_SIZE, seed * 0x63d83595u);
  float jx = randomFloat(sampleInTile ^ seed * 0xa399d265u);
  float jy = randomFloat(sampleInTile ^ seed * 0x711ad6a5u);

  return vec2(
    (float(sx) + (float(sy) + jx) / CMJ_GRID_SIZE_FLOAT) / CMJ_GRID_SIZE_FLOAT,
    (float(sy) + (float(sx) + jy) / CMJ_GRID_SIZE_FLOAT) / CMJ_GRID_SIZE_FLOAT
  );
}

float cmj1(int sampleIndex, uint stream) {
  return cmj2(sampleIndex, stream).x;
}

int sampleCdfRow(float target) {
  int lo = 0;
  int hi = max(int(uEnvMapSize.y + 0.5) - 1, 0);

  for (int i = 0; i < CDF_SEARCH_STEPS; i += 1) {
    if (lo >= hi) {
      break;
    }

    int mid = (lo + hi) / 2;
    float value = texelFetch(uEnvMarginalCdf, ivec2(0, mid), 0).r;
    if (value < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

int sampleCdfColumn(int row, float target) {
  int lo = 0;
  int hi = max(int(uEnvMapSize.x + 0.5) - 1, 0);

  for (int i = 0; i < CDF_SEARCH_STEPS; i += 1) {
    if (lo >= hi) {
      break;
    }

    int mid = (lo + hi) / 2;
    float value = texelFetch(uEnvConditionalCdf, ivec2(mid, row), 0).r;
    if (value < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

vec3 envDirectionFromUv(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float theta = uv.y * PI;
  float sinTheta = sin(theta);
  return vec3(cos(phi) * sinTheta, cos(theta), sin(phi) * sinTheta);
}

vec2 envUvFromDirection(vec3 direction) {
  vec3 unitDirection = normalize(direction);
  float u = atan(unitDirection.z, unitDirection.x) / (2.0 * PI) + 0.5;
  float v = acos(clamp(unitDirection.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

vec3 mirrorEnvironment(vec3 normal, vec3 outgoing) {
  vec3 reflectedView = reflect(-outgoing, normal);
  return texture(uEnvTexture, envUvFromDirection(reflectedView)).rgb * uEnvIntensity;
}

float envPdf(vec3 envColor) {
  return max(luminance(envColor), IMPORTANCE_LUMINANCE_FLOOR) / max(uEnvTotalWeight, IMPORTANCE_LUMINANCE_FLOOR);
}

vec3 envColorForDirection(vec3 direction) {
  return texture(uEnvTexture, envUvFromDirection(direction)).rgb;
}

vec3 sampleEnvMap(int sampleIndex, out vec3 incoming) {
  vec2 xi = clamp(cmj2(sampleIndex, 0u), vec2(1e-6), vec2(0.999999));
  int row = sampleCdfRow(xi.x);
  int column = sampleCdfColumn(row, xi.y);
  vec2 jitter = cmj2(sampleIndex, 43u);
  vec2 uv = (vec2(float(column), float(row)) + jitter) / uEnvMapSize;
  vec3 envColor = texelFetch(uEnvTexture, ivec2(column, row), 0).rgb;

  incoming = normalize(envDirectionFromUv(uv));
  return envColor;
}

vec3 sampleCosineHemisphere(int sampleIndex, vec3 normal, out vec3 incoming) {
  vec2 xi = clamp(cmj2(sampleIndex, 83u), vec2(1e-6), vec2(0.999999));
  float radius = sqrt(xi.x);
  float phi = 2.0 * PI * xi.y;
  float z = sqrt(max(1.0 - xi.x, 0.0));
  vec3 local = vec3(radius * cos(phi), radius * sin(phi), z);

  incoming = fromLocal(local, normal);
  return envColorForDirection(incoming);
}

float specularPdf(vec3 incoming, vec3 reflectionDirection) {
  float cosAngle = max(dot(incoming, reflectionDirection), 0.0);
  return ((SPECULAR_SAMPLE_EXPONENT + 1.0) / (2.0 * PI)) * pow(cosAngle, SPECULAR_SAMPLE_EXPONENT);
}

vec3 sampleSpecularLobe(int sampleIndex, vec3 reflectionDirection, out vec3 incoming) {
  vec2 xi = clamp(cmj2(sampleIndex, 151u), vec2(1e-6), vec2(0.999999));
  float cosTheta = pow(1.0 - xi.x, 1.0 / (SPECULAR_SAMPLE_EXPONENT + 1.0));
  float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
  float phi = 2.0 * PI * xi.y;
  vec3 local = vec3(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);

  incoming = fromAxisLocal(local, reflectionDirection);
  return envColorForDirection(incoming);
}

vec3 envLight(vec3 normal, vec3 outgoing) {
  vec3 color = vec3(0.0);
  int sampleCount = max(uEnvSampleCount, 1);
  vec3 reflectionDirection = reflect(-outgoing, normal);

  for (int i = 0; i < MAX_ENV_SAMPLES; i += 1) {
    if (i >= sampleCount) {
      break;
    }

    vec3 incoming;
    vec3 envColor;
    float technique = cmj1(i, 137u);

    if (technique < ENV_SAMPLE_WEIGHT) {
      envColor = sampleEnvMap(i, incoming);
    } else if (technique < ENV_SAMPLE_WEIGHT + COSINE_SAMPLE_WEIGHT) {
      envColor = sampleCosineHemisphere(i, normal, incoming);
    } else {
      envColor = sampleSpecularLobe(i, reflectionDirection, incoming);
    }

    float ndotl = max(dot(normal, incoming), 0.0);
    if (ndotl > 0.0) {
      float pdfEnv = envPdf(envColor);
      float pdfCosine = ndotl / PI;
      float pdfSpecular = specularPdf(incoming, reflectionDirection);
      float mixturePdf = max(
        ENV_SAMPLE_WEIGHT * pdfEnv + COSINE_SAMPLE_WEIGHT * pdfCosine + SPECULAR_SAMPLE_WEIGHT * pdfSpecular,
        IMPORTANCE_LUMINANCE_FLOOR
      );
      vec3 brdf = sampleMerl(incoming, outgoing, normal);
      color += brdf * envColor * ndotl / mixturePdf;
    }
  }

  return color * (uEnvIntensity / float(sampleCount));
}

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 outgoing = normalize(uCameraPosition - vWorldPosition);
  vec3 color;

  if (uRenderMode == 1 && uLightMode == 0) {
    color = mirrorEnvironment(normal, outgoing);
  } else if (uLightMode == 0) {
    color = envLight(normal, outgoing);
  } else {
    color = pointLight(normal, outgoing);
  }

  if (uRenderMode != 1) {
    float rim = pow(1.0 - max(dot(normal, outgoing), 0.0), 3.0);
    color += vec3(0.003, 0.004, 0.004) * rim;
  }

  outColor = vec4(max(color, vec3(0.0)), 1.0);
}
