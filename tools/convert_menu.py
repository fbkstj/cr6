"""一鍵轉檔選單（由專案資料夾的「轉檔.bat」啟動）：檢查 → 轉檔 → 確認後推送到網站。

中文選單、提示都在這裡用 Python 顯示（cmd 的 .bat 處理 UTF-8 中文會掉字、亂碼，所以 .bat 只放英文）。
推送＝公開發布：一定先列出 videos/ 的變更，按 Y 才推送；只會加入、提交 videos/ 資料夾。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))


def line(ch: str = '=') -> None:
    print(ch * 60)


def ask(prompt: str, choices: str) -> str:
    """讀一個選項（不分大小寫）；輸入結束（例如視窗被關）就當作離開"""
    while True:
        try:
            ans = input(prompt).replace('﻿', '').strip().upper()   # 去掉輸入開頭可能夾帶的 BOM
        except EOFError:
            return 'Q'
        if ans and ans[0] in choices:
            return ans[0]
        print(f'請輸入 {"、".join(choices)} 其中一個。')


def find_ffmpeg() -> bool:
    """PATH 裡沒有 ffmpeg 就找 winget 安裝的位置，找到就加進 PATH"""
    if shutil.which('ffmpeg') and shutil.which('ffprobe'):
        return True
    base = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
    for exe in sorted(base.glob('Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe')):
        os.environ['PATH'] = str(exe.parent) + os.pathsep + os.environ.get('PATH', '')
        return bool(shutil.which('ffprobe'))
    return False


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')


def push() -> None:
    print()
    if not shutil.which('git'):
        print('找不到 git，沒辦法推送。影片已經轉好；請 Claude 協助推送。')
        return
    st = git('status', '--porcelain', '--', 'videos')
    if st.returncode != 0:
        print('讀不到 git 狀態：' + (st.stderr.strip() or st.stdout.strip()))
        return
    changes = [ln for ln in st.stdout.splitlines() if ln.strip()]
    if not changes:
        print('沒有需要推送的影片（videos 資料夾沒有變更）。')
        return
    kind = {'??': '新增', 'A': '新增', 'M': '更新', 'D': '刪除'}
    line()
    print('  以下影片的變更會推送到網站（推送後所有人都看得到）：')
    line()
    for ln in changes:
        code, name = ln[:2].strip(), ln[3:].strip().strip('"')
        print(f'  {kind.get(code, code):<4} {name}')
    print()
    if ask('確定要推送到網站嗎？（Y＝推送，N＝先不要）：', 'YN') != 'Y':
        print('沒有推送。之後可以再雙擊「轉檔.bat」選 [3] 推送。')
        return
    for step, args in (('加入', ('add', '-A', '--', 'videos')),
                       ('提交', ('commit', '-q', '-m', '轉檔.bat：更新影片', '--', 'videos')),
                       ('推送', ('push', '-q'))):
        r = git(*args)
        if r.returncode != 0:
            print(f'\n推送失敗（{step}）：')
            print((r.stderr or r.stdout).strip()[-800:])
            print('\n影片已經轉好，不會遺失；請把這個畫面截圖給 Claude 處理。')
            return
    print()
    line()
    print('  推送完成。')
    print('  等 1～2 分鐘網站更新後，到後台「競賽階段」按「同步影片清單」，')
    print('  確認要建立的組別，按「建立組別並同步」。')
    line()


def main() -> int:
    if not (ROOT / '影片原檔').is_dir():
        print(f'找不到「影片原檔」資料夾：{ROOT / "影片原檔"}')
        return 2
    if not find_ffmpeg():
        print('找不到 ffmpeg。請在 PowerShell 執行：winget install --id Gyan.FFmpeg --exact --source winget')
        print('裝好後關掉這個視窗，再重新雙擊「轉檔.bat」。')
        return 2
    import process_videos as pv
    while True:
        print()
        line()
        print('  一鍵轉檔：學生影片 → 網頁播放版 → 推送到網站')
        line()
        print(f'  原始影片：{ROOT / "影片原檔"}')
        print('  放法：任何一層的「專題組」「創意組」資料夾，')
        print('        檔名 專1_作品名稱.mp4、創3_作品名稱.mov（不用改名）')
        print('        專N＝team0N、創N＝team5N；同一組再放新的檔案＝補件；')
        print('        不要的檔案移到「不使用」資料夾。')
        print('  已經轉過的影片會自動略過，可以放心重複執行。')
        print()
        print('  [1] 只檢查（不轉檔，先看看有沒有問題）')
        print('  [2] 轉檔，完成後詢問是否推送到網站')
        print('  [3] 只推送（已經轉好、還沒推送的影片）')
        print('  [Q] 離開')
        print()
        c = ask('請輸入 1、2、3 或 Q，再按 Enter：', '123Q')
        if c == 'Q':
            return 0
        if c == '1':
            print('\n檢查中（每支影片都會完整讀一遍，需要一點時間）……')
            pv.main(['--check-only'])
            print('\n「合格」的影片可以選 [2] 轉檔；「不合格」「錯誤」的請看後面的說明處理。')
        elif c == '2':
            print('\n轉檔中（大約是影片長度的 0.5～1 倍時間；中途關掉視窗沒關係，下次會從沒轉完的繼續）……')
            if pv.main([]) == 2:
                return 2
            print('\n請看上面的報告：「完成」＝已產生播放版；「不合格」「錯誤」＝沒有轉檔（原因寫在後面）。')
            push()
        else:
            push()


if __name__ == '__main__':
    if not sys.stdout.isatty() and hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    code = 1
    try:
        code = main()
    except KeyboardInterrupt:
        print('\n已中斷。')
    except Exception as e:   # 不要讓視窗一閃就關掉，看不到錯誤
        print(f'\n發生錯誤：{e!r}\n請把這個畫面截圖給 Claude。')
    try:
        input('\n按 Enter 關閉視窗…')
    except EOFError:
        pass
    sys.exit(code)
