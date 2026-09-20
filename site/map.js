const $ = id => document.getElementById(id);
if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
const CELL_M = 20;
const PALETTE = ['#BF382B', '#7D6B9E', '#4F7D59', '#B87329', '#2E708F', '#A1527D'];   // walkPalette in the app, exactly
const infoSheet = $('info');
$('info-open').onclick = () => infoSheet.showModal();
infoSheet.addEventListener('click', event => { if (event.target === infoSheet) infoSheet.close(); });
$('collapse').onclick = () => {
  const open = document.body.classList.toggle('collapsed') === false;
  $('collapse').setAttribute('aria-expanded', open);
  $('collapse').setAttribute('aria-label', open ? 'Collapse list' : 'Expand list');
};
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.onclick = () => {
    if (document.body.classList.contains('collapsed')) $('collapse').click();   // a tab in the collapsed bar opens the list
    for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', other === tab);
    $('walks').hidden = tab.dataset.tab !== 'walks';
    $('leaders').hidden = tab.dataset.tab !== 'leaders';
  };
}

const map = L.map('map', {zoomControl: false, attributionControl: true}).setView([42.4415, -76.4852], 15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
new ResizeObserver(() => map.invalidateSize()).observe($('map'));

const metres = ([lat1, lon1], [lat2, lon2]) => {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const cellOf = ([lat, lon]) => `${Math.floor(lat * 111320 / CELL_M)}:${Math.floor(lon * 111320 * Math.cos(lat * Math.PI / 180) / CELL_M)}`;
const name = walk => walk.contributor || 'Anonymous';
const COVER_M = 15;   // how far from a walked route the model can be trusted to have points
// A closed polygon COVER_M either side of a route, in a local metre frame (fine at street scale).
function band(points) {
  const [lat0, lon0] = points[0], ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const xy = points.map(([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * ky]), left = [], right = [];
  for (let i = 0; i < xy.length; i++) {
    const a = xy[Math.max(0, i - 1)], b = xy[Math.min(xy.length - 1, i + 1)], n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const px = -(b[1] - a[1]) / n * COVER_M, py = (b[0] - a[0]) / n * COVER_M;
    left.push([xy[i][0] + px, xy[i][1] + py]); right.push([xy[i][0] - px, xy[i][1] - py]);
  }
  return [...left, ...right.reverse()].map(([x, y]) => [lat0 + y / ky, lon0 + x / kx]);
}
// Distance in metres from a point to a route segment (same local frame).
function segmentMetres(p, a, b) {
  const ky = 111320, kx = 111320 * Math.cos(a[0] * Math.PI / 180);
  const ax = 0, ay = 0, bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky, px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
  const len2 = bx * bx + by * by, t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - (ax + t * bx), py - (ay + t * by));
}
const colorOf = (() => { const seen = new Map(); return who => seen.get(who) ?? seen.set(who, PALETTE[seen.size % PALETTE.length]).get(who); })();
const when = iso => new Date(iso).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});

// Leaderboard: cells (~20 m squares) a contributor walked before anyone else, in date order.
function leaderboard(walks) {
  const claimed = new Map(), totals = new Map();
  for (const walk of [...walks].sort((a, b) => a.date.localeCompare(b.date))) {
    const who = name(walk), stats = totals.get(who) ?? {who, walks: 0, cells: new Set(), fresh: 0, metres: 0};
    stats.walks++;
    for (let i = 0; i < walk.points.length; i++) {
      const cell = cellOf(walk.points[i]);
      stats.cells.add(cell);
      if (!claimed.has(cell)) { claimed.set(cell, who); stats.fresh++; }
      if (i) stats.metres += metres(walk.points[i - 1], walk.points[i]);
    }
    totals.set(who, stats);
  }
  return [...totals.values()].sort((a, b) => b.fresh - a.fresh || b.cells.size - a.cells.size);
}

let here, inside = () => null;

// Strava-style replay: a dot travels the walk at recorded pace (sped up so a full walk takes ~15 s), leaving a trail.
const replay = (() => {
  let walk, duration, t = 0, playing = false, frame, last;
  const dot = L.circleMarker([0, 0], {radius: 8, color: '#fff', weight: 2, fillOpacity: 1});
  const trail = L.polyline([], {weight: 6, opacity: 1});
  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const cone = L.polygon([], {color: '#fff', weight: 1, fillOpacity: .35, interactive: false});
  const at = seconds => {
    const p = walk.points;
    let i = 0;
    while (i < p.length - 2 && p[i + 1][2] <= seconds) i++;
    const [a, b] = [p[i], p[i + 1]], span = b[2] - a[2], k = span > 0 ? Math.min(1, Math.max(0, (seconds - a[2]) / span)) : 1;
    let bearing = null;
    if (a[3] != null && b[3] != null) { const d = ((b[3] - a[3] + 540) % 360) - 180; bearing = (a[3] + d * k + 360) % 360; }  // shortest arc
    else bearing = a[3] ?? b[3];
    return {pos: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], bearing, done: p.slice(0, i + 1).map(q => [q[0], q[1]])};
  };
  // Field of view of the phone camera as a wedge: 14 m long, 60° wide, centred on the look direction.
  const wedge = ([lat, lon], bearing) => {
    if (bearing == null) return [];
    const step = m => [m / 111320, m / (111320 * Math.cos(lat * Math.PI / 180))];
    const [dLat, dLon] = step(14);
    const ray = deg => [lat + dLat * Math.cos(deg * Math.PI / 180), lon + dLon * Math.sin(deg * Math.PI / 180)];
    return [[lat, lon], ...[-30, -15, 0, 15, 30].map(off => ray(bearing + off))];
  };
  const show = () => {
    const {pos, bearing, done} = at(t);
    dot.setLatLng(pos); trail.setLatLngs([...done, pos]); cone.setLatLngs(wedge(pos, bearing));
    $('scrub').value = duration ? Math.round(t / duration * 1000) : 0;
    $('clock').textContent = `${clock(t)} / ${clock(duration)}`;
  };
  const tick = now => {
    if (!playing) return;
    t = Math.min(duration, t + (now - last) / 1000 * Math.max(1, duration / 15)); last = now;
    show();
    if (t >= duration) return pause();
    frame = requestAnimationFrame(tick);
  };
  const play = () => { if (t >= duration) t = 0; playing = true; last = performance.now(); $('play').setAttribute('aria-label', 'Pause walk'); $('play').classList.add('playing'); frame = requestAnimationFrame(tick); };
  const pause = () => { playing = false; cancelAnimationFrame(frame); $('play').setAttribute('aria-label', 'Play walk'); $('play').classList.remove('playing'); };
  $('play').onclick = () => playing ? pause() : play();
  $('scrub').oninput = () => { pause(); t = $('scrub').value / 1000 * duration; show(); };
  return {
    start(next, color) {
      pause(); walk = next; t = 0;
      duration = Math.max(walk.points[walk.points.length - 1][2], 1);
      dot.setStyle({fillColor: color}); trail.setStyle({color}); cone.setStyle({fillColor: color});
      trail.addTo(map); cone.addTo(map); dot.addTo(map);
      $('replay').hidden = false;
      show(); play();
    },
  };
})();

async function load() {
  const modelBase = new URL(document.querySelector('meta[name=model-base]')?.content || './city-model/', location.href);
  const [tracks, model] = await Promise.all(['/tracks.json', new URL('model.json', modelBase).href].map(async url => {
    const result = await fetch(url, {cache: 'no-cache'});
    if (!result.ok) throw new Error(`Could not load ${url} (${result.status}).`);
    return result.json();
  }));
  const walks = tracks.walks.slice().reverse(), lines = new Map();
  // Coverage is the streets the model actually has points on: a band around every route the nightly batch has
  // reconstructed (model.json lists them), not a box around everything. Walks still waiting for a batch show as lines only.
  const modelled = new Set((model.walks ?? []).map(w => w.capture)), covered = [];
  for (const walk of walks) if (modelled.has(walk.id) && walk.points.length > 1) {
    covered.push(walk.points);
    L.polygon(band(walk.points), {color: '#4c514b', weight: 1, dashArray: '4 5', fillColor: '#6e7a61', fillOpacity: .18, interactive: false}).addTo(map);
  }
  if (covered.length) inside = ({lat, lng}) => covered.some(pts => pts.some((p, i) => i && segmentMetres([lat, lng], pts[i - 1], p) <= COVER_M));
  for (const walk of walks) {
    const line = L.polyline(walk.points.map(q => [q[0], q[1]]), {color: colorOf(name(walk)), weight: 4, opacity: .8}).addTo(map);  // Leaflet rejects 4-element points
    line.bindTooltip(`${name(walk)} · ${when(walk.date)}`);
    lines.set(walk.id, line);
  }
  const all = L.featureGroup([...lines.values()]);
  if (lines.size) map.fitBounds(all.getBounds().pad(.15), {maxZoom: 17});
  $('map-status').textContent = lines.size ? `${lines.size} walks` : 'No walks with GPS yet. Record one in the app.';
  for (const walk of walks) {
    const distance = walk.points.reduce((sum, point, i) => i ? sum + metres(walk.points[i - 1], point) : 0, 0);
    const item = document.createElement('li');
    item.innerHTML = `<button><span class="swatch"></span><b></b><span class="muted"></span></button>`;
    item.querySelector('.swatch').style.background = colorOf(name(walk));
    item.querySelector('b').textContent = name(walk);
    item.querySelector('.muted').textContent = `${when(walk.date)} · ${(distance / 1000).toFixed(2)} km${walk.seconds ? ` · ${Math.round(walk.seconds)} s` : ''}`;
    item.querySelector('button').onclick = () => {
      map.fitBounds(lines.get(walk.id).getBounds().pad(.3), {maxZoom: 18});
      for (const [id, line] of lines) line.setStyle({opacity: id === walk.id ? .35 : .15, weight: 4});
      replay.start(walk, colorOf(name(walk)));
    };
    $('walks').append(item);
  }
  for (const [rank, stats] of leaderboard(walks).entries()) {
    const item = document.createElement('li');
    item.innerHTML = `<span class="rank"></span><span class="swatch"></span><b></b><span class="muted"></span>`;
    item.querySelector('.rank').textContent = rank + 1;
    item.querySelector('.swatch').style.background = colorOf(stats.who);
    item.querySelector('b').textContent = stats.who;
    item.querySelector('.muted').textContent = `${stats.fresh} new cells · ${stats.cells.size} covered · ${stats.walks} walk${stats.walks === 1 ? '' : 's'} · ${(stats.metres / 1000).toFixed(1)} km`;
    $('leaders').append(item);
  }
}

$('locate').onclick = () => {
  $('map-status').textContent = 'Finding your location…';
  map.locate({setView: true, maxZoom: 17, enableHighAccuracy: true, timeout: 15000});
};
map.on('locationfound', ({latlng, accuracy}) => {
  here?.remove();
  here = L.featureGroup([L.circle(latlng, {radius: accuracy, color: '#7d6b9e', weight: 1, fillOpacity: .15}),
                         L.circleMarker(latlng, {radius: 7, color: '#fff', weight: 2, fillColor: '#c0392b', fillOpacity: 1})]).addTo(map);
  const where = inside(latlng);
  $('map-status').textContent = `You are here, within ${Math.round(accuracy)} m${where === null ? '' : where ? ', inside the modelled area' : ', outside the modelled area'}.`;
});
map.on('locationerror', ({message}) => { $('map-status').textContent = message; });

load().catch(error => { $('map-status').textContent = error.message; });
