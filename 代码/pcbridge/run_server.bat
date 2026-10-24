@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ======================= 可选:放宽本机 agent 的权限 =======================
rem 默认 dsh headless 是 workspace-write 沙箱 + 审批 ask。无人值守时"需要审批"的操作会直接失败。
rem 取消下面这行的注释会让 agent 不受工作区限制(能改整台电脑的文件)—— 自己权衡后再开。
rem set DSH_PERMISSION_MODE=danger-full-access
rem =========================================================================

set "PY="
if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" (
  set "PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
)
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo [x] 找不到 Python 解释器,请手动安装或把路径填到本文件里。
  pause
  exit /b 1
)

echo 正在启动 dsh-pc-bridge ...
echo.
%PY% "%~dp0mcp_dsh_server.py" --host 0.0.0.0 --port 8765
echo.
echo 服务已退出。按任意键关闭窗口。
pause >nul
