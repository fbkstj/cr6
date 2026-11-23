"""影片處理腳本：檢查學生影片原檔 → 轉成網頁播放版 → 更新影片清單。

用法（在專案資料夾執行；平常雙擊專案資料夾的「轉檔.bat」即可）：
    python tools/process_videos.py               處理 影片原檔/ 裡所有新的影片
    python tools/process_videos.py --check-only  只檢查，不轉檔、不改清單
    python tools/process_videos.py --only team01 只處理某一組

影片來源（兩種都可以）：
  1. 「專題組」「創意組」資料夾（影片原檔/ 底下任何一層，例如 影片原檔/115全國專題製作競賽校內初賽/專題組/）：
     檔名「專1_作品名稱.mp4」「創3_作品名稱.mov」→ 組別代碼 專N＝teamNN、創N＝team(50+N)（例如 專1＝team01、創1＝team51），
     作品名稱取自檔名、組別取自資料夾，寫進清單讓後台同步時自動建立組別。不用改檔名；
     同一組再放一支不同的檔案＝補件（自動成為下一個版本）。不要的檔案移到別的資料夾（例如「不使用」）。
  2. 影片原檔/ 最上層的 teamNN_vK.mp4／.mov（舊規則，例如 team01_v1.mov；補件 team01_v2.mov）。
輸出：videos/teamNN_vK.mp4（H.264／AAC，保留原檔解析度最高 1080p，每支 ≤ 75 MB）與 videos/manifest.json。腳本不會 git push，請確認報告後再推送。
設計依據：開發計畫書.md 第 10 節。
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ───── 試辦值（開發計畫書第 15 節） ─────
MAX_SOURCE_MB = 3072         # 原檔容量上限（老師 2026-11-23 由 500 MB 提高到 3 GB）
MAX_DURATION_SEC: float | None = None   # 長度上限（秒，四捨五入到 0.1 秒後比較）；None＝不限制（老師 2026-11-23 取消 10:00 限制，超長影片自動降解析度）
SHORT_SIDE = 1080            # 播放版短邊上限：保留原檔解析度，最高 1080p（不放大）
MAX_OUTPUT_MB = 75           # 播放版容量上限（老師 2026-11-19 指定；GitHub 單檔上限 100 MB）
DURATION_TOLERANCE = 0.5     # 播放版與原檔時長容許差距（秒）
MAX_VIDEO_KBPS = 8000        # 播放版影像碼率上限（畫質主要由 crf 決定，這只是保險）
AUDIO_KBPS = 128
MIN_VIDEO_KBPS = 120         # 再低畫面就看不清楚
# 解析度優先：可用的影像碼率要低於門檻（容量真的不夠）才降解析度（老師 2026-11-19：畫質盡量維持高解析度）
RES_MIN_KBPS = [(1080, 800), (720, 400), (480, 0)]


def encode_passes(duration: float, src_short: int = 1080) -> list[dict]:
    """依影片長度算出能用的碼率，讓播放版一定小於 MAX_OUTPUT_MB。
    解析度保留原檔（最高 1080p），只有碼率低於門檻時才降到 720p／480p。
    第一次品質優先（crf 22），萬一還是太大，第二次降到 70% 碼率、crf 26 重轉。
    很長的影片音訊降到 64k；連最低碼率都裝不下時回傳空清單（交給呼叫端報錯）。"""
    total = MAX_OUTPUT_MB * 0.92 * 8 * 1024 * 1024 / 1000 / max(duration, 1)   # 可用的總碼率（kbps）
    audio = AUDIO_KBPS if total - AUDIO_KBPS >= 400 else 64
    budget = int(total) - audio
    if budget < MIN_VIDEO_KBPS:
        return []
    top = min(MAX_VIDEO_KBPS, budget)
    low = max(MIN_VIDEO_KBPS, int(top * 0.7))
    short = 480
    for res, need in RES_MIN_KBPS:
        if top >= need:
            short = res
            break
    short = min(short, max(int(src_short or 0), 1)) if src_short else short   # 不放大
    return [
        {'crf': '22', 'maxrate': f'{top}k', 'bufsize': f'{top * 2}k', 'short': short, 'audio': audio},
        {'crf': '26', 'maxrate': f'{low}k', 'bufsize': f'{low * 2}k', 'short': short, 'audio': audio},
    ]

ROOT = Path(__file__).resolve().parent.parent
NAME_RE = re.compile(r'^(team\d{2})_v(\d+)\.(mp4|mov)$', re.IGNORECASE)
# 「專題組」「創意組」資料夾裡的檔名：專1_作品名稱.mp4、創3_作品名稱.mov
CAT_DIRS = {'專題組': ('專', 'project'), '創意組': ('創', 'creative')}
IMPORT_RE = re.compile(r'^(專|創)\s*(\d{1,2})\s*[_\-－、.．\s]\s*(.+?)\.(mp4|mov)$', re.IGNORECASE)
CREATIVE_BASE = 50           # 創N 的組別代碼＝team(50+N)


def team_code(prefix: str, n: int) -> str:
    return f'team{n:02d}' if prefix == '專' else f'team{CREATIVE_BASE + n:02d}'


def clean_title(raw: str) -> str:
    """檔名裡的作品名稱：底線換空白、去掉雲端硬碟重複下載加的 (1)"""
    t = re.sub(r'\s*[(（]\d+[)）]\s*$', '', raw).replace('_', ' ')
    return re.sub(r'\s+', ' ', t).strip()


def find_sources(src: Path) -> tuple[list[dict], list[tuple[str, str, str]]]:
    """列出要處理的影片：最上層的 teamNN_vK，以及任何一層「專題組」「創意組」資料夾裡的 專N_／創N_ 檔案。
    回傳（候選清單, 直接列入報告的略過／錯誤）"""
    items: list[dict] = []
    rows: list[tuple[str, str, str]] = []

    def skip(p: Path) -> bool:
        return p.name.startswith('.') or p.name.lower() == 'desktop.ini' or p.suffix.lower() in ('.part', '.tmp')

    for path in sorted(p for p in src.iterdir() if p.is_file() and not skip(p)):
        m = NAME_RE.match(path.name)
        if m:
            items.append({'path': path, 'label': path.name, 'team': m.group(1).lower(), 'version': int(m.group(2))})
        elif path.suffix.lower() in ('.mp4', '.mov'):
            rows.append((path.name, '略過', '檔名不符規則：放進「專題組」「創意組」資料夾並命名為 專1_作品名稱.mp4，或改名為 teamNN_vK.mp4'))
    for d in sorted(p for p in src.rglob('*') if p.is_dir() and p.name in CAT_DIRS):
        want, category = CAT_DIRS[d.name]
        for path in sorted(p for p in d.iterdir() if p.is_file() and not skip(p)):
            if path.suffix.lower() not in ('.mp4', '.mov'):
                continue
            label = f'{d.name}/{path.name}'
            m = IMPORT_RE.match(path.name)
            if not m:
                rows.append((label, '略過', f'檔名要以「{want}編號_」開頭，例如 {want}1_作品名稱{path.suffix}'))
                continue
            prefix, n = m.group(1), int(m.group(2))
            if prefix != want:
                rows.append((label, '錯誤', f'檔名是「{prefix}」開頭，卻放在「{d.name}」資料夾'))
                continue
            if not 1 <= n < CREATIVE_BASE:
                rows.append((label, '錯誤', f'編號 {n} 超出範圍（1～{CREATIVE_BASE - 1}）'))
                continue
            items.append({'path': path, 'label': label, 'team': team_code(prefix, n), 'version': None,
                          'title': clean_title(m.group(3)), 'category': category, 'no': f'{prefix}{n}'})
    return items, rows


# 完整解碼時可以放寬的 ffmpeg 訊息：時間戳記不連續（手機錄影、剪輯軟體匯出常見，畫面與聲音本身沒壞）。
# 老師 2026-11-23 決定放寬（創5 的 .MOV 因此被擋）；轉檔後仍會驗證播放版長度、音軌與影音長度一致。
BENIGN_DECODE_RE = re.compile(r'non[- ]?monoton\w*(?: increasing)? dts|non-monotonous dts', re.IGNORECASE)


def serious_decode_errors(lines: list[str]) -> list[str]:
    """解碼錯誤訊息裡，去掉可以放寬的時間戳記警告，剩下的才算影片有問題"""
    return [ln for ln in lines if ln.strip() and not BENIGN_DECODE_RE.search(ln)]


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def probe(path: Path) -> dict | None:
    r = run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)])
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def rotation_of(stream: dict) -> int:
    """手機直拍的影片常用「旋轉標記」記錄方向，回傳 0／90／180／270"""
    rot = 0
    for sd in stream.get('side_data_list', []) or []:
        if 'rotation' in sd:
            rot = int(round(float(sd['rotation'])))
    if not rot and 'rotate' in (stream.get('tags') or {}):
        rot = int(stream['tags']['rotate'])
    return rot % 360


def check_source(path: Path, limits: bool = True) -> tuple[dict, list[str]]:
    """回傳（影片資訊, 不合格原因清單）。原因清單是空的才算通過。
    limits=False（測試模式）：容量與長度超過上限只記在 info['warnings']，不算不合格。"""
    info: dict = {'warnings': []}
    problems: list[str] = []
    over = problems if limits else info['warnings']
    size = path.stat().st_size
    info['source_size'] = size
    if size > MAX_SOURCE_MB * 1024 * 1024:
        over.append(f'檔案 {size / 1024 / 1024:.0f} MB，超過上限 {MAX_SOURCE_MB} MB')

    p = probe(path)
    if p is None:
        problems.append('無法讀取影片（檔案損壞或不是影片）')
        return info, problems

    fmt = p.get('format', {})
    info['container'] = fmt.get('format_name', '')
    if 'mov' not in info['container'].split(','):
        problems.append(f'實際格式是 {info["container"] or "未知"}，不是 MP4／MOV')

    v = next((s for s in p.get('streams', []) if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic')), None)
    a = next((s for s in p.get('streams', []) if s.get('codec_type') == 'audio'), None)
    if v is None:
        problems.append('沒有影像')
    else:
        rot = rotation_of(v)
        w, h = int(v.get('width') or 0), int(v.get('height') or 0)
        if rot in (90, 270):
            w, h = h, w
        info.update(vcodec=v.get('codec_name', ''), width=w, height=h, rotation=rot)
    if a is None:
        problems.append('沒有聲音（音軌）')
    else:
        info['acodec'] = a.get('codec_name', '')

    try:
        duration = float(fmt.get('duration'))
    except (TypeError, ValueError):
        duration = None
    info['duration_sec'] = round(duration, 2) if duration is not None else None
    if duration is None:
        problems.append('讀不到影片長度')
    elif MAX_DURATION_SEC is not None and round(duration, 1) > MAX_DURATION_SEC:
        over.append(f'長度 {fmt_dur(duration)}，超過 {fmt_dur(MAX_DURATION_SEC)}')

    if not problems:
        # 完整解碼一次，確認中間沒有壞掉的片段
        r = run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
        lines = [ln for ln in r.stderr.splitlines() if ln.strip()]
        errors = serious_decode_errors(lines)
        if r.returncode != 0 or errors:
            problems.append('解碼時發生錯誤：' + (errors[0][:120] if errors else f'結束碼 {r.returncode}'))
        elif lines:
            info['notes'] = [f'解碼時有 {len(lines)} 則時間戳記不連續的警告（已放寬；播放版已驗證長度與影音一致）']
    return info, problems


def encode(src: Path, dst: Path, params: dict) -> subprocess.CompletedProcess:
    # 先依旋轉標記轉正（ffmpeg 預設會做），再把短邊縮到指定值（最高 1080），不放大
    short = params.get('short', SHORT_SIDE)
    vf = (f"scale='if(gt(iw,ih),-2,min({short},iw))':'if(gt(iw,ih),min({short},ih),-2)',"
          "format=yuv420p")
    return run([
        'ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(src),
        '-map', '0:v:0', '-map', '0:a:0', '-vf', vf,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', params['crf'],
        '-maxrate', params['maxrate'], '-bufsize', params['bufsize'], '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', f"{params.get('audio', AUDIO_KBPS)}k", '-ac', '2',
        '-movflags', '+faststart', str(dst),
    ])


def make_playback(src: Path, dst: Path, source_duration: float, src_short: int = 1080) -> tuple[dict, list[str]]:
    tmp = dst.with_suffix('.tmp.mp4')
    last_problem = ''
    passes = encode_passes(source_duration, src_short)
    if not passes:
        return {}, [f'影片 {fmt_dur(source_duration)} 太長，播放版無法控制在 {MAX_OUTPUT_MB} MB 內']
    for params in passes:
        r = encode(src, tmp, params)
        if r.returncode != 0:
            last_problem = '轉檔失敗：' + (r.stderr.strip().splitlines() or ['未知錯誤'])[-1][:160]
            continue
        p = probe(tmp) or {}
        out_dur = float((p.get('format') or {}).get('duration') or 0)
        size = tmp.stat().st_size
        has_audio = any(s.get('codec_type') == 'audio' for s in p.get('streams', []))
        v = next((s for s in p.get('streams', []) if s.get('codec_type') == 'video'), {})
        if abs(out_dur - source_duration) > DURATION_TOLERANCE:
            last_problem = f'播放版長度 {out_dur:.2f} 秒與原檔 {source_duration:.2f} 秒不符'
            continue
        if not has_audio:
            last_problem = '播放版沒有聲音'
            continue
        durs = {st.get('codec_type'): float(st.get('duration') or 0) for st in p.get('streams', []) if st.get('codec_type') in ('video', 'audio')}
        if durs.get('video') and durs.get('audio') and abs(durs['video'] - durs['audio']) > DURATION_TOLERANCE:
            last_problem = f'播放版影像 {durs["video"]:.2f} 秒與聲音 {durs["audio"]:.2f} 秒長度不一致'
            continue
        if size > MAX_OUTPUT_MB * 1024 * 1024:
            last_problem = f'播放版 {size / 1024 / 1024:.0f} MB，超過 {MAX_OUTPUT_MB} MB'
            continue
        tmp.replace(dst)
        return {'playback_size': size, 'playback_width': int(v.get('width') or 0),
                'playback_height': int(v.get('height') or 0), 'playback_duration': round(out_dur, 2)}, []
    tmp.unlink(missing_ok=True)
    return {}, [last_problem or '轉檔失敗']


def fmt_dur(sec: float | None) -> str:
    if sec is None:
        return '-'
    s = int(round(sec))
    return f'{s // 60}:{s % 60:02d}'


def load_manifest(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    return {'format': 1, 'versions': []}


def save_manifest(path: Path, manifest: dict) -> None:
    manifest['updated_at'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    manifest['versions'].sort(key=lambda x: (x['team'], x['version']))
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='檢查學生影片並轉成網頁播放版')
    ap.add_argument('--src', type=Path, default=ROOT / '影片原檔', help='原檔資料夾（預設：影片原檔/）')
    ap.add_argument('--out', type=Path, default=ROOT / 'videos', help='播放版輸出資料夾（預設：videos/）')
    ap.add_argument('--only', help='只處理某一組，例如 team01')
    ap.add_argument('--check-only', action='store_true', help='只檢查，不轉檔、不改清單')
    ap.add_argument('--no-limits', action='store_true', help='測試模式：容量與長度超過上限不擋，只在清單註記')
    args = ap.parse_args(argv)

    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            print(f'找不到 {tool}，請先安裝 ffmpeg 並加入 PATH')
            return 2
    if not args.src.is_dir():
        print(f'找不到原檔資料夾：{args.src}')
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / 'manifest.json'
    manifest = load_manifest(manifest_path)
    by_sha = {v['source_sha256']: v for v in manifest['versions']}
    by_key = {(v['team'], v['version']): v for v in manifest['versions']}

    items, rows = find_sources(args.src)   # rows：（檔名, 結果, 說明）
    if args.only:
        items = [it for it in items if it['team'] == args.only.lower()]
    for it in items:
        it['sha'] = sha256_of(it['path'])
    # 「專題組／創意組」資料夾：同一組這次有兩支以上不同的新檔案 → 不知道要用哪一支，全部擋下
    fresh: dict[str, set[str]] = {}
    for it in items:
        if it['version'] is None and it['sha'] not in by_sha:
            fresh.setdefault(it['team'], set()).add(it['sha'])
    seen_sha: set[str] = set()
    for it in items:
        path, team, sha, label = it['path'], it['team'], it['sha'], it['label']
        t0 = time.time()
        if sha in by_sha:
            old = by_sha[sha]
            same = old['team'] == team and (it['version'] is None or old['version'] == it['version'])
            rows.append((label, '略過', f'已處理過（{old["team"]}_v{old["version"]}）' if same else f'和 {old["team"]}_v{old["version"]} 是同一支檔案'))
            continue
        if sha in seen_sha:
            rows.append((label, '略過', '和這次另一支檔案內容相同'))
            continue
        seen_sha.add(sha)
        if it['version'] is None and len(fresh.get(team, ())) > 1:
            rows.append((label, '錯誤', f'{it["no"]} 這次有 {len(fresh[team])} 支不同的檔案，請只留一支（其他移到「不使用」資料夾）'))
            continue
        if it['version'] is None:   # 專N／創N：新的一組是 v1；已經有版本就是補件（下一個版本）
            it['version'] = max([v['version'] for v in manifest['versions'] if v['team'] == team] or [0]) + 1
        version = it['version']
        if (team, version) in by_key:
            rows.append((label, '錯誤', f'{team}_v{version} 已經有別的檔案；補件請改用新的版本號（例如 _v{version + 1}）'))
            continue
        if it.get('no'):
            label = f'{label} → {team}_v{version}'

        info, problems = check_source(path, limits=not args.no_limits)
        warnings = info.get('warnings', [])
        entry = {
            'team': team, 'version': version, 'source_filename': path.name, 'source_sha256': sha,
            'title': it.get('title'), 'category': it.get('category'),
            'source_size': info.get('source_size'), 'duration_sec': info.get('duration_sec'),
            'container': info.get('container'), 'vcodec': info.get('vcodec'), 'acodec': info.get('acodec'),
            'width': info.get('width'), 'height': info.get('height'), 'rotation': info.get('rotation', 0),
            'check_ok': not problems, 'check_notes': '；'.join(problems), 'playback_path': None, 'playback_size': None,
        }
        warn_text = '；'.join(info.get('notes', []) + ([('（測試模式未擋）' + '；'.join(warnings))] if warnings else []))
        if not problems and warn_text:
            entry['check_notes'] = warn_text
        if not problems and not args.check_only:
            out_name = f'{team}_v{version}.mp4'
            src_short = min(info.get('width') or 1080, info.get('height') or 1080)
            pb, enc_problems = make_playback(path, args.out / out_name, info['duration_sec'], src_short)
            if enc_problems:
                entry['check_ok'] = False
                entry['check_notes'] = '；'.join(enc_problems)
            else:
                entry.update(playback_path=f'videos/{out_name}', playback_size=pb['playback_size'],
                             playback_width=pb['playback_width'], playback_height=pb['playback_height'])
        entry['processed_at'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
        secs = time.time() - t0
        if args.check_only:
            rows.append((label, '合格' if not problems else '不合格', '；'.join(problems) or f'長度 {fmt_dur(info.get("duration_sec"))}，{info.get("vcodec")}／{info.get("acodec")}，{info.get("width")}x{info.get("height")}' + (f'，{warn_text}' if warn_text else '')))
            continue
        manifest['versions'].append(entry)
        by_sha[sha] = entry
        by_key[(team, version)] = entry
        save_manifest(manifest_path, manifest)   # 每處理完一支就存檔，中途中斷也不會遺失
        if entry['check_ok']:
            rows.append((label, '完成', f'長度 {fmt_dur(entry["duration_sec"])}，原檔 {entry["source_size"] / 1048576:.0f} MB → 播放版 {entry["playback_size"] / 1048576:.1f} MB（{entry["playback_width"]}x{entry["playback_height"]}），{secs:.0f} 秒' + (f'；{warn_text}' if warn_text else '')))
        else:
            rows.append((label, '不合格', entry['check_notes']))

    print('\n影片處理報告')
    print('─' * 60)
    if not rows:
        print('沒有要處理的影片')
    for name, status, note in rows:
        print(f'{status:<4} {name}  {note}')
    print('─' * 60)
    if not args.check_only and any(s in ('完成', '不合格') for _, s, _ in rows):
        print('清單已更新：' + str(manifest_path.relative_to(ROOT) if manifest_path.is_relative_to(ROOT) else manifest_path))
        print('確認無誤後推送（轉檔.bat 會詢問；推送＝公開）；推送後到後台按「同步影片清單」，勾選要建立的組別。')
    return 1 if any(s == '錯誤' for _, s, _ in rows) else 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
