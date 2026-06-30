#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;

uniform mat4 uProjection;
uniform mat4 uView;

out vec3 vWorldPosition;
out vec3 vWorldNormal;

void main() {
  vWorldPosition = aPosition;
  vWorldNormal = normalize(aNormal);
  gl_Position = uProjection * uView * vec4(aPosition, 1.0);
}
