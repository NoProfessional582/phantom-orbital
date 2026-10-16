# README animation

Regenerates `docs/phantom-orbital.gif` without extra dependencies (uses the sidecar's numpy).

```powershell
npm run build
$env:ORB_UI_PREVIEW='1'; node_modules\electron\dist\electron.exe . --state=idle --remote-debugging-port=9335
# in another terminal:
node scripts/readme-gif/capture.mjs .cache/gif-frames 3
cd scripts/readme-gif; ..\..\sidecar\.venv\Scripts\python.exe make_gif.py ..\..\.cache\gif-frames ..\..\docs\phantom-orbital.gif 320
```

The preview uses its own data folder and a mock backend; close it when done.
