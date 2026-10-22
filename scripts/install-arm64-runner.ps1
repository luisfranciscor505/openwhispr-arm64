param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$setup = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$root = 'C:\ProgramData\OpenWhisprARM64'
$runner = Join-Path $root 'runner'
$models = Join-Path $root 'models'
$accountName = 'OpenWhisprVerify'
$log = Join-Path (Split-Path $Configuration) 'runner-setup-result.json'
try {
  $admin = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator rights are required to create the isolated verification account and service.' }
  if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) { throw 'OpenWhisprVerify already exists; inspect the existing runner rather than replacing its credentials.' }
  $passwordBytes = New-Object byte[] 36
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($passwordBytes)
  $password = [Convert]::ToBase64String($passwordBytes) + '!aA1'
  New-LocalUser -Name $accountName -Password (ConvertTo-SecureString $password -AsPlainText -Force) -Description 'Isolated OpenWhispr ARM64 release verification' -PasswordNeverExpires -AccountNeverExpires | Out-Null
  New-Item -ItemType Directory -Force $runner,$models | Out-Null
  $sid = (Get-LocalUser -Name $accountName).SID.Value
  & icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($sid):(OI)(CI)M" | Out-Null
  # Seed only public model assets, never the maintainer profile or API keys.
  Copy-Item -LiteralPath (Join-Path $setup.modelSource 'ggml-base.bin') -Destination $models
  Copy-Item -LiteralPath (Join-Path $setup.modelSource 'base-snapdragon-npu') -Destination $models -Recurse
  $archive = Join-Path $runner 'runner.zip'
  Invoke-WebRequest -Uri $setup.downloadUrl -OutFile $archive
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $setup.sha256) { throw 'Official runner checksum mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $runner
  Remove-Item -LiteralPath $archive
  # Runner reads this per-process env file; no GitHub publishing/signing secrets.
  Set-Content -LiteralPath (Join-Path $runner '.env') -Value "OPENWHISPR_VERIFY_MODELS=$models"
  Push-Location $runner
  try {
    $arguments = @('--unattended','--url',"https://github.com/$($setup.repository)",'--token',$setup.token,'--name','snapdragon-npu','--labels','snapdragon-npu','--work','_work','--runasservice','--windowslogonaccount',".\$accountName",'--windowslogonpassword',$password)
    # Suppress setup output so a failure cannot echo registration credentials.
    & .\config.cmd @arguments *> (Join-Path $runner 'configuration.log')
    if ($LASTEXITCODE -ne 0) { throw 'GitHub runner configuration failed; see restricted runner configuration.log' }
  } finally { Pop-Location }
  & (Join-Path $PSScriptRoot 'secure-arm64-runner.ps1')
  @{ success = $true; runner = 'snapdragon-npu'; account = $accountName } | ConvertTo-Json | Set-Content -LiteralPath $log
} catch {
  @{ success = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $log
  exit 1
} finally {
  $password = $null
  Remove-Item -LiteralPath $Configuration -ErrorAction SilentlyContinue
}
