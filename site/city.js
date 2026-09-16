import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const base = new URL('./city-model/', location.href);
const asset = path => new URL(path, base).href;
const megabytes = bytes => `${(bytes / 1000000).toFixed(bytes < 10000000 ? 1 : 0)} MB`;
const infoSheet = $('info');
$('info-open').onclick = () => infoSheet.showModal();
infoSheet.addEventListener('click', event => {
  if (event.target !== infoSheet) return;
  const bounds = infoSheet.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) infoSheet.close();
});
$('download').addEventListener('keydown', event => {
  if (event.key === ' ') { event.preventDefault(); $('download').click(); }
});

async function response(url) {
  const result = await fetch(url, {cache: 'no-cache'});
  if (!result.ok) throw new Error(`Could not load model file (${result.status}).`);
  return result;
}

function downloadLink(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const srgb = Float32Array.from({length: 256}, (_, i) => {
  const x = i / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
});

// preview.bin / tile record: x y z float32 + rgba uint8.
function geometryFrom(buffer, expected) {
  if (!buffer.byteLength || buffer.byteLength !== expected * 16) throw new Error('A model tile is incomplete.');
  const raw = new DataView(buffer), count = expected;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = raw.getFloat32(i * 16 + axis * 4, true);
      if (!Number.isFinite(value)) throw new Error('The model contains invalid coordinates.');
      positions[i * 3 + axis] = value;
      colors[i * 3 + axis] = srgb[raw.getUint8(i * 16 + 12 + axis)];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

async function load() {
  const info = await (await response(asset('model.json'))).json();
  const date = new Date(info.updated_at || info.snapshot).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
  $('model-date').textContent = `Updated ${date}`;
  $('model-count').textContent = `${info.point_count.toLocaleString()} points`;
  const download = info.download;
  $('download').removeAttribute('aria-disabled');
  const downloadLabel = `Download city model · ${megabytes(download.bytes)}`;
  $('download').setAttribute('aria-label', downloadLabel);
  $('download').title = downloadLabel;
  if (download.parts) {
    $('download').href = '#download-model';
    $('download').onclick = async event => {
      event.preventDefault();
      if ($('download').getAttribute('aria-disabled') === 'true') return;
      $('download').setAttribute('aria-disabled', 'true');
      $('download').setAttribute('aria-busy', 'true');
      let loaded = 0;
      try {
        const parts = [];
        for (const part of download.parts) {
          const progress = `${Math.round(loaded / download.bytes * 100)}%`;
          $('download-status').textContent = `Downloading ${progress}`;
          const data = await (await response(asset(part.file))).arrayBuffer();
          if (data.byteLength !== part.bytes) throw new Error('A download file was incomplete. Please try again.');
          parts.push(data); loaded += data.byteLength;
        }
        if (loaded !== download.bytes) throw new Error('The download size did not match. Please try again.');
        downloadLink(new Blob(parts, {type: 'application/zip'}), download.name);
        $('download-status').textContent = 'Download ready.';
        setTimeout(() => { if ($('download-status').textContent === 'Download ready.') $('download-status').textContent = ''; }, 4000);
      } catch (error) { $('download-status').textContent = error.message; }
      finally { $('download').removeAttribute('aria-disabled'); $('download').removeAttribute('aria-busy'); }
    };
  } else {
    $('download').href = asset(download.file);
    $('download').download = download.file;
  }
  let renderer;
  try { renderer = new THREE.WebGLRenderer({antialias: false, powerPreference: 'high-performance'}); }
  catch { throw new Error('Your browser could not start the 3D viewer. The model download is still available.'); }
  const viewport = $('viewport');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#14181c');
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 20000);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.screenSpacePanning = true;
  const draw = () => renderer.render(scene, camera);
  controls.addEventListener('change', draw);
  const resize = () => {
    const {width, height} = viewport.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix(); draw();
  };
  new ResizeObserver(resize).observe(viewport);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); showError(new Error('The 3D view was interrupted. Reload this page to restore it.'));
  });
  const version = info.updated_at || info.snapshot;
  const material = new THREE.PointsMaterial({vertexColors: true, size: 1.7, sizeAttenuation: false});
  const addPoints = async ({file, points}) => {
    const url = new URL(asset(file));
    url.searchParams.set('version', version);
    const geometry = geometryFrom(await (await response(url)).arrayBuffer(), points);
    geometry.computeBoundingSphere(); // three.js frustum-culls each tile by this sphere
    scene.add(new THREE.Points(geometry, material));
    draw();
  };
  const [[x0, y0, z0], [x1, y1, z1]] = info.bounds;
  const bounds = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 2);
  controls.minDistance = .5; controls.maxDistance = radius * 12;
  function fit(top = false) {
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(1, 1 / camera.aspect);
    camera.up.set(0, 1, 0);
    camera.position.copy(center).add(top ? new THREE.Vector3(0, distance, distance * .0001) : new THREE.Vector3(0, 1.4, 1).normalize().multiplyScalar(distance));
    controls.target.copy(center); controls.update(); draw();
  }
  $('reset').disabled = false;
  $('reset').onclick = () => fit();
  viewport.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return fit();
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (event.key === 'ArrowLeft') spherical.theta -= .12;
    if (event.key === 'ArrowRight') spherical.theta += .12;
    if (event.key === 'ArrowUp') spherical.phi -= .12;
    if (event.key === 'ArrowDown') spherical.phi += .12;
    if (event.key === '+' || event.key === '=') spherical.radius *= .85;
    if (event.key === '-') spherical.radius *= 1.15;
    spherical.makeSafe();
    spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.up.set(0, 1, 0); controls.update(); draw();
  });
  resize(); fit();
  // Coarse sample first, then full tiles streamed nearest to the camera first; each tile draws as it lands.
  await addPoints(info.tiles.coarse);
  $('loading').hidden = true;
  $('viewer-status').textContent = `${info.preview_points.toLocaleString()} preview points · ${date}`;
  const pending = [...info.tiles.tiles];
  const nearest = () => {
    const eye = camera.position;
    pending.sort((a, b) => eye.distanceToSquared(new THREE.Vector3(...a.center)) - eye.distanceToSquared(new THREE.Vector3(...b.center)));
    return pending.shift();
  };
  await Promise.all(Array.from({length: 4}, async () => { for (let tile; (tile = nearest());) await addPoints(tile); }));
  setupLocate(info, scene, camera, controls, draw);
}

// Geolocate the viewer inside the model's local frame (metres, east/up/south) using the affine fit from build time.
function setupLocate(info, scene, camera, controls, draw) {
  const {affine: [a, b, c, d, e, f]} = info.geo;
  const [[x0, y0, z0], [x1, y1, z1]] = info.bounds;
  const marker = new THREE.Group();
  marker.add(new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({color: '#d6bfeb', transparent: true, opacity: .35, depthTest: false})));
  marker.add(new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), new THREE.MeshBasicMaterial({color: '#f0caba', depthTest: false})));
  marker.rotation.x = -Math.PI / 2; marker.renderOrder = 1; marker.visible = false;
  scene.add(marker);
  // Ground height: lower quartile of the nearest surface points, widening the search until enough are found.
  const groundY = (x, z) => {
    for (const radius of [8, 20, 50, 120, 300]) {
      const ys = [];
      for (const object of scene.children) {
        const position = object.geometry?.getAttribute('position');
        if (!position) continue;
        for (let i = 0; i < position.count; i++) {
          if (Math.abs(position.getX(i) - x) < radius && Math.abs(position.getZ(i) - z) < radius) ys.push(position.getY(i));
        }
      }
      if (ys.length >= 24) return ys.sort((p, q) => p - q)[ys.length >> 2];
    }
    return (y0 + y1) / 2;
  };
  $('locate').disabled = false;
  $('locate').onclick = () => {
    $('locate').disabled = true;
    $('download-status').textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(({coords: {latitude, longitude, accuracy}}) => {
      const x = a * latitude + b * longitude + c, z = d * latitude + e * longitude + f;
      const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1), outside = Math.hypot(dx, dz);
      marker.position.set(x, groundY(x, z) + .3, z);
      marker.children[0].scale.setScalar(Math.max(accuracy, 3));
      marker.visible = true;
      controls.target.copy(marker.position);
      camera.position.copy(marker.position).add(new THREE.Vector3(0, 90, 70));
      controls.update(); draw();
      $('download-status').textContent = outside ? `You are about ${Math.round(outside)} m outside the modelled area.` : 'You are inside the modelled area.';
      $('locate').disabled = false;
    }, error => {
      $('download-status').textContent = error.code === error.PERMISSION_DENIED ? 'Location access was denied.' : 'Your location could not be found.';
      $('locate').disabled = false;
    }, {enableHighAccuracy: true, timeout: 15000, maximumAge: 30000});
  };
}

function showError(error) {
  $('loading').hidden = true;
  $('viewer-error').hidden = false;
  $('viewer-error').textContent = error.message || 'The model could not be loaded. Please reload this page.';
  $('viewer-status').textContent = 'Model unavailable';
}
load().catch(showError);
