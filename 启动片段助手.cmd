@echo off
cd /d "%~dp0"
set "BILI_PEEK_NODE=C:\Users\23221\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%BILI_PEEK_NODE%" helper\configure.cjs
if errorlevel 1 goto failed
"%BILI_PEEK_NODE%" helper\start.cjs
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Setup failed. Pairing is not ready. Please send the error above.
pause
exit /b 1
