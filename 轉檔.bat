@echo off
rem One-click video conversion launcher. Double-click this file.
rem It only finds Python and starts tools\convert_menu.py (the Chinese menu is shown by Python,
rem because cmd.exe cannot reliably display UTF-8 Chinese text from a .bat file).
setlocal
cd /d "%~dp0"
title cr6 video conversion

set "PYEXE="
set "PYARG="
py -3 -c "import sys" >nul 2>&1 && (set "PYEXE=py" & set "PYARG=-3")
if not defined PYEXE python -c "import sys" >nul 2>&1 && set "PYEXE=python"
if not defined PYEXE if exist "%USERPROFILE%\.platformio\penv\Scripts\python.exe" set "PYEXE=%USERPROFILE%\.platformio\penv\Scripts\python.exe"
if not defined PYEXE goto nopython

"%PYEXE%" %PYARG% tools\convert_menu.py
endlocal
exit /b

:nopython
echo.
echo Python 3 was not found on this computer.
echo Please install Python 3 from https://www.python.org/ or ask Claude for help.
echo.
pause
endlocal
