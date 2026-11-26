$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$homeDir = Join-Path $env:LOCALAPPDATA 'SeongnamCouncilDesk'
$runtime = Join-Path $env:USERPROFILE 'Downloads\seongnam-council-captions\.runtime\python'
$sitePackages = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Lib\site-packages'
$env:PYTHONPATH = "$runtime;$sitePackages"
$ffmpeg = Get-Command ffmpeg.exe -ErrorAction Stop
$env:PATH = "$(Split-Path -Parent $ffmpeg.Source);$env:PATH"
$log = Join-Path $homeDir 'schedule-supervisor.log'
Set-Location -LiteralPath $root
& py.exe -3.11 -u (Join-Path $PSScriptRoot 'schedule_supervisor.py') *>> $log
