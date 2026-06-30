#version 300 es
precision highp float;

uniform sampler2D uColorTexture;
uniform float uExposure;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec3 color = texture(uColorTexture, vUv).rgb;
  color = vec3(1.0) - exp(-max(color, vec3(0.0)) * uExposure);
  color = pow(color, vec3(1.0 / 2.2));
  outColor = vec4(color, 1.0);
}
