"""產生本機開發用的示範影片（合成畫面，不含真實學生影片）：python test/make_demo_videos.py

輸出到 test/out/（已列在 .gitignore，不會推上 GitHub），本機開發伺服器會從這裡提供影片。
用正式的 tools/process_videos.py 處理，所以示範清單的格式和正式環境完全相同。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test' / 'out'
SRC, DST = OUT / 'demo_src', OUT / 'demo_videos'
sys.path.insert(0, str(ROOT / 'tools'))
import process_videos as pv  # noqa: E402


def ff(*args: str) -> None:
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', *args], check=True)


def clip(path: Path, sec: int, size: str = '1280x720', audio: bool = True, freq: int = 440) -> None:
    args = ['-f', 'lavfi', '-i', f'testsrc2=s={size}:r=30:d={sec}']
    if audio:
        args += ['-f', 'lavfi', '-i', f'sine=f={freq}:r=48000:d={sec}']
    args += ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
    if audio:
        args += ['-c:a', 'aac', '-b:a', '96k']
    ff(*args, str(path))


def main() -> int:
    for d in (SRC, DST):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    print('產生示範影片…')
    clip(SRC / 'team01_v1.mov', 45)
    clip(SRC / 'team02_v1.mp4', 12, audio=False)          # 沒有聲音 → 不合格
    clip(SRC / 'team02_v2.mov', 30, freq=660)              # 補件
    clip(DST.parent / 'land.mp4', 25, size='1920x1080', freq=880)
    ff('-display_rotation:v:0', '90', '-i', str(DST.parent / 'land.mp4'), '-c', 'copy', str(SRC / 'team03_v1.mov'))   # 直式
    (DST.parent / 'land.mp4').unlink()
    return pv.main(['--src', str(SRC), '--out', str(DST)])


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
