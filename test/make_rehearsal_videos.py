"""P6 整體演練用的影片（合成畫面，不含真實學生影片）：python test/make_rehearsal_videos.py <階段>

階段 1：第一次收件
  team01_v1  正常
  team02_v1  沒有聲音（檔案檢查不合格）→ team02_v2 重交
  team03_v1  正常（之後會被資格審查退回補件）
  team04_v1  正常（之後資格審查不通過）
階段 2：補件
  team03_v2  補件後的新版本

影片放在 test/out/rehearsal_src/，播放版與清單輸出到 test/out/rehearsal_videos/（都不會推上 GitHub）。
用正式的 tools/process_videos.py 處理。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test' / 'out'
SRC, DST = OUT / 'rehearsal_src', OUT / 'rehearsal_videos'
sys.path.insert(0, str(ROOT / 'tools'))
import process_videos as pv  # noqa: E402


def clip(path: Path, sec: int, audio: bool = True, freq: int = 440, size: str = '1280x720') -> None:
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', f'testsrc2=s={size}:r=30:d={sec}']
    if audio:
        args += ['-f', 'lavfi', '-i', f'sine=f={freq}:r=48000:d={sec}']
    args += ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
    if audio:
        args += ['-c:a', 'aac', '-b:a', '96k']
    subprocess.run(args + [str(path)], check=True)


def main() -> int:
    stage = sys.argv[1] if len(sys.argv) > 1 else '1'
    if stage == '1':
        for d in (SRC, DST):
            shutil.rmtree(d, ignore_errors=True)
            d.mkdir(parents=True)
        clip(SRC / 'team01_v1.mov', 20, freq=440)
        clip(SRC / 'team02_v1.mp4', 12, audio=False)
        clip(SRC / 'team02_v2.mov', 18, freq=550)
        clip(SRC / 'team03_v1.mov', 15, freq=660)
        clip(SRC / 'team04_v1.mp4', 16, freq=770, size='1920x1080')
    elif stage == '2':
        clip(SRC / 'team03_v2.mov', 22, freq=880)
    else:
        print('階段只能是 1 或 2')
        return 2
    return pv.main(['--src', str(SRC), '--out', str(DST)])


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
