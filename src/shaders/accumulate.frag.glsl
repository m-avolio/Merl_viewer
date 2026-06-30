#version 300 es
precision highp float;

uniform sampler2D uPreviousTexture;
uniform sampler2D uBatchTexture;
uniform float uFrameCount;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec3 batch = texture(uBatchTexture, vUv).rgb;
  if (uFrameCount <= 0.0) {
    outColor = vec4(batch, 1.0);
    return;
  }

  vec3 previous = texture(uPreviousTexture, vUv).rgb;
  vec3 average = (previous * uFrameCount + batch) / (uFrameCount + 1.0);
  outColor = vec4(average, 1.0);
}
