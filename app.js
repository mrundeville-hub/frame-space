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
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

const uniforms = {
  uVolume: {value: null},
  uScale: {value: new THREE.Vector3(1, 1, 1)},   // slab size: width, height, depth (time)
  uSize: {value: new THREE.Vector3(1, 1, 1)},    // proxy box size (bounds the bent shape)
  uCut: {value: 1},                              // cut-away position along time, 1 = no cut
  uPlane: {value: 0.45},                         // the active frame: position of the opaque time plane
  uOrtho: {value: 1},                            // 1 = isometric (parallel rays)
  uSolid: {value: 0},
  uShape: {value: 0},                            // 0 = box, 1 = lens, 2 = circle (cylinder along time)
  uBlur: {value: 0.4},                           // 0 = sharp, 1 = frames smear into each other
  uLayers: {value: 0},                           // 0 = continuous, 1 = thin separate frame plates                            // 1 = opaque surface instead of glass
  uPhi: {value: 0},                              // total angle the time axis is rolled through
  uRho: {value: 1},                              // bend radius = depth / phi
  uCenter: {value: new THREE.Vector2(0, 0)},     // bbox centre offset of the bent shape
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
    uniform float uOrtho;
    void main() {
      if (uOrtho > 0.5) {
        // Parallel rays: every pixel looks along the camera's forward axis.
        vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
        vec3 d = normalize((inverse(modelMatrix) * vec4(forward, 0.0)).xyz);
        vOrigin = position - d * 10.0;
        vDirection = d;
      } else {
        vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        vDirection = position - vOrigin;
      }
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
    uniform vec3 uSize;
    uniform float uCut;
    uniform float uPlane;
    uniform float uSolid;
    uniform float uShape;
    uniform float uLayers;
    uniform float uBlur;
    uniform float uPhi;
    uniform float uRho;
    uniform vec2 uCenter;
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

    // l is slab-local (world units), so the rounding stays even on a non-cubic block.
    float roundBox(vec3 l) {
      vec3 hs = uScale * 0.5;
      if (uShape > 1.5) {
        // Circle: a cylinder along the time axis.
        vec2 d = vec2(length(l.xy) - min(hs.x, hs.y) + uRadius, abs(l.z) - hs.z + uRadius);
        return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - uRadius;
      }
      // Lens: the picture shrinks toward the first and last frame.
      if (uShape > 0.5) l.xy /= 1.0 - 0.45 * pow(abs(l.z) / hs.z, 2.0);
      vec3 q = abs(l) - hs + uRadius;
      return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - uRadius;
    }

    // Soft look: average the centre with four diagonal taps spread across x, y and time.
    vec3 sampleVolume(vec3 c) {
      if (uBlur < 0.01) return texture(uVolume, c).rgb;
      vec3 o = uBlur * vec3(0.016, 0.016, 0.05);
      return 0.2 * (texture(uVolume, c).rgb
        + texture(uVolume, c + vec3( o.x,  o.y,  o.z)).rgb
        + texture(uVolume, c + vec3(-o.x, -o.y,  o.z)).rgb
        + texture(uVolume, c + vec3( o.x, -o.y, -o.z)).rgb
        + texture(uVolume, c + vec3(-o.x,  o.y, -o.z)).rgb);
    }

    // World point -> slab-local point. Rolled: the time axis is bent into an arc
    // of radius uRho around the y axis, so x becomes radius and z becomes arc length.
    vec3 toLocal(vec3 w) {
      if (uPhi < 0.02) return w;
      vec2 d = vec2(w.x + uCenter.x, w.z + uCenter.y + uRho);
      return vec3(length(d) - uRho, w.y, atan(d.x, d.y) * uRho);
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
      bool prevRemoved = false;
      vec3 prevUvw = vec3(0.0);
      bool havePrev = false;
      for (float i = 0.0; i < uSteps; i += 1.0) {
        vec3 local = toLocal(p * uSize);
        float mask = 1.0 - smoothstep(-uSoft, 0.0, roundBox(local));
        if (mask > 0.002) {
          vec3 uvw = local / uScale + 0.5;
          if (uCut < 0.999 && uvw.z > uCut) {
            prevRemoved = true; // cut away
            havePrev = false;
          } else {
            // Active frame: when the ray crosses the time plane, draw that video frame
            // as an opaque card inside the otherwise faint volume.
            if (havePrev) {
              float d0 = prevUvw.z - uPlane;
              float d1 = uvw.z - uPlane;
              if (d0 * d1 < 0.0) {
                vec3 hit = mix(prevUvw, uvw, d0 / (d0 - d1));
                acc.rgb += (1.0 - acc.a) * texture(uVolume, hit).rgb;
                acc.a = 1.0;
                break;
              }
            }
            prevUvw = uvw;
            havePrev = true;
            vec3 color = sampleVolume(uvw);
            // First kept sample after cut-away ones is the cut face: draw it solid.
            if (prevRemoved || (uSolid > 0.5 && mask > 0.5)) {
              acc.rgb += (1.0 - acc.a) * color;
              acc.a = 1.0;
              break;
            }
            // Layers: keep density only in thin plates, one per few frames.
            float plate = 1.0;
            if (uLayers > 0.01) {
              float thick = mix(1.0, 0.1, uLayers);
              plate = (1.0 - smoothstep(thick * 0.4, thick * 0.5, abs(fract(uvw.z * 28.0) - 0.5))) / thick;
            }
            float alpha = 1.0 - exp(-sigma * mask * plate * dt);
            acc.rgb += (1.0 - acc.a) * alpha * color;
            acc.a += (1.0 - acc.a) * alpha;
            if (acc.a > 0.995) break;
          }
        } else {
          prevRemoved = false;
          havePrev = false;
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
let roll = 0;
let playing = false;
let angleY = Math.PI / 4;      // isometric: 45° around, 35.264° down
let angleX = 0.6155;
let spin = 0;
let iso = true;
let playhead = 0.45;
let cutOn = false;
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
  const phi = roll * Math.PI * 2;
  uniforms.uScale.value.set(w, h, depth);
  uniforms.uRadius.value = Math.min(w, h, depth) * 0.22;
  uniforms.uSoft.value = Math.min(w, h, depth) * 0.07;
  uniforms.uPhi.value = phi;

  if (phi < 0.02) {
    uniforms.uCenter.value.set(0, 0);
    block.scale.set(w, h, depth);
  } else {
    // Bounding box of the rolled shape: sweep both radial edges through the arc.
    const rho = depth / phi;
    uniforms.uRho.value = rho;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i <= 128; i += 1) {
      const a = (i / 128 - 0.5) * phi;
      for (const r of [Math.max(rho - w / 2, 0), rho + w / 2]) {
        const x = r * Math.sin(a), z = r * Math.cos(a) - rho;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    uniforms.uCenter.value.set((minX + maxX) / 2, (minZ + maxZ) / 2);
    block.scale.set((maxX - minX) * 1.02 + 0.02, h, (maxZ - minZ) * 1.02 + 0.02);
  }
  uniforms.uSize.value.copy(block.scale);
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
  setCut(playhead);
  setScale();
  updateSpacingReadout();
  block.visible = true;
  statusEl.textContent = 'READY';
}

let viewW = 1;
let viewH = 1;
function resize() {
  const rect = stage.getBoundingClientRect();
  viewW = rect.width;
  viewH = Math.max(rect.height, 1);
  renderer.setSize(viewW, viewH, false);
}
new ResizeObserver(resize).observe(stage);
resize();

// Hold the default framing until the block outgrows it, then back off to fit.
function cameraDistance() {
  const s = block.scale;
  const radius = 0.5 * Math.hypot(s.x, s.y, s.z);
  return Math.max(5.8, radius / Math.sin(camera.fov * Math.PI / 360) * 1.1);
}

let split = false;

function renderView(x, y, w, h, cam) {
  renderer.setViewport(x, y, w, h);
  renderer.setScissor(x, y, w, h);
  const aspect = w / h;
  if (cam === orthoCamera) {
    const radius = 0.5 * Math.hypot(block.scale.x, block.scale.y, block.scale.z) * 1.08 / zoom;
    const halfH = aspect >= 1 ? radius : radius / aspect;
    orthoCamera.left = -halfH * aspect;
    orthoCamera.right = halfH * aspect;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
  } else {
    camera.aspect = aspect;
  }
  cam.updateProjectionMatrix();
  cam.lookAt(0, 0, 0);
  renderer.render(scene, cam);
}

// Split: the orbitable volume on top, the same volume seen straight down its time axis below.
function renderViews() {
  renderer.setScissorTest(true);
  const cam = iso ? orthoCamera : camera;
  uniforms.uOrtho.value = iso ? 1 : 0;
  const distance = cameraDistance() / zoom;
  const place = height => cam.position.set(0, iso ? 0 : height, iso ? 20 : distance);
  block.rotation.set(angleX, angleY, 0);
  place(0.35);
  if (!split) {
    renderView(0, 0, viewW, viewH, cam);
    return;
  }
  const half = Math.floor(viewH / 2);
  renderView(0, viewH - half, viewW, half, cam);
  block.rotation.set(0, 0, 0);
  place(0);
  renderView(0, 0, viewW, half, cam);
}

let lastTime = performance.now();
function draw(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!dragging && now > spinHeldUntil) {
    angleY += spin * dt;
    setRotationReadout();
  }
  if (playing && frameCount) {
    const next = playhead + dt / Math.max(video.duration || 6, 2);
    setCut(next >= 1 ? 0 : next); // loop through the clip at its own speed
  }
  renderViews();
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

const tilt = bindSlider('tilt', value => {
  angleX = value * Math.PI / 180;
  spinHeldUntil = performance.now() + 900;
});
function setTiltReadout() {
  const deg = angleX * 180 / Math.PI;
  tilt.input.value = deg;
  tilt.output.textContent = `${deg.toFixed(1)}°`;
  tilt.paint();
}

const opacity = bindSlider('opacity', (value, output) => {
  uniforms.uDensity.value = value / 100;
  output.textContent = `${Math.round(value)}%`;
});
uniforms.uDensity.value = Number(opacity.input.value) / 100;
opacity.output.textContent = `${Math.round(opacity.input.value)}%`;
depth = Number(spacing.input.value);
setTiltReadout();

const cut = bindSlider('cut', value => setCut(value / 1000));
function setCut(value) {
  playhead = Math.min(Math.max(value, 0), 1);
  cut.input.value = playhead * 1000;
  cut.paint();
  const plane = 0.004 + playhead * 0.992; // keep the card just inside the first and last frame
  uniforms.uPlane.value = plane;
  uniforms.uCut.value = cutOn ? plane : 1;
  const frame = Math.round(playhead * Math.max(frameCount - 1, 0)) + 1;
  cut.output.textContent = frameCount ? `${String(frame).padStart(3, '0')} / ${frameCount}` : '…';
}
setCut(Number(cut.input.value) / 1000);

const rollControl = bindSlider('roll', (value, output) => {
  roll = value / 100;
  output.textContent = roll < 0.01 ? 'FLAT' : `${Math.round(roll * 360)}°`;
  setScale();
});

function bindSegment(id, onPick) {
  const buttons = [...document.querySelectorAll(`#${id} button`)];
  buttons.forEach(button => button.addEventListener('click', () => {
    buttons.forEach(other => other.classList.toggle('on', other === button));
    onPick(Number(button.dataset.value));
  }));
}
bindSegment('mode', value => { uniforms.uSolid.value = value; });
bindSegment('cutmode', value => { cutOn = value === 1; setCut(playhead); });
bindSegment('proj', value => { iso = value === 0; });
bindSegment('shape', value => { uniforms.uShape.value = value; });

bindSlider('blur', (value, output) => {
  uniforms.uBlur.value = value / 100;
  output.textContent = value < 1 ? 'OFF' : `${Math.round(value)}%`;
});

bindSlider('layers', (value, output) => {
  uniforms.uLayers.value = value / 100;
  output.textContent = value < 1 ? 'OFF' : `${Math.round(value)}%`;
});

const splitButton = document.querySelector('#split');
splitButton.addEventListener('click', () => {
  split = !split;
  stage.classList.toggle('split', split);
  splitButton.textContent = split ? 'Single view' : 'Split view';
  document.querySelector('h1').textContent = split ? 'Outside / inside.' : 'Time as shape.';
});

const playButton = document.querySelector('#play');
function setPlaying(on) {
  playing = on;
  playButton.classList.toggle('playing', on);
  playButton.setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on && playhead >= 0.999) setCut(0); // restart from the first frame
}
playButton.addEventListener('click', () => setPlaying(!playing));
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault();
    setPlaying(!playing);
  }
});

stage.addEventListener('pointerdown', event => {
  dragging = true;
  lastPointer = {x: event.clientX, y: event.clientY};
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', event => {
  if (!dragging) return;
  angleY += (event.clientX - lastPointer.x) * 0.008;
  angleX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, angleX + (event.clientY - lastPointer.y) * 0.006));
  lastPointer = {x: event.clientX, y: event.clientY};
  setRotationReadout();
  setTiltReadout();
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
  // One full revolution in 8 seconds, then back to a still cube.
  const previousSpin = spin;
  spin = 2 * Math.PI / 8;
  recorder.start();
  setTimeout(() => { recorder.stop(); spin = previousSpin; }, 8000);
});
