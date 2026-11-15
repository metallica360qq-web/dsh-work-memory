@echo off
chcp 65001 >nul
set SCRIPT=%~dp0autopilot.js
set LOG=%USERPROFILE%\.dsh\work-memory\autopilot.log
where node >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] ERROR node not found in PATH >> "%LOG%"
  exit /b 9009
)
echo [%date% %time%] start >> "%LOG%"
node "%SCRIPT%" --hours 2 --limit 3 >> "%LOG%" 2>&1
echo [%date% %time%] rebuild exit=%errorlevel% >> "%LOG%"
rem 两遍归纳之后，新对话要跟着归类/切段，否则新记忆一直是未打标
node "%~dp0maintain.js" --assign 20 --segment 3 --classify 10 >> "%LOG%" 2>&1
echo [%date% %time%] maintain exit=%errorlevel% >> "%LOG%"