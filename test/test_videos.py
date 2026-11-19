"""影片處理腳本的自動測試（P2 驗收）：python test/test_videos.py

用 ffmpeg 產生合成測試片（不含任何真實學生影片），放在系統暫存資料夾，測完自動刪除。
驗收項目：9:59、10:00 可收；10:01 拒收；無音軌、損壞檔、格式不符拒收；直式影片方向正確；
MOV 轉出的 MP4 時長一致、每秒白閃與嗶聲仍然對齊（音畫同步）；重跑不重複處理；同版本換檔會報錯。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import process_videos as pv  # noqa: E402

passed = 0


def ok(name: str) -> None:
    global passed
    passed += 1
    print('  ✓', name)


def ff(*args: str) -> None:
    r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError('ffmpeg 失敗：' + r.stderr[-400:])


def clip(path: Path, sec: float, size: str = '320x240', rate: int = 10, audio: bool = True, extra: list[str] | None = None) -> None:
    """產生測試片：彩色測試圖＋440Hz 音"""
    args = ['-f', 'lavfi', '-i', f'testsrc2=s={size}:r={rate}:d={sec}']
    if audio:
        args += ['-f', 'lavfi', '-i', f'sine=f=440:r=48000:d={sec}']
    args += ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    if audio:
        args += ['-c:a', 'aac', '-b:a', '64k']
    args += (extra or []) + [str(path)]
    ff(*args)


def flash_beep_clip(path: Path, sec: int = 20) -> None:
    """音畫同步測試片：每秒開頭 0.1 秒白畫面＋同時 1000Hz 嗶聲，其餘黑畫面、靜音（1080p 30fps MOV）"""
    ff('-f', 'lavfi', '-i', f'color=black:s=1920x1080:r=30:d={sec}',
       '-f', 'lavfi', '-i', f"aevalsrc='if(lt(mod(t,1),0.1),0.8*sin(2*PI*1000*t),0)':s=48000:d={sec}",
       '-vf', "drawbox=c=white:t=fill:enable='lt(mod(t,1),0.1)'",
       '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', str(path))


def flash_times(path: Path, workdir: Path) -> list[float]:
    """畫面由暗變亮的時間點"""
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-vf',
                    'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=yavg.txt', '-an', '-f', 'null', '-'],
                   cwd=workdir, capture_output=True, check=True)
    times, cur, prev = [], None, 0.0
    for line in (workdir / 'yavg.txt').read_text().splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m:
            cur = float(m.group(1))
        m = re.search(r'YAVG=([\d.]+)', line)
        if m and cur is not None:
            y = float(m.group(1))
            if y > 128 >= prev:
                times.append(cur)
            prev = y
    return times


def beep_times(path: Path) -> list[float]:
    """嗶聲開始的時間點（靜音結束處）"""
    r = subprocess.run(['ffmpeg', '-nostdin', '-i', str(path), '-af', 'silencedetect=n=-30dB:d=0.05', '-vn', '-f', 'null', '-'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return [float(x) for x in re.findall(r'silence_end: ([\d.]+)', r.stderr)]


def run_script(src: Path, out: Path, *extra: str) -> tuple[int, dict]:
    code = pv.main(['--src', str(src), '--out', str(out), *extra])
    mpath = out / 'manifest.json'
    manifest = json.loads(mpath.read_text(encoding='utf-8')) if mpath.exists() else {'versions': []}
    return code, {(v['team'], v['version']): v for v in manifest['versions']}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix='contest-video-test-'))
    try:
        src, out = tmp / 'src', tmp / 'out'
        src.mkdir()
        print('產生合成測試片…')
        clip(src / 'team01_v1.mov', 599)                       # 9:59
        clip(src / 'team02_v1.mp4', 600)                       # 剛好 10:00
        clip(src / 'team03_v1.mov', 601)                       # 10:01
        clip(src / 'team04_v1.mp4', 3, audio=False)            # 沒有聲音
        clip(tmp / 'whole.mp4', 5)
        data = (tmp / 'whole.mp4').read_bytes()
        (src / 'team05_v1.mov').write_bytes(data[: len(data) // 2])   # 損壞（只有前半段）
        clip(src / 'team06_v1.mov', 3, extra=['-f', 'matroska'])       # 副檔名 .mov，實際是 MKV
        clip(tmp / 'land.mp4', 4, size='1920x1080', rate=30)
        ff('-display_rotation:v:0', '90', '-i', str(tmp / 'land.mp4'), '-c', 'copy', str(src / 'team07_v1.mov'))  # 手機直拍（旋轉標記）
        flash_beep_clip(src / 'team08_v1.mov')                 # 音畫同步測試
        (src / 'readme.txt').write_text('not a video')
        shutil.copy(src / 'team04_v1.mp4', src / 'abc.mp4')    # 檔名不符規則

        print('第一次執行腳本…')
        code, v = run_script(src, out)
        assert code == 0, f'結束碼應為 0，實際 {code}'
        ok('第一次執行正常結束')

        assert v[('team01', 1)]['check_ok'] and v[('team02', 1)]['check_ok']
        ok('9:59 與剛好 10:00 都可以收')
        assert not v[('team03', 1)]['check_ok'] and '超過 10:00' in v[('team03', 1)]['check_notes']
        assert v[('team03', 1)]['playback_path'] is None and not (out / 'team03_v1.mp4').exists()
        ok('10:01 拒收，不產生播放檔')
        assert not v[('team04', 1)]['check_ok'] and '沒有聲音' in v[('team04', 1)]['check_notes']
        ok('沒有音軌拒收')
        assert not v[('team05', 1)]['check_ok']
        ok('損壞檔拒收：' + v[('team05', 1)]['check_notes'][:30])
        assert not v[('team06', 1)]['check_ok'] and '不是 MP4' in v[('team06', 1)]['check_notes']
        ok('副檔名與實際格式不符拒收')
        assert ('abc', 1) not in v and len(v) == 8
        ok('檔名不符規則的檔案略過，不進清單')

        t7 = v[('team07', 1)]
        assert t7['check_ok'] and t7['rotation'] in (90, 270), t7
        assert t7['playback_width'] == 1080 and t7['playback_height'] == 1920, t7
        r = pv.probe(out / 'team07_v1.mp4')
        vs = next(s for s in r['streams'] if s['codec_type'] == 'video')
        assert pv.rotation_of(vs) == 0, '播放版不應再帶旋轉標記'
        ok('直式影片轉正：播放版保留 1080x1920，沒有殘留旋轉標記')

        t8 = v[('team08', 1)]
        assert t8['check_ok'] and t8['playback_width'] == 1920 and t8['playback_height'] == 1080, t8
        pb = out / 'team08_v1.mp4'
        p = pv.probe(pb)
        assert abs(float(p['format']['duration']) - t8['duration_sec']) <= 0.1
        codecs = sorted(s['codec_name'] for s in p['streams'])
        assert codecs == ['aac', 'h264'], codecs
        ok('MOV 轉成 H.264／AAC 的 MP4，保留 1080p 原解析度，時長一致')

        fl, bp = flash_times(pb, tmp), beep_times(pb)
        assert len(fl) >= 19, f'白閃次數太少：{len(fl)}'
        diffs = [min(abs(f - b) for b in bp) for f in fl if f > 0.5]
        worst = max(diffs)
        assert worst <= 0.05, f'音畫最大差距 {worst * 1000:.0f} ms'
        ok(f'音畫同步：{len(diffs)} 次白閃與嗶聲最大差距 {worst * 1000:.0f} ms（≤ 50 ms）')
        assert [round(f) for f in fl[:5]] == [0, 1, 2, 3, 4]
        ok('播放速度正確：白閃仍在每秒整數位置')

        assert v[('team02', 1)]['playback_path'] == 'videos/team02_v1.mp4'
        assert all(x['source_sha256'] and len(x['source_sha256']) == 64 for x in v.values())
        manifest_text = (out / 'manifest.json').read_text(encoding='utf-8')
        assert str(tmp) not in manifest_text and 'src' not in json.loads(manifest_text)
        ok('清單記錄 sha256 與相對路徑，不含電腦上的資料夾路徑')

        print('第二次執行（沒有新檔案）…')
        before = {f.name: f.stat().st_mtime for f in out.iterdir()}
        code, v2 = run_script(src, out)
        assert code == 0 and v2 == v
        assert {f.name: f.stat().st_mtime for f in out.iterdir() if f.name != 'manifest.json'} == {k: t for k, t in before.items() if k != 'manifest.json'}
        ok('重跑不會重複處理、不會重新轉檔')

        shutil.copy(src / 'team01_v1.mov', src / 'team09_v1.mov')
        code, v3 = run_script(src, out)
        assert ('team09', 1) not in v3
        ok('同一支檔案換名字不會變成新版本')
        (src / 'team09_v1.mov').unlink()

        clip(src / 'team01_v1.mov', 30)   # 同一個版本號換了內容
        code, v4 = run_script(src, out)
        assert code == 1 and v4[('team01', 1)] == v[('team01', 1)]
        ok('同一版本號換了不同檔案會報錯，清單不被覆蓋')

        clip(src / 'team01_v2.mov', 30)
        (src / 'team01_v1.mov').unlink()
        code, v5 = run_script(src, out, '--only', 'team01')
        assert code == 0 and v5[('team01', 2)]['check_ok'] and ('team01', 1) in v5
        ok('補件 _v2 建立新版本，舊版本紀錄保留')

        code, _ = run_script(src, out, '--check-only')
        ok('--check-only 可以執行')

        p600 = pv.encode_passes(600)
        top = int(p600[0]['maxrate'].rstrip('k'))
        est_mb = (top + pv.AUDIO_KBPS) * 1000 * 600 / 8 / 1048576
        assert est_mb < pv.MAX_OUTPUT_MB, est_mb
        ok(f'10 分鐘影片的碼率上限 {top} kbps，最大約 {est_mb:.0f} MB（< {pv.MAX_OUTPUT_MB} MB）')

        # 測試模式（--no-limits）：超過 10:00 不擋，只在清單註記
        nl_src, nl_out = tmp / 'nolimit', tmp / 'nolimit_out'
        nl_src.mkdir()
        clip(nl_src / 'team11_v1.mov', 601)
        code, vn = run_script(nl_src, nl_out, '--no-limits')
        t11 = vn[('team11', 1)]
        assert code == 0 and t11['check_ok'], t11
        assert '測試模式未擋' in t11['check_notes'] and '超過 10:00' in t11['check_notes'], t11['check_notes']
        assert (nl_out / 'team11_v1.mp4').exists()
        ok('測試模式：10:01 的影片照樣轉檔，清單註記「測試模式未擋」')

        expect = {6: 1080, 10: 1080, 15: 720, 30: 480}   # 解析度優先：碼率真的不夠才降
        for minutes, res in expect.items():
            ps = pv.encode_passes(minutes * 60)
            mb = (int(ps[0]['maxrate'].rstrip('k')) + ps[0]['audio']) * 1000 * minutes * 60 / 8 / 1048576
            assert ps and mb < pv.MAX_OUTPUT_MB and ps[0]['short'] == res, (minutes, ps)
            ok(f'{minutes} 分鐘影片：{ps[0]["short"]}p、影像 {ps[0]["maxrate"]}、音訊 {ps[0]["audio"]}k，最大約 {mb:.0f} MB（上限 {pv.MAX_OUTPUT_MB} MB）')
        assert pv.encode_passes(300, 720)[0]['short'] == 720, '原檔 720p 不會被放大'
        assert pv.encode_passes(300, 2160)[0]['short'] == 1080, '4K 原檔縮到 1080p'
        ok('不放大：720p 原檔維持 720p；4K 原檔縮到 1080p')
        assert pv.encode_passes(60 * 60) == []
        ok(f'超長影片（60 分鐘）連最低碼率都裝不下時明確回報，不會產生超過 {pv.MAX_OUTPUT_MB} MB 的檔案')

        print('壓力測試：15 秒全畫面雜訊（最難壓縮）…')
        noise_src = tmp / 'noise'
        noise_src.mkdir()
        ff('-f', 'lavfi', '-i', 'nullsrc=s=1280x720:r=30:d=15,geq=lum=random(1)*255:cb=128:cr=128',
           '-f', 'lavfi', '-i', 'anoisesrc=d=15:c=white:a=0.3',
           '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '20M', '-maxrate', '20M', '-bufsize', '20M',
           '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(noise_src / 'team10_v1.mov'))
        code, vn = run_script(noise_src, tmp / 'noise_out')
        t10 = vn[('team10', 1)]
        assert t10['check_ok'], t10
        kbps = t10['playback_size'] * 8 / 1000 / t10['duration_sec']
        limit = int(pv.encode_passes(t10['duration_sec'], 720)[0]['maxrate'].rstrip('k')) + pv.AUDIO_KBPS
        assert kbps <= limit * 1.1, f'實際 {kbps:.0f} kbps 超過上限 {limit} kbps'
        ok(f'雜訊畫面實際 {kbps:.0f} kbps，有被碼率上限 {limit} kbps 擋住')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f'\n全部通過：{passed} 項')
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
