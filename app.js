import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const canvas = document.querySelector('#canvas');
const stage = document.querySelector('#stage');
const video = document.querySelector('#video');
const fileInput = document.querySelector('#file-input');
const statusEl = document.querySelector('#status');
const frameCountEl = document.querySelector('#frame-count');
const sourceEl = document.querySelector('#source-name');

// Volume resolution. Depth is the time axis: one texel layer per sampled frame.
const MAX_SIDE = 192;
const MAX_DEPTH = 192;

const renderer = new THREE.WebGLRenderer({canvas, antialias: false, alpha: false, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

const uniforms = {
  uVolume: {value: null},
  uScale: {value: new THREE.Vector3(1, 1, 1)},
  uDensity: {value: 0.24},
  uRadius: {value: 0.16},
  uSoft: {value: 0.05},
  uSteps: {value: 160},
};

const material = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms,
  transparent: true,
  depthWrite: false,
  side: THREE.BackSide,
  vertexShader: `
    out vec3 vOrigin;
    out vec3 vDirection;
    void main() {
      vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
      vDirection = position - vOrigin;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    precision highp sampler3D;

    in vec3 vOrigin;
    in vec3 vDirection;

    uniform sampler3D uVolume;
    uniform vec3 uScale;
    uniform float uDensity;
    uniform float uRadius;
    uniform float uSoft;
    uniform float uSteps;

    layout(location = 0) out vec4 fragColor;

    // Geometry is a unit cube scaled by uScale, so object space is [-0.5, 0.5]^3.
    vec2 hitBox(vec3 origin, vec3 dir) {
      vec3 invDir = 1.0 / dir;
      vec3 a = (vec3(-0.5) - origin) * invDir;
      vec3 b = (vec3(0.5) - origin) * invDir;
      vec3 tmin = min(a, b);
      vec3 tmax = max(a, b);
      return vec2(max(tmin.x, max(tmin.y, tmin.z)), min(tmax.x, min(tmax.y, tmax.z)));
    }

    // Measured in world units so the rounding stays even on a non-cubic block.
    float roundBox(vec3 p) {
      vec3 q = abs(p * uScale) - uScale * 0.5 + uRadius;
      return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - uRadius;
    }

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec3 dir = normalize(vDirection);
      vec2 bounds = hitBox(vOrigin, dir);
      if (bounds.x > bounds.y) discard;
      bounds.x = max(bounds.x, 0.0);

      float dt = (bounds.y - bounds.x) / uSteps;
      // Jitter the entry point so the fixed step count does not band the block.
      vec3 p = vOrigin + (bounds.x + dt * hash(gl_FragCoord.xy)) * dir;
      vec3 stride = dir * dt;
      float sigma = uDensity * 26.0;

      vec4 acc = vec4(0.0);
      for (float i = 0.0; i < uSteps; i += 1.0) {
        float mask = 1.0 - smoothstep(-uSoft, 0.0, roundBox(p));
        if (mask > 0.002) {
          float alpha = 1.0 - exp(-sigma * mask * dt);
          vec3 color = texture(uVolume, p + 0.5).rgb;
          acc.rgb += (1.0 - acc.a) * alpha * color;
          acc.a += (1.0 - acc.a) * alpha;
          if (acc.a > 0.995) break;
        }
        p += stride;
      }
      fragColor = acc;
    }
  `,
});

const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
block.rotation.order = 'YXZ';
block.visible = false;
scene.add(block);

let volumeTexture = null;
let frameCount = 0;
let depth = 1.05;
let angleY = -0.45;
let angleX = 0.42;
let spin = 0.09;
let zoom = 1;
let dragging = false;
let lastPointer = {x: 0, y: 0};
let buildToken = 0;
let spinHeldUntil = 0;
let objectUrl = null;

function setScale() {
  const ratio = (video.videoWidth || 16) / (video.videoHeight || 9);
  const w = ratio >= 1 ? 2.4 : 2.4 * ratio;
  const h = ratio >= 1 ? 2.4 / ratio : 2.4;
  block.scale.set(w, h, depth);
  uniforms.uScale.value.set(w, h, depth);
  uniforms.uRadius.value = Math.min(w, h, depth) * 0.22;
  uniforms.uSoft.value = Math.min(w, h, depth) * 0.07;
}

function waitForSeek(time) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

async function buildVolume() {
  if (!video.duration || !video.videoWidth) return;
  const token = ++buildToken;
  video.pause();

  const ratio = video.videoWidth / video.videoHeight;
  const w = ratio >= 1 ? MAX_SIDE : Math.max(2, Math.round(MAX_SIDE * ratio));
  const h = ratio >= 1 ? Math.max(2, Math.round(MAX_SIDE / ratio)) : MAX_SIDE;
  const d = Math.min(MAX_DEPTH, Math.max(48, Math.round(video.duration * 30)));

  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const context = scratch.getContext('2d', {willReadFrequently: true});
  const data = new Uint8Array(w * h * d * 4);
  const layer = w * h * 4;

  for (let i = 0; i < d; i += 1) {
    await waitForSeek(video.duration * i / Math.max(d - 1, 1));
    if (token !== buildToken) return; // a newer clip was dropped mid-build
    context.drawImage(video, 0, 0, w, h);
    data.set(context.getImageData(0, 0, w, h).data, i * layer);
    if (i % 8 === 0) statusEl.textContent = `BUILDING ${Math.round((i + 1) / d * 100)}%`;
  }

  volumeTexture?.dispose();
  volumeTexture = new THREE.Data3DTexture(data, w, h, d);
  volumeTexture.format = THREE.RGBAFormat;
  volumeTexture.type = THREE.UnsignedByteType;
  volumeTexture.minFilter = THREE.LinearFilter;
  volumeTexture.magFilter = THREE.LinearFilter;
  volumeTexture.wrapS = volumeTexture.wrapT = volumeTexture.wrapR = THREE.ClampToEdgeWrapping;
  volumeTexture.unpackAlignment = 1;
  volumeTexture.needsUpdate = true;
  uniforms.uVolume.value = volumeTexture;

  frameCount = d;
  frameCountEl.textContent = `${d} FRAMES`;
  setScale();
  updateSpacingReadout();
  block.visible = true;
  statusEl.textContent = 'READY';
}

function resize() {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// Hold the default framing until the block outgrows it, then back off to fit.
function cameraDistance() {
  const s = block.scale;
  const radius = 0.5 * Math.hypot(s.x, s.y, s.z);
  return Math.max(5.8, radius / Math.sin(camera.fov * Math.PI / 360) * 1.1);
}

let lastTime = performance.now();
function draw(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!dragging && now > spinHeldUntil) {
    angleY += spin * dt;
    setRotationReadout();
  }
  block.rotation.set(angleX, angleY, 0);
  camera.position.set(0, 0.35, cameraDistance() / zoom);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// --- controls -------------------------------------------------------------

function bindSlider(id, onInput) {
  const input = document.querySelector(`#${id}`);
  const output = document.querySelector(`#${id}-value`);
  const paint = () => {
    const pct = (input.value - input.min) / (input.max - input.min) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  };
  input.addEventListener('input', () => { onInput(Number(input.value), output); paint(); });
  paint();
  return {input, output, paint};
}

const spacing = bindSlider('spacing', value => {
  depth = value;
  setScale();
  updateSpacingReadout();
});
function updateSpacingReadout() {
  spacing.output.textContent = (depth / Math.max(frameCount, 1)).toFixed(4);
}

const rotation = bindSlider('rotation', value => {
  angleY = value * Math.PI / 180;
  spinHeldUntil = performance.now() + 900; // let the thumb stay under the cursor
});
function setRotationReadout() {
  let deg = (angleY * 180 / Math.PI + 180) % 360 - 180;
  rotation.input.value = deg;
  rotation.output.textContent = `${deg.toFixed(1)}°`;
  rotation.paint();
}

const opacity = bindSlider('opacity', (value, output) => {
  uniforms.uDensity.value = value / 100;
  output.textContent = `${Math.round(value)}%`;
});
uniforms.uDensity.value = Number(opacity.input.value) / 100;
opacity.output.textContent = `${Math.round(opacity.input.value)}%`;
depth = Number(spacing.input.value);

stage.addEventListener('pointerdown', event => {
  dragging = true;
  lastPointer = {x: event.clientX, y: event.clientY};
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', event => {
  if (!dragging) return;
  angleY += (event.clientX - lastPointer.x) * 0.008;
  angleX = Math.max(-0.9, Math.min(0.9, angleX + (event.clientY - lastPointer.y) * 0.006));
  lastPointer = {x: event.clientX, y: event.clientY};
  setRotationReadout();
});
const stopDrag = () => { dragging = false; };
stage.addEventListener('pointerup', stopDrag);
stage.addEventListener('pointercancel', stopDrag);
stage.addEventListener('wheel', event => {
  event.preventDefault();
  zoom = Math.max(0.6, Math.min(1.8, zoom - event.deltaY * 0.001));
}, {passive: false});

// --- source ---------------------------------------------------------------

function loadVideo(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    statusEl.textContent = 'NOT A VIDEO FILE';
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  block.visible = false;
  statusEl.textContent = 'LOADING';
  sourceEl.textContent = file.name;
  video.src = objectUrl;
  video.load();
}
fileInput.addEventListener('change', event => loadVideo(event.target.files[0]));
['dragenter', 'dragover'].forEach(type => document.addEventListener(type, event => {
  event.preventDefault();
  document.body.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(type => document.addEventListener(type, event => {
  event.preventDefault();
  document.body.classList.remove('dragover');
}));
document.addEventListener('drop', event => loadVideo(event.dataTransfer.files[0]));

video.addEventListener('loadedmetadata', buildVolume);
video.addEventListener('error', () => {
  buildToken += 1;
  block.visible = false;
  statusEl.textContent = 'CANNOT READ FILE';
});
if (video.readyState >= 1) buildVolume();

// --- export ---------------------------------------------------------------

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = name;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

document.querySelector('#snapshot').addEventListener('click', () => {
  renderer.domElement.toBlob(blob => blob && download(blob, 'frame-space.png'));
});

const exportButton = document.querySelector('#export');
exportButton.addEventListener('click', () => {
  if (!canvas.captureStream || !window.MediaRecorder) return;
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  const recorder = new MediaRecorder(canvas.captureStream(60), {mimeType: mime, videoBitsPerSecond: 12e6});
  const chunks = [];
  recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
  recorder.onstop = () => {
    download(new Blob(chunks, {type: mime}), 'frame-space.webm');
    exportButton.disabled = false;
    exportButton.textContent = 'RECORD TURN';
    statusEl.textContent = 'READY';
  };
  exportButton.disabled = true;
  exportButton.textContent = 'RECORDING…';
  statusEl.textContent = 'RECORDING';
  // One full revolution at the current spin rate.
  recorder.start();
  setTimeout(() => recorder.stop(), Math.min(30000, 2 * Math.PI / spin * 1000));
});
