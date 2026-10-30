@echo off
chcp 65001 >nul
title Circuit2Falstad - 电路图转 Falstad 仿真工具
cd /d "%~dp0"
python server.py
pause
