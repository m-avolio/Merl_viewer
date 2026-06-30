import { BRDF_DIMS, MAX_ENV_SAMPLES } from "./config.js";
import { uploadDefaultEnvTexture } from "./default-env.js";
import { uploadDefaultEnvironment, uploadEnvFile } from "./environment.js";
import {
  assertNoGlError,
  collectUniforms,
  createProgram,
  fetchText,
  setTexture2DParameters,
  setTexture3DParameters
} from "./gl-utils.js";
import { loadMaterialManifest, pickDefaultMaterial, uploadMaterial } from "./materials.js";
import {
  clamp,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  radians,
  transformPoint
} from "./math.js";
import { createSphere } from "./mesh.js";

const SPHERE_UNIFORMS = [
  "uProjection",
  "uView",
  "uCameraPosition",
  "uPointLightPosition",
  "uPointLightColor",
  "uPointIntensity",
  "uEnvIntensity",
  "uLightMode",
  "uEnvSampleCount",
  "uBrdfMax",
  "uBrdfTexture",
  "uEnvTexture",
  "uEnvConditionalCdf",
  "uEnvMarginalCdf",
  "uEnvMapSize",
  "uEnvTotalWeight",
  "uFrameIndex",
  "uRenderMode"
];

const ACCUMULATE_UNIFORMS = ["uPreviousTexture", "uBatchTexture", "uFrameCount"];
const DISPLAY_UNIFORMS = ["uColorTexture", "uExposure"];

export async function startViewer() {
  const dom = getDom();
  const gl = createGlContext(dom.canvas);
  const capabilities = {
    floatLinear: Boolean(gl.getExtension("OES_texture_float_linear") ?? gl.getExtension("OES_texture_half_float_linear"))
  };

  const state = createInitialState(dom);
  const renderer = await createRenderer(gl);
  const textures = createTextures(gl, state, capabilities);
  const context = { dom, gl, state, renderer, textures, capabilities };

  wireControls(context);
  resize(dom.canvas);
  window.addEventListener("resize", () => resetAccumulation(state));

  requestAnimationFrame(() => render(context));
  void loadDefaultEnv(context);
  void loadMaterials(context);
}

function getDom() {
  return {
    canvas: document.querySelector("#glCanvas"),
    status: document.querySelector("#status"),
    statusDot: document.querySelector("#statusDot"),
    materialSelect: document.querySelector("#materialSelect"),
    envModeButton: document.querySelector("#envMode"),
    pointModeButton: document.querySelector("#pointMode"),
    envControls: document.querySelector("#envControls"),
    pointControls: document.querySelector("#pointControls"),
    lightMarker: document.querySelector("#lightMarker"),
    envSource: document.querySelector("#envSource"),
    controls: {
      exposure: document.querySelector("#exposure"),
      envIntensity: document.querySelector("#envIntensity"),
      envQuality: document.querySelector("#envQuality"),
      renderMode: document.querySelector("#renderMode"),
      envUpload: document.querySelector("#envUpload"),
      lightAzimuth: document.querySelector("#lightAzimuth"),
      lightElevation: document.querySelector("#lightElevation"),
      lightDistance: document.querySelector("#lightDistance"),
      pointIntensity: document.querySelector("#pointIntensity")
    }
  };
}

function createGlContext(canvas) {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    powerPreference: "high-performance"
  });

  if (!gl) {
    throw new Error("WebGL2 is required for 3D BRDF textures.");
  }

  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("EXT_color_buffer_float is required for progressive env-map accumulation.");
  }

  if (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) < Math.max(...BRDF_DIMS)) {
    throw new Error("This GPU does not support the required 3D texture size.");
  }

  return gl;
}

function createInitialState(dom) {
  const { controls } = dom;
  return {
    manifest: null,
    material: null,
    envImportance: null,
    mode: "env",
    renderMode: controls.renderMode.value,
    exposure: Number(controls.exposure.value),
    envIntensity: Number(controls.envIntensity.value),
    envSampleCount: Number(controls.envQuality.value),
    pointIntensity: Number(controls.pointIntensity.value),
    lightAzimuth: radians(Number(controls.lightAzimuth.value)),
    lightElevation: radians(Number(controls.lightElevation.value)),
    lightDistance: Number(controls.lightDistance.value),
    cameraYaw: radians(26),
    cameraPitch: radians(7),
    cameraDistance: 3.9,
    accumulationFrames: 0,
    accumulationIndex: 0,
    targets: null,
    dragging: false,
    lastPointer: [0, 0]
  };
}

async function createRenderer(gl) {
  const [sphereVertex, sphereFragmentTemplate, fullscreenVertex, accumulateFragment, displayFragment] = await Promise.all([
    fetchText("./src/shaders/sphere.vert.glsl"),
    fetchText("./src/shaders/sphere.frag.glsl"),
    fetchText("./src/shaders/fullscreen.vert.glsl"),
    fetchText("./src/shaders/accumulate.frag.glsl"),
    fetchText("./src/shaders/display.frag.glsl")
  ]);
  const sphereFragment = sphereFragmentTemplate.replace("{{MAX_ENV_SAMPLES}}", String(MAX_ENV_SAMPLES));
  const sphereProgram = createProgram(gl, sphereVertex, sphereFragment);
  const accumulateProgram = createProgram(gl, fullscreenVertex, accumulateFragment);
  const displayProgram = createProgram(gl, fullscreenVertex, displayFragment);

  return {
    sphere: createSphere(gl, 1, 160, 80),
    fullscreenVao: gl.createVertexArray(),
    sphereProgram,
    sphereUniforms: collectUniforms(gl, sphereProgram, SPHERE_UNIFORMS),
    accumulateProgram,
    accumulateUniforms: collectUniforms(gl, accumulateProgram, ACCUMULATE_UNIFORMS),
    displayProgram,
    displayUniforms: collectUniforms(gl, displayProgram, DISPLAY_UNIFORMS)
  };
}

function createTextures(gl, state, capabilities) {
  const brdf = gl.createTexture();
  const env = gl.createTexture();
  const envConditionalCdf = gl.createTexture();
  const envMarginalCdf = gl.createTexture();
  const emptyBrdf = new Uint8Array(BRDF_DIMS[0] * BRDF_DIMS[1] * BRDF_DIMS[2] * 3);

  gl.bindTexture(gl.TEXTURE_3D, brdf);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGB8,
    BRDF_DIMS[0],
    BRDF_DIMS[1],
    BRDF_DIMS[2],
    0,
    gl.RGB,
    gl.UNSIGNED_BYTE,
    emptyBrdf
  );
  setTexture3DParameters(gl);

  const fallback = uploadDefaultEnvTexture(gl, env);
  state.envImportance = fallback.importance;
  setTexture2DParameters(gl, { linear: fallback.linear });
  uploadImportanceTextures(gl, { envConditionalCdf, envMarginalCdf }, fallback.importance);

  return { brdf, env, envConditionalCdf, envMarginalCdf, capabilities };
}

function uploadImportanceTextures(gl, textures, importance) {
  gl.bindTexture(gl.TEXTURE_2D, textures.envConditionalCdf);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    importance.width,
    importance.height,
    0,
    gl.RED,
    gl.FLOAT,
    importance.conditionalCdf
  );
  setCdfTextureParameters(gl);

  gl.bindTexture(gl.TEXTURE_2D, textures.envMarginalCdf);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    1,
    importance.height,
    0,
    gl.RED,
    gl.FLOAT,
    importance.marginalCdf
  );
  setCdfTextureParameters(gl);
}

function setCdfTextureParameters(gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

async function loadMaterials(context) {
  const { dom, state } = context;

  try {
    const manifest = await loadMaterialManifest();
    state.manifest = manifest;
    dom.materialSelect.replaceChildren(...manifest.materials.map(materialOption));

    const defaultMaterial = pickDefaultMaterial(manifest.materials);
    dom.materialSelect.value = defaultMaterial.name;
    await setMaterial(context, defaultMaterial.name);
  } catch (error) {
    console.error(error);
    setStatus(dom, "Run npm run preprocess, then refresh the viewer.", "error", false);
  }
}

async function setMaterial(context, name) {
  const { dom, gl, state, textures, capabilities } = context;
  const material = state.manifest?.materials.find((entry) => entry.name === name);
  if (!material) return;

  setStatus(dom, `Streaming ${material.label}`, "loading", false);
  dom.materialSelect.disabled = true;

  try {
    const upload = await uploadMaterial(gl, textures.brdf, material, capabilities.floatLinear);
    setTexture3DParameters(gl, { linear: upload.linear });
    assertNoGlError(gl, `uploading ${material.label}`);

    state.material = material;
    resetAccumulation(state);
    setStatus(dom, `${material.label} ready`, "ready", true);
  } catch (error) {
    console.error(error);
    setStatus(dom, `Could not load ${material.label}`, "error", false);
  } finally {
    dom.materialSelect.disabled = false;
  }
}

async function loadDefaultEnv(context) {
  const { dom, gl, state, textures, capabilities } = context;

  try {
    const result = await uploadDefaultEnvironment(gl, textures.env, capabilities.floatLinear);
    if (!result) {
      dom.envSource.textContent = "Procedural fallback";
      return;
    }

    state.envImportance = result.importance;
    setTexture2DParameters(gl, { linear: result.linear });
    uploadImportanceTextures(gl, textures, result.importance);
    dom.envSource.textContent = result.label;
    resetAccumulation(state);
    assertNoGlError(gl, "uploading env map");
  } catch (error) {
    dom.envSource.textContent = "Procedural fallback";
    console.info("Using procedural environment fallback.", error);
  }
}

function wireControls(context) {
  const { dom, state } = context;
  const { controls } = dom;

  dom.materialSelect.addEventListener("change", () => setMaterial(context, dom.materialSelect.value));

  for (const button of [dom.envModeButton, dom.pointModeButton]) {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      dom.envModeButton.classList.toggle("is-active", state.mode === "env");
      dom.pointModeButton.classList.toggle("is-active", state.mode === "point");
      dom.envControls.classList.toggle("is-hidden", state.mode !== "env");
      dom.pointControls.classList.toggle("is-hidden", state.mode !== "point");
      dom.lightMarker.style.display = state.mode === "point" ? "block" : "none";
      resetAccumulation(state);
    });
  }

  controls.exposure.addEventListener("input", () => {
    state.exposure = Number(controls.exposure.value);
  });
  controls.envIntensity.addEventListener("input", () => {
    state.envIntensity = Number(controls.envIntensity.value);
    resetAccumulation(state);
  });
  controls.envQuality.addEventListener("change", () => {
    state.envSampleCount = Number(controls.envQuality.value);
    resetAccumulation(state);
  });
  controls.renderMode.addEventListener("change", () => {
    state.renderMode = controls.renderMode.value;
    resetAccumulation(state);
  });
  controls.pointIntensity.addEventListener("input", () => {
    state.pointIntensity = Number(controls.pointIntensity.value);
  });
  controls.lightAzimuth.addEventListener("input", () => {
    state.lightAzimuth = radians(Number(controls.lightAzimuth.value));
  });
  controls.lightElevation.addEventListener("input", () => {
    state.lightElevation = radians(Number(controls.lightElevation.value));
  });
  controls.lightDistance.addEventListener("input", () => {
    state.lightDistance = Number(controls.lightDistance.value);
  });
  controls.envUpload.addEventListener("change", () => loadUploadedEnv(context));

  wireCameraControls(dom.canvas, state);
}

function wireCameraControls(canvas, state) {
  canvas.addEventListener("pointerdown", (event) => {
    state.dragging = true;
    state.lastPointer = [event.clientX, event.clientY];
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const dx = event.clientX - state.lastPointer[0];
    const dy = event.clientY - state.lastPointer[1];
    state.lastPointer = [event.clientX, event.clientY];
    state.cameraYaw += dx * 0.006;
    state.cameraPitch = clamp(state.cameraPitch + dy * 0.005, radians(-72), radians(72));
    resetAccumulation(state);
  });

  canvas.addEventListener("pointerup", (event) => {
    state.dragging = false;
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      state.cameraDistance = clamp(state.cameraDistance + event.deltaY * 0.002, 2.1, 5.4);
      resetAccumulation(state);
    },
    { passive: false }
  );
}

async function loadUploadedEnv(context) {
  const { dom, gl, state, textures } = context;
  const file = dom.controls.envUpload.files?.[0];
  if (!file) return;

  try {
    const result = await uploadEnvFile(gl, textures.env, file);
    state.envImportance = result.importance;
    setTexture2DParameters(gl, { linear: result.linear });
    uploadImportanceTextures(gl, textures, result.importance);
    dom.envSource.textContent = result.label;
    resetAccumulation(state);
    setStatus(dom, `${file.name} env loaded`, "ready", true);
  } catch (error) {
    console.error(error);
    setStatus(dom, "Could not load env image.", "error", false);
  }
}

function render(context) {
  const { dom, gl, state } = context;
  const resized = resize(dom.canvas);
  ensureRenderTargets(gl, state, dom.canvas.width, dom.canvas.height);

  if (resized) {
    resetAccumulation(state);
  }

  renderSphereBatch(context);

  if (state.mode === "env" && state.renderMode === "brdf") {
    accumulateBatch(context);
    displayTexture(context, state.targets.accumulation[state.accumulationIndex].texture);
  } else {
    displayTexture(context, state.targets.batch.texture);
  }

  updateLightMarker(context);
  requestAnimationFrame(() => render(context));
}

function renderSphereBatch(context) {
  const { dom, gl, state, renderer, textures } = context;
  const aspect = dom.canvas.width / dom.canvas.height;
  const projection = mat4Perspective(radians(42), aspect, 0.05, 50);
  const cameraPosition = getCameraPosition(state);
  const view = mat4LookAt(cameraPosition, [0, 0, 0], [0, 1, 0]);
  const pointLightPosition = getPointLightPosition(state);
  const { sphereUniforms: uniforms } = renderer;

  gl.bindFramebuffer(gl.FRAMEBUFFER, state.targets.batch.framebuffer);
  gl.viewport(0, 0, state.targets.width, state.targets.height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  gl.useProgram(renderer.sphereProgram);
  gl.bindVertexArray(renderer.sphere.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_3D, textures.brdf);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures.env);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, textures.envConditionalCdf);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, textures.envMarginalCdf);

  gl.uniformMatrix4fv(uniforms.uProjection, false, projection);
  gl.uniformMatrix4fv(uniforms.uView, false, view);
  gl.uniform3fv(uniforms.uCameraPosition, cameraPosition);
  gl.uniform3fv(uniforms.uPointLightPosition, pointLightPosition);
  gl.uniform3f(uniforms.uPointLightColor, 1, 0.82, 0.52);
  gl.uniform1f(uniforms.uPointIntensity, state.pointIntensity);
  gl.uniform1f(uniforms.uEnvIntensity, state.envIntensity);
  gl.uniform1i(uniforms.uLightMode, state.mode === "env" ? 0 : 1);
  gl.uniform1i(uniforms.uEnvSampleCount, state.envSampleCount);
  gl.uniform3fv(uniforms.uBrdfMax, state.material?.max ?? [1, 1, 1]);
  gl.uniform1i(uniforms.uBrdfTexture, 0);
  gl.uniform1i(uniforms.uEnvTexture, 1);
  gl.uniform1i(uniforms.uEnvConditionalCdf, 2);
  gl.uniform1i(uniforms.uEnvMarginalCdf, 3);
  gl.uniform2f(uniforms.uEnvMapSize, state.envImportance?.width ?? 1, state.envImportance?.height ?? 1);
  gl.uniform1f(uniforms.uEnvTotalWeight, state.envImportance?.totalWeight ?? 1);
  gl.uniform1f(uniforms.uFrameIndex, state.accumulationFrames);
  gl.uniform1i(uniforms.uRenderMode, state.renderMode === "mirror" ? 1 : 0);

  gl.drawElements(gl.TRIANGLES, renderer.sphere.indexCount, gl.UNSIGNED_INT, 0);

  state.lastProjection = projection;
  state.lastView = view;
  state.lastPointLightPosition = pointLightPosition;
}

function accumulateBatch({ gl, state, renderer }) {
  const previous = state.targets.accumulation[state.accumulationIndex];
  const nextIndex = 1 - state.accumulationIndex;
  const next = state.targets.accumulation[nextIndex];
  const { accumulateUniforms: uniforms } = renderer;

  gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
  gl.viewport(0, 0, state.targets.width, state.targets.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(renderer.accumulateProgram);
  gl.bindVertexArray(renderer.fullscreenVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, previous.texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, state.targets.batch.texture);
  gl.uniform1i(uniforms.uPreviousTexture, 0);
  gl.uniform1i(uniforms.uBatchTexture, 1);
  gl.uniform1f(uniforms.uFrameCount, state.accumulationFrames);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  state.accumulationIndex = nextIndex;
  state.accumulationFrames += 1;
}

function displayTexture({ dom, gl, state, renderer }, texture) {
  const { displayUniforms: uniforms } = renderer;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, dom.canvas.width, dom.canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(renderer.displayProgram);
  gl.bindVertexArray(renderer.fullscreenVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(uniforms.uColorTexture, 0);
  gl.uniform1f(uniforms.uExposure, state.exposure);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function ensureRenderTargets(gl, state, width, height) {
  if (state.targets?.width === width && state.targets?.height === height) return;

  disposeRenderTargets(gl, state.targets);
  state.targets = {
    width,
    height,
    batch: createColorTarget(gl, width, height),
    accumulation: [createColorTarget(gl, width, height, { precision: "float" }), createColorTarget(gl, width, height, { precision: "float" })]
  };
  resetAccumulation(state);
}

function createColorTarget(gl, width, height, { precision = "half" } = {}) {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  const useFloat = precision === "float";

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    useFloat ? gl.RGBA32F : gl.RGBA16F,
    width,
    height,
    0,
    gl.RGBA,
    useFloat ? gl.FLOAT : gl.HALF_FLOAT,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Could not create progressive render target.");
  }

  return { texture, framebuffer };
}

function disposeRenderTargets(gl, targets) {
  if (!targets) return;
  const allTargets = [targets.batch, ...targets.accumulation];

  for (const target of allTargets) {
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }
}

function resize(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const changed = canvas.width !== width || canvas.height !== height;

  if (changed) {
    canvas.width = width;
    canvas.height = height;
  }

  return changed;
}

function resetAccumulation(state) {
  state.accumulationFrames = 0;
  state.accumulationIndex = 0;
}

function updateLightMarker({ dom, state }) {
  if (state.mode !== "point") {
    dom.lightMarker.style.display = "none";
    return;
  }

  const clip = transformPoint(mat4Multiply(state.lastProjection, state.lastView), state.lastPointLightPosition);
  if (clip[3] <= 0) {
    dom.lightMarker.style.display = "none";
    return;
  }

  const ndc = [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3]];
  if (Math.abs(ndc[0]) > 1.2 || Math.abs(ndc[1]) > 1.2 || ndc[2] < -1 || ndc[2] > 1) {
    dom.lightMarker.style.display = "none";
    return;
  }

  dom.lightMarker.style.display = "block";
  dom.lightMarker.style.left = `${(ndc[0] * 0.5 + 0.5) * window.innerWidth}px`;
  dom.lightMarker.style.top = `${(-ndc[1] * 0.5 + 0.5) * window.innerHeight}px`;
}

function getCameraPosition(state) {
  const cp = Math.cos(state.cameraPitch);
  return new Float32Array([
    Math.sin(state.cameraYaw) * cp * state.cameraDistance,
    Math.sin(state.cameraPitch) * state.cameraDistance,
    Math.cos(state.cameraYaw) * cp * state.cameraDistance
  ]);
}

function getPointLightPosition(state) {
  const cp = Math.cos(state.lightElevation);
  return new Float32Array([
    Math.sin(state.lightAzimuth) * cp * state.lightDistance,
    Math.sin(state.lightElevation) * state.lightDistance,
    Math.cos(state.lightAzimuth) * cp * state.lightDistance
  ]);
}

function setStatus(dom, message, type = "loading", autoHide = false) {
  dom.status.textContent = message;
  dom.status.classList.remove("is-hidden");
  dom.statusDot.classList.toggle("is-ready", type === "ready");
  dom.statusDot.classList.toggle("is-error", type === "error");

  if (autoHide) {
    window.clearTimeout(setStatus.timeout);
    setStatus.timeout = window.setTimeout(() => dom.status.classList.add("is-hidden"), 1600);
  }
}

function materialOption(material) {
  const option = document.createElement("option");
  option.value = material.name;
  option.textContent = material.label;
  return option;
}
