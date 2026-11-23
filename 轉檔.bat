@echo off
chcp 65001 >nul
setlocal
title 一鍵轉檔：學生影片 → 網頁播放版 → 推送到網站
rem 雙擊執行：檢查「影片原檔」裡的學生影片，轉成 videos/ 的網頁播放版並更新清單，確認後推送到網站。
rem 推送＝公開發布，一定會先問。說明見 tools\README.md。
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"

rem ── 找 Python（py → python → PlatformIO 附的 Python）──
set "PYEXE="
set "PYARG="
py -3 -c "import sys" >nul 2>&1 && (set "PYEXE=py" & set "PYARG=-3")
if not defined PYEXE python -c "import sys" >nul 2>&1 && set "PYEXE=python"
if not defined PYEXE if exist "%USERPROFILE%\.platformio\penv\Scripts\python.exe" set "PYEXE=%USERPROFILE%\.platformio\penv\Scripts\python.exe"
if not defined PYEXE goto nopython

rem ── 找 ffmpeg（PATH 裡沒有就找 winget 安裝的位置）──
where ffmpeg >nul 2>&1 && goto haveffmpeg
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do for /d %%E in ("%%D\ffmpeg-*") do if exist "%%E\bin\ffmpeg.exe" set "FFBIN=%%E\bin"
if not defined FFBIN goto noffmpeg
set "PATH=%FFBIN%;%PATH%"
:haveffmpeg

if not exist "影片原檔\" goto nosrc

:menu
echo.
echo ============================================================
echo   一鍵轉檔：學生影片 → 網頁播放版 → 推送到網站
echo ============================================================
echo   原始影片：%~dp0影片原檔
echo   放法：任何一層的「專題組」「創意組」資料夾，檔名 專1_作品名稱.mp4、創3_作品名稱.mov
echo         （專N＝team0N、創N＝team5N；同一組再放新的檔案＝補件；不要的檔案移到「不使用」資料夾）
echo   已經轉過的影片會自動略過，可以放心重複執行。
echo.
echo   [1] 只檢查（不轉檔，先看看有沒有問題）
echo   [2] 轉檔，完成後詢問是否推送到網站
echo   [3] 只推送（已經轉好、還沒推送的影片）
echo   [Q] 離開
echo.
choice /c 123Q /n /m "請按 1、2、3 或 Q："
if errorlevel 4 goto end
if errorlevel 3 goto push
if errorlevel 2 goto convert
if errorlevel 1 goto check
goto menu

:check
echo.
echo 檢查中（每支影片都會完整讀一遍，需要一點時間）……
"%PYEXE%" %PYARG% tools\process_videos.py --check-only
echo.
echo 「合格」的影片可以回到選單按 [2] 轉檔；「不合格」「錯誤」的請看說明處理。
goto menu

:convert
echo.
echo 轉檔中（大約是影片長度的 0.5～1 倍時間；中途關掉視窗沒關係，下次會從沒轉完的繼續）……
"%PYEXE%" %PYARG% tools\process_videos.py
if errorlevel 2 goto end
echo.
echo 請看上面的報告：「完成」＝已產生播放版；「不合格」「錯誤」＝沒有轉檔（原因寫在後面）。
goto push

:push
echo.
where git >nul 2>&1 || goto nogit
git status --porcelain -- videos > "%TEMP%\cr6_push.txt"
for %%A in ("%TEMP%\cr6_push.txt") do if %%~zA==0 goto nothing
echo ============================================================
echo   以下影片的變更會推送到網站（推送後所有人都看得到）：
echo ============================================================
type "%TEMP%\cr6_push.txt"
echo   （A＝新增、M＝修改、D＝刪除、??＝新檔案）
echo.
choice /c YN /n /m "確定要推送到網站嗎？（Y＝推送，N＝先不要）："
if errorlevel 2 goto notpushed
git add -A -- videos || goto pushfail
git commit -q -m "轉檔.bat：更新影片" -- videos || goto pushfail
git push -q || goto pushfail
echo.
echo ============================================================
echo   推送完成。
echo   等 1～2 分鐘網站更新後，到後台「競賽階段」按「同步影片清單」，
echo   勾選要建立的組別，按「建立組別並同步」。
echo ============================================================
goto end

:nothing
echo 沒有需要推送的影片（videos 資料夾沒有變更）。
goto end
:notpushed
echo 沒有推送。之後可以再雙擊「轉檔.bat」按 [3] 推送。
goto end
:pushfail
echo.
echo 推送失敗（上面有錯誤訊息）。影片已經轉好，不會遺失；請把畫面截圖給 Claude 處理。
goto end
:nogit
echo 找不到 git，沒辦法推送。影片已經轉好；請 Claude 協助推送。
goto end
:nopython
echo 找不到 Python。請安裝 Python 3（https://www.python.org/）或請 Claude 協助。
goto end
:noffmpeg
echo 找不到 ffmpeg。請在 PowerShell 執行：winget install --id Gyan.FFmpeg --exact --source winget
echo 裝好後關掉這個視窗，再重新雙擊「轉檔.bat」。
goto end
:nosrc
echo 找不到「影片原檔」資料夾：%~dp0影片原檔
goto end

:end
echo.
pause
endlocal
