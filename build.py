"""Build the static city website.

    build.py --release DIR   stage a verified model release, then tile it
    build.py --retile        re-tile the staged preview and refit the geo transform
    build.py --tracks        rebuild tracks.json (walk map + leaderboard) from the uploads bucket
    build.py --all           retile + tracks + script checks (what CI runs)
    build.py --serve PORT    serve site/ and rebuild tracks.json every 10 minutes (what Railway runs)

R2 credentials come from R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET,
or from the JSON file named by R2_SETTINGS (keys s3_endpoint, access_key_id, secret_access_key, uploads_bucket).
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time
from uuid import UUID

import numpy as np

ROOT = Path(__file__).resolve().parent
DIST = ROOT / 'site'
# Release metadata that names or counts third-party imagery is not published; the model stands on its own.
PRIVATE_KEYS = {'credits', 'credits_url', 'mapillary_images', 'displayed_images_by_source', 'input_note', 'details',
                'summary', 'coverage', 'provenance', 'retained_provenance', 'surface_quality', 'components', 'details_file',
                'refinement_review', 'registration_scope'}
PUBLIC_FILES = {'model.json', 'coordinates.json', 'lidar-coarse.bin'}
POINT = np.dtype([('p', '<f4', 3), ('c', 'u1', 4)])  # preview.bin record: x y z float32, rgba uint8
TILE_M = 96
MIN_TILE = 2000  # sparser cells share one remainder file instead of costing a request each
COARSE_STRIDE = 12
MAX_GPS_ERROR_M = 25
MIN_WALK_SECONDS = 15    # a recording shorter than this, or one that never went anywhere, is a mis-fire:
MIN_WALK_METRES = 20     # it cannot reconstruct and it clutters the map and the leaderboard


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def geo(target, bounds):
    """Affine lat/lon -> model x,z fitted with pyproj; the local UTM frame is affine to well under 1 m here."""
    from pyproj import Transformer
    coords = json.loads((target / 'coordinates.json').read_text())
    ox, oy, _ = coords['origin_projected']
    to_wgs84 = Transformer.from_crs(coords['horizontal_epsg'], 4326, always_xy=True)
    (x0, _, z0), (x1, _, z1) = bounds
    xs, zs = np.meshgrid(np.linspace(x0, x1, 5), np.linspace(z0, z1, 5))
    xs, zs = xs.ravel(), zs.ravel()
    lon, lat = to_wgs84.transform(ox + xs, oy - zs)  # axes are east, up, south
    basis = np.c_[lat, lon, np.ones_like(lat)]
    ax = np.linalg.lstsq(basis, xs, rcond=None)[0]
    az = np.linalg.lstsq(basis, zs, rcond=None)[0]
    residual = float(max(abs(basis @ ax - xs).max(), abs(basis @ az - zs).max()))
    assert residual < 1, f'affine geo fit residual {residual:.2f} m'
    corner_lon, corner_lat = to_wgs84.transform([ox + x0, ox + x1, ox + x1, ox + x0], [oy - z1, oy - z1, oy - z0, oy - z0])
    return {'affine': [*map(float, ax), *map(float, az)], 'residual_m': residual,
            'corners_wgs84': [[float(a), float(b)] for a, b in zip(corner_lat, corner_lon)]}


def tile(target):
    """Split preview.bin into a coarse sample plus a grid of TILE_M tiles so the viewer can stream nearest-first."""
    model = json.loads((target / 'model.json').read_text())
    points = np.fromfile(target / model['preview'], dtype=POINT)
    assert len(points) == model['preview_points'], 'preview.bin does not match preview_points'
    tiles_dir = target / 'tiles'
    shutil.rmtree(tiles_dir, ignore_errors=True)
    tiles_dir.mkdir()
    coarse = points[::COARSE_STRIDE]
    coarse.tofile(tiles_dir / 'coarse.bin')
    cells = np.floor(points['p'][:, [0, 2]] / TILE_M).astype(np.int64)
    entries, rest = [], []
    for cx, cz in np.unique(cells, axis=0):
        chunk = points[(cells[:, 0] == cx) & (cells[:, 1] == cz)]
        if len(chunk) < MIN_TILE:
            rest.append(chunk)
            continue
        name = f'tiles/{cx}_{cz}.bin'
        chunk.tofile(target / name)
        entries.append({'file': name, 'points': len(chunk), 'center': [float(v) for v in chunk['p'].mean(axis=0)]})
    if rest:
        chunk = np.concatenate(rest)
        chunk.tofile(tiles_dir / 'rest.bin')
        entries.append({'file': 'tiles/rest.bin', 'points': len(chunk), 'center': [float(v) for v in chunk['p'].mean(axis=0)]})
    model['tiles'] = {'tile_m': TILE_M, 'coarse': {'file': 'tiles/coarse.bin', 'points': len(coarse)}, 'tiles': entries}
    model['geo'] = geo(target, model['bounds'])
    for key in PRIVATE_KEYS:
        model.pop(key, None)
    for stray in target.iterdir():
        if stray.is_file() and stray.name not in PUBLIC_FILES | {model['preview'], model.get('preview_download')}:
            stray.unlink()
    (target / 'model.json').write_text(json.dumps(model, indent=2) + '\n')
    return model


def build(release):
    release = release.resolve()
    model = json.loads((release / 'model.json').read_text())
    files = {model['preview'], model['preview_download'], 'coordinates.json'}
    if model.get('reference'): files.add(model['reference']['file'])
    download = model['download']
    if 'parts' in download:
        assert sum(part['bytes'] for part in download['parts']) == download['bytes']
        for part in download['parts']:
            path = release / part['file']
            assert path.stat().st_size == part['bytes'], f'Incomplete part: {path}'
            assert sha256(path) == part['sha256'], f'Changed part: {path}'
            files.add(part['file'])
    else:
        files.add(download['file'])
    assert (release / model['preview']).stat().st_size == model['preview_points'] * 16
    for name in files:
        source = release / name
        assert source.resolve().is_relative_to(release), f'Invalid asset path: {name}'
        assert source.is_file() and source.stat().st_size < 25_000_000, f'Invalid static asset: {name}'
    target = DIST / 'city-model'
    target.mkdir(exist_ok=True)
    # Publish the index last so it always refers to complete model files.
    for name in sorted(files - {'model.json'}):
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(release / name, dest)
    (target / 'model.json').write_text(json.dumps(model, indent=2) + '\n')
    model = tile(target)
    stamp_assets()
    check_scripts()
    print(json.dumps({'points': model['point_count'], 'preview_points': model['preview_points'],
                      'tiles': len(model['tiles']['tiles']), 'download_bytes': download['bytes'],
                      'static_assets': len(files)}, indent=2))


def stamp_assets():
    """Point each page at ?v=<content hash> for the stylesheet and scripts, so an edit is never served from cache."""
    import re
    versions = {a: sha256(DIST / a)[:8] for a in ['city.css', 'city.js', 'map.js'] if (DIST / a).is_file()}
    for page in DIST.glob('*.html'):
        text = original = page.read_text()
        for asset, version in versions.items():
            text = re.sub(rf'/{re.escape(asset)}(\?v=[0-9a-f]+)?"', f'/{asset}?v={version}"', text)
        if text != original:
            page.write_text(text)
            print(f'stamped {page.name}')


def check_scripts():
    for script in ['city.js', 'map.js', 'vendor/three.module.js', 'vendor/three.core.js', 'vendor/OrbitControls.js', 'vendor/leaflet.js']:
        subprocess.run(['node', '--check', str(DIST / script)], check=True)


def heading(frame):
    """Compass bearing the camera looks along, from the ARKit camera-to-world pose (x east, -z north)."""
    t = frame.get('transform')
    if not t:
        return None
    forward = (-t[0][2], -t[2][2])  # camera looks down its -z axis; world (x, z)
    return round(math.degrees(math.atan2(forward[0], -forward[1])) % 360)


def track(manifest):
    """One walk: contributor + GPS polyline [lat, lon, seconds, heading_deg] from the selected frames' fixes."""
    frames = manifest.get('frames', [])
    fixes = [(f['location'], f.get('video_timestamp_s'), heading(f)) for f in frames if f.get('location')]
    if manifest.get('location_start'):
        fixes.insert(0, (manifest['location_start'], 0, heading(frames[0]) if frames else None))
    points = []
    for fix, seconds, bearing in fixes:
        if fix['horizontal_accuracy_m'] > MAX_GPS_ERROR_M:
            continue
        point = [round(fix['latitude'], 6), round(fix['longitude'], 6), round(seconds or 0, 1), bearing]
        if not points or points[-1][:2] != point[:2]:
            points.append(point)
    if len(points) < 2:
        return None
    span = sum(math.dist(a[:2], b[:2]) for a, b in zip(points, points[1:])) * 111320   # degrees -> metres, near enough for a threshold
    seconds = (manifest.get('video') or {}).get('duration_s') or points[-1][2]
    if seconds < MIN_WALK_SECONDS or span < MIN_WALK_METRES:
        return None
    return {'id': manifest['id'], 'date': manifest['created_at'], 'device_id': manifest.get('device_id'),
            'contributor': manifest.get('contributor'), 'seconds': (manifest.get('video') or {}).get('duration_s'),
            'points': points}


def r2():
    """boto3 client + bucket from the environment, or None when no credentials are configured."""
    settings = {}
    if os.environ.get('R2_SETTINGS'):
        settings = json.loads(Path(os.environ['R2_SETTINGS']).read_text())
    endpoint = os.environ.get('R2_ENDPOINT') or settings.get('s3_endpoint')
    key = os.environ.get('R2_ACCESS_KEY_ID') or settings.get('access_key_id')
    secret = os.environ.get('R2_SECRET_ACCESS_KEY') or settings.get('secret_access_key')
    bucket = os.environ.get('R2_BUCKET') or settings.get('uploads_bucket')
    if not all([endpoint, key, secret, bucket]):
        return None
    import boto3
    from botocore.config import Config
    client = boto3.client('s3', endpoint_url=endpoint, aws_access_key_id=key, aws_secret_access_key=secret, region_name='auto',
                          config=Config(connect_timeout=10, read_timeout=60, retries={'max_attempts': 3, 'mode': 'standard'}))
    return client, bucket


def tracks(captures=()):
    """Write site/tracks.json from completed uploads (captures/<id>/complete.json) and local capture folders."""
    cache = ROOT / '.cache' / 'tracks'
    cache.mkdir(parents=True, exist_ok=True)
    walks, users = {}, []
    for folder in captures:
        for manifest in sorted(Path(folder).glob('*/manifest.json')):
            walk = track(json.loads(manifest.read_text()))
            if walk:
                walks[walk['id']] = walk
    storage = r2()
    if storage:
        client, bucket = storage
        pages = client.get_paginator('list_objects_v2')
        for page in pages.paginate(Bucket=bucket, Prefix='captures/'):
            for entry in page.get('Contents', []):
                parts = entry['Key'].split('/')
                if len(parts) != 3 or parts[2] != 'complete.json':
                    continue
                try:
                    capture_id = str(UUID(parts[1]))
                except ValueError:
                    continue
                cached = cache / f'{capture_id}.json'
                if not cached.exists():
                    body = client.get_object(Bucket=bucket, Key=f'captures/{capture_id}/manifest.json')['Body'].read()
                    cached.write_text(json.dumps(track(json.loads(body))))
                walk = json.loads(cached.read_text())
                if walk:
                    walks[walk['id']] = walk
        for page in pages.paginate(Bucket=bucket, Prefix='users/'):
            for entry in page.get('Contents', []):
                users.append(json.loads(client.get_object(Bucket=bucket, Key=entry['Key'])['Body'].read()))
    # Later name changes win; an explicit capture claim beats a device match.
    by_device, by_capture = {}, {}
    for user in sorted(users, key=lambda u: u.get('updated_at', '')):
        by_device[user['device_id']] = user['username']
        for capture_id in user.get('captures', []):
            by_capture[capture_id] = user['username']
    public = []
    for walk in sorted(walks.values(), key=lambda w: w['date']):
        name = by_capture.get(walk['id']) or by_device.get(walk['device_id']) or walk['contributor']
        public.append({'id': walk['id'], 'date': walk['date'], 'seconds': walk['seconds'],
                       'contributor': (name or '').strip()[:40] or None, 'points': walk['points']})
    (DIST / 'tracks.json').write_text(json.dumps({'walks': public}, separators=(',', ':')) + '\n')
    print(json.dumps({'walks': len(public), 'named': sum(1 for w in public if w['contributor'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--retile', action='store_true')
    parser.add_argument('--tracks', action='store_true')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--serve', type=int, metavar='PORT', help='serve site/ and refresh the walk map every 10 minutes')
    parser.add_argument('--captures', type=Path, nargs='*', default=[], help='local capture folders to include')
    args = parser.parse_args()
    if args.release:
        build(args.release)
    if args.retile or args.all:
        tile(DIST / 'city-model')
        stamp_assets()
        check_scripts()
    if args.tracks or args.all:
        tracks(args.captures)
    if args.serve:
        import http.server, threading, functools
        def refresh():
            while True:
                try:
                    tracks(args.captures)
                except Exception as error:  # a failed refresh keeps the last good tracks.json
                    print('tracks refresh failed:', error, flush=True)
                time.sleep(600)
        threading.Thread(target=refresh, daemon=True).start()
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
        http.server.ThreadingHTTPServer(('', args.serve), handler).serve_forever()
    if not (args.release or args.retile or args.tracks or args.all or args.serve):
        parser.error('nothing to do')
