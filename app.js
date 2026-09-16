import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const canvas = document.querySelector('#canvas');
const stage = document.querySelector('#stage');
const video = document.querySelector('#video');
const fileInput = document.querySelector('#file-input');
const dropzone = document.querySelector('#dropzone');
const fileName = document.querySelector('#file-name');
const playButton = document.querySelector('#play-button');
const state = document.querySelector('#stage-state');
const timeline = document.querySelector('#timeline');
const currentTime = document.querySelector('#time-current');
const totalTime = document.querySelector('#time-total');
const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
const cube = new THREE.Group();
scene.add(cube);

let frameWidth = 2.65;
let frameHeight = 2.65;
let depth = 1.25;
let stackFill = 0.12;
let frameOpacity = 0.08;
let glow = 0.70;
let rotationSpeed = 0.35;
let frameTextures = [];
let frameMeshes = [];
let activeFrame = null;
let frameIndex = 0;
let building = false;
let cubeRotation = {x: 0.16, y: -0.42};
let zoom = 1;
let dragging = false;
let lastPointer = {x: 0, y: 0};
let oldObjectUrl = null;

const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.1, 64), new THREE.MeshBasicMaterial({color: 0x173427, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending}));
shadow.rotation.x = -Math.PI / 2;
shadow.scale.set(1.3, 0.35, 1);
shadow.position.y = -1.12;
scene.add(shadow);

function formatTime(seconds) { return Number.isFinite(seconds) ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '00:00'; }
function setValue(id, value, digits = 2) { document.querySelector(`#${id}-value`).textContent = Number(value).toFixed(digits); }
function waitForSeek(time) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}
async function extractFrames() {
  if (!video.duration || !video.videoWidth) return;
  building = true;
  state.textContent = 'BUILDING STACK';
  video.pause();
  const count = Math.min(60, Math.max(18, Math.round(video.duration * 5)));
  const ratio = video.videoWidth / video.videoHeight;
  const maxSide = 360;
  const scratch = document.createElement('canvas');
  // Remove meshes before detaching their old ImageBitmaps.
  clearCube();
  scratch.width = ratio >= 1 ? maxSide : Math.round(maxSide * ratio);
  scratch.height = ratio >= 1 ? Math.round(maxSide / ratio) : maxSide;
  const context = scratch.getContext('2d', {willReadFrequently: false});
  frameTextures.forEach(texture => { texture.image?.close?.(); texture.dispose(); });
  frameTextures = [];
  const originalTime = Math.min(video.currentTime, Math.max(video.duration - 0.01, 0));
  for (let i = 0; i < count; i += 1) {
    await waitForSeek(video.duration * i / Math.max(count - 1, 1));
    context.save();
    context.translate(0, scratch.height);
    context.scale(1, -1);
    context.drawImage(video, 0, 0, scratch.width, scratch.height);
    context.restore();
    const bitmap = await createImageBitmap(scratch);
    const texture = new THREE.Texture(bitmap);
    // ImageBitmap already exposes canvas pixels in the orientation used by the UVs.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    frameTextures.push(texture);
    if (i % 4 === 0) state.textContent = `STACK ${Math.round((i + 1) / count * 100)}%`;
  }
  frameWidth = 2.65;
  frameHeight = frameWidth / ratio;
  video.currentTime = originalTime;
  rebuildStack();
  updateStack();
  building = false;
  state.textContent = video.paused ? 'PAUSED' : 'PLAYING';
}
function clearCube() {
  frameMeshes.forEach(mesh => { mesh.material.dispose(); mesh.geometry.dispose(); cube.remove(mesh); });
  frameMeshes = [];
  if (activeFrame) { cube.remove(activeFrame); activeFrame.geometry.dispose(); activeFrame.material.dispose(); activeFrame = null; }
  cube.children.filter(child => child.userData.shell).forEach(child => { child.geometry.dispose(); child.material.dispose(); cube.remove(child); });
}
function rebuildStack() {
  clearCube();
  if (!frameTextures.length) return;
  const planeGeometry = new THREE.PlaneGeometry(frameWidth, frameHeight);
  frameTextures.forEach((texture, index) => {
    const mesh = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({map: texture, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.NormalBlending}));
    mesh.userData.index = index;
    mesh.position.z = depth / 2 - index / Math.max(frameTextures.length - 1, 1) * depth;
    cube.add(mesh);
    frameMeshes.push(mesh);
  });
  const shell = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(frameWidth, frameHeight, depth)), new THREE.LineBasicMaterial({color: 0x39765a, transparent: true, opacity: 0.26, blending: THREE.AdditiveBlending, depthWrite: false}));
  shell.userData.shell = true;
  cube.add(shell);
  activeFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(frameWidth, frameHeight)), new THREE.LineBasicMaterial({color: 0xb9f34a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false}));
  cube.add(activeFrame);
  shadow.scale.x = 1.1 + depth * 0.35;
}
function updateStack() {
  if (!frameMeshes.length || !video.duration) return;
  frameIndex = Math.min(frameTextures.length - 1, Math.max(0, Math.round(video.currentTime / video.duration * (frameTextures.length - 1))));
  const focusRadius = Math.max(1, Math.round(frameTextures.length * stackFill));
  frameMeshes.forEach(mesh => {
    const distance = Math.abs(mesh.userData.index - frameIndex);
    const focus = Math.max(0, 1 - distance / focusRadius);
    // Every frame stays in the volume; playback only changes local emphasis.
    mesh.visible = true;
    mesh.material.opacity = Math.min(0.92, frameOpacity + focus * (0.92 - frameOpacity));
  });
  if (activeFrame) {
    activeFrame.visible = true;
    activeFrame.position.z = depth / 2 - frameIndex / Math.max(frameTextures.length - 1, 1) * depth;
  }
  cube.children.filter(child => child.userData.shell).forEach(shell => { shell.material.opacity = 0.08 + glow * 0.34; });
}
function resize() {
  const rect = stage.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
function draw(time) {
  if (!dragging && !video.paused) cubeRotation.y += 0.00012 * rotationSpeed;
  cube.rotation.order = 'YXZ';
  cube.rotation.set(cubeRotation.x, cubeRotation.y, 0);
  camera.position.set(0, 0.8, 7.0 / zoom);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function syncMetadata() { timeline.max = video.duration || 1; totalTime.textContent = formatTime(video.duration); }
function startExtraction() { if (building) return; extractFrames().then(() => video.play().catch(() => {})); }
video.addEventListener('loadedmetadata', () => { syncMetadata(); startExtraction(); });
video.addEventListener('timeupdate', () => { syncMetadata(); timeline.value = video.currentTime; currentTime.textContent = formatTime(video.currentTime); if (!building) updateStack(); });
video.addEventListener('play', () => { playButton.textContent = 'Ⅱ'; if (!building) state.textContent = 'PLAYING'; });
video.addEventListener('pause', () => { playButton.textContent = '▶'; if (!building) state.textContent = 'PAUSED'; });
playButton.addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
timeline.addEventListener('input', () => { video.currentTime = Number(timeline.value); updateStack(); });

document.querySelector('#depth').addEventListener('input', event => { depth = Number(event.target.value); setValue('depth', depth); rebuildStack(); updateStack(); });
document.querySelector('#fill').addEventListener('input', event => { stackFill = Number(event.target.value); setValue('fill', stackFill); updateStack(); });
document.querySelector('#opacity').addEventListener('input', event => { frameOpacity = Number(event.target.value); setValue('opacity', frameOpacity); updateStack(); });
document.querySelector('#glow').addEventListener('input', event => { glow = Number(event.target.value); setValue('glow', glow); updateStack(); });
document.querySelector('#rotation').addEventListener('input', event => { rotationSpeed = Number(event.target.value); setValue('rotation', rotationSpeed); });

function loadVideo(file, label = file.name) {
  if (!file || !file.type.startsWith('video/')) return;
  if (oldObjectUrl) URL.revokeObjectURL(oldObjectUrl);
  oldObjectUrl = URL.createObjectURL(file);
  video.pause(); video.src = oldObjectUrl; video.load(); fileName.textContent = label; state.textContent = 'LOADING';
  video.play().catch(() => {});
}
fileInput.addEventListener('change', event => loadVideo(event.target.files[0]));
['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', event => loadVideo(event.dataTransfer.files[0]));
stage.addEventListener('pointerdown', event => { dragging = true; lastPointer = {x: event.clientX, y: event.clientY}; stage.setPointerCapture(event.pointerId); });
stage.addEventListener('pointermove', event => { if (!dragging) return; cubeRotation.y += (event.clientX - lastPointer.x) * 0.008; cubeRotation.x = Math.max(-0.52, Math.min(0.52, cubeRotation.x + (event.clientY - lastPointer.y) * 0.006)); lastPointer = {x: event.clientX, y: event.clientY}; });
stage.addEventListener('pointerup', () => { dragging = false; });
stage.addEventListener('pointercancel', () => { dragging = false; });
stage.addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(0.72, Math.min(1.5, zoom - event.deltaY * 0.001)); }, {passive: false});
document.querySelector('#reset-button').addEventListener('click', () => { cubeRotation = {x: 0.16, y: -0.42}; zoom = 1; });

const exportButton = document.querySelector('#export-button');
const snapshotButton = document.querySelector('#snapshot-button');
snapshotButton.addEventListener('click', () => renderer.domElement.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.download = 'frame-space.png'; link.href = url; link.click(); URL.revokeObjectURL(url); }));
exportButton.addEventListener('click', async () => {
  if (!video.duration || !canvas.captureStream || !window.MediaRecorder) { snapshotButton.click(); return; }
  exportButton.disabled = true; exportButton.querySelector('span').textContent = 'RECORDING…'; state.textContent = 'RECORDING'; video.currentTime = 0; await video.play().catch(() => {});
  const stream = canvas.captureStream(30); const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'; const recorder = new MediaRecorder(stream, {mimeType: mime}); const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => { const url = URL.createObjectURL(new Blob(chunks, {type: mime})); const link = document.createElement('a'); link.download = 'frame-space.webm'; link.href = url; link.click(); URL.revokeObjectURL(url); exportButton.disabled = false; exportButton.querySelector('span').textContent = 'EXPORT CLIP'; state.textContent = video.paused ? 'PAUSED' : 'PLAYING'; };
  const stopAt = () => { if (video.currentTime >= video.duration - 0.04) { video.removeEventListener('timeupdate', stopAt); recorder.stop(); } };
  video.addEventListener('timeupdate', stopAt); recorder.start();
});

if (video.readyState >= 1) { syncMetadata(); startExtraction(); }
