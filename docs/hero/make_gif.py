# Render a page frame by frame with headless Edge, then stitch the frames into docs/<page>.gif.
# Made-up data only. Needs Microsoft Edge and Pillow: py docs/hero/make_gif.py [hero|plan]
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
WORK = Path(tempfile.mkdtemp(prefix="pons-hero-"))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
# page: (question typed into the chat, window height)
PAGES = {
    "hero": ("How did I sleep this week compared with last month?", 440),
    "plan": ("Make me a 16-week plan for the London Marathon, based on my current fitness.", 500),
}
PAGE = sys.argv[1] if len(sys.argv) > 1 else "hero"
QUESTION, HEIGHT = PAGES[PAGE]
SCALE = 1.5

frames = [({"q": 0, "tool": 0, "a1": 0, "bars": 0, "a2": 0}, 700)]
for n in range(4, len(QUESTION), 5):
    frames.append(({"q": n, "caret": 1, "tool": 0, "a1": 0, "bars": 0, "a2": 0}, 70))
frames.append(({"tool": 0, "a1": 0, "bars": 0, "a2": 0}, 600))
frames.append(({"a1": 0, "bars": 0, "a2": 0}, 900))
frames.append(({"bars": 0, "a2": 0}, 500))
for i in range(1, 9):
    frames.append(({"bars": round(i / 8, 3), "a2": 0}, 60))
frames.append(({"a2": 0}, 500))
frames.append(({}, 4500))
# Start on the finished answer: same loop, but anything that shows only the first frame shows the result.
frames.insert(0, frames.pop())


def render(i: int, params: dict) -> Path:
    out = WORK / f"{i:02d}.png"
    query = "&".join(f"{k}={v}" for k, v in params.items()) or "all=1"
    url = (HERE / f"{PAGE}.html").as_uri() + "?" + query
    subprocess.run(
        [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--force-device-scale-factor={SCALE}",
         f"--window-size=800,{HEIGHT}", f"--user-data-dir={WORK / 'profile'}", f"--screenshot={out}", url],
        check=True, capture_output=True,
    )
    return out


images = [Image.open(render(i, p)).convert("RGB") for i, (p, _) in enumerate(frames)]
palette = images[0].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
gif = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
target = HERE.parent / f"{PAGE}.gif"
gif[0].save(target, save_all=True, append_images=gif[1:], duration=[d for _, d in frames], loop=0, optimize=True)
print(target, f"{target.stat().st_size / 1024:.0f} KB", len(gif), "frames", f"{sum(d for _, d in frames) / 1000:.1f} s")
