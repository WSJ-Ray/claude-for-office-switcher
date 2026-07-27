$ErrorActionPreference = "Stop"

Push-Location "$PSScriptRoot\web"
try {
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "Frontend build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

& "$PSScriptRoot\.venv\Scripts\python.exe" -m PyInstaller `
  --name OfficeGateway `
  --clean `
  --onefile `
  --noconsole `
  --icon "$PSScriptRoot\assets\favicon.ico" `
  --manifest "$PSScriptRoot\assets\OfficeGateway.manifest" `
  --add-data "$PSScriptRoot\static;static" `
  --add-data "$PSScriptRoot\assets\favicon.ico;assets" `
  --add-data "$PSScriptRoot\app\assets\office;app/assets/office" `
  --collect-all "webview" `
  --collect-all "pystray" `
  --collect-all "PIL" `
  --hidden-import "webview.platforms.edgechromium" `
  --hidden-import "pystray._win32" `
  --hidden-import "uvicorn.loops.auto" `
  --hidden-import "uvicorn.protocols.http.auto" `
  --hidden-import "uvicorn.protocols.websockets.auto" `
  --hidden-import "uvicorn.lifespan.on" `
  "$PSScriptRoot\desktop_launcher.py"

if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed with exit code $LASTEXITCODE."
}

Write-Host "Built: $PSScriptRoot\dist\OfficeGateway.exe"
