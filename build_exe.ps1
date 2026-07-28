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

Push-Location $PSScriptRoot
try {
  & "$PSScriptRoot\.venv\Scripts\python.exe" -m PyInstaller `
    --clean `
    "$PSScriptRoot\OfficeGateway.spec"

  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

Write-Host "Built: $PSScriptRoot\dist\OfficeGateway.exe"
