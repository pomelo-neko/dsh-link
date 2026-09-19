@echo off
rem start-dshlink.cmd — double-click entry point (no window content; delegates to the .vbs).
start "" wscript.exe "%~dp0start-dshlink.vbs"
