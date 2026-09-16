# paint-ithaca.com

Static site for the Paint Ithaca city model: `site/` is the whole deployable.

- `/` streams the 3D model as spatial tiles; the location button places you in it.
- `/map.html` shows every submitted walk with replay, and the new-ground leaderboard.
- `site/tracks.json` is rebuilt from the uploads bucket; `site/city-model/` is the staged release.

## Build

```sh
pip install -r requirements.txt
R2_SETTINGS=/path/to/cloudflare-r2.json python build.py --all   # tiles + tracks + script checks
python build.py --release <release dir>                          # stage a new model release
python -m pytest -q tests
python -m http.server 8799 --directory site                      # preview at http://127.0.0.1:8799/
```

## Deploy (Railway)

One Railway service on this repo, custom domain `paint-ithaca.com`:

- Build command: `pip install -r requirements.txt && python build.py --all`
- Start command: `python -m http.server $PORT --directory site`
- Variables: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (read-only key for the uploads
  bucket), `R2_BUCKET`. `build.py` reads only these; nothing is committed.

Each deploy rebuilds `tracks.json` from the bucket. To pick up new walks without a push, add a
Railway cron schedule to the service (for example hourly) so it redeploys.

Model releases are produced by the pipeline repo (`3dscene`) on Spark and staged here with `--release`.
