@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 构建面试结果查询站 ===
node tools\build_data.js %*
if errorlevel 1 (
  echo.
  echo [构建失败]
  pause
  exit /b 1
)
echo.
echo === 自检 ===
node tools\verify_site.js
if errorlevel 1 (
  echo.
  echo [自检未通过，先别推送]
  pause
  exit /b 1
)
echo.
echo 全部完成。推送：git add -A ^&^& git commit -m "更新名单" ^&^& git push
pause
