$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\OpenWhisprARM64'
$policyDirectory = Join-Path $root 'policy'
New-Item -ItemType Directory -Force $policyDirectory | Out-Null
$sid = (Get-LocalUser -Name 'OpenWhisprVerify').SID.Value
& icacls $policyDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$($sid):(OI)(CI)RX" | Out-Null
$policy = Join-Path $policyDirectory 'job-policy.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'arm64-runner-job-policy.ps1') -Destination $policy -Force
$environmentFile = Join-Path $root 'runner\.env'
$lines = @(Get-Content -LiteralPath $environmentFile | Where-Object { $_ -notmatch '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' })
$lines += "ACTIONS_RUNNER_HOOK_JOB_STARTED=$policy"
Set-Content -LiteralPath $environmentFile -Value $lines
Get-Service -Name 'actions.runner.luisfranciscor505-openwhispr-arm64.*' | Restart-Service
@{ success = $true; jobPolicy = 'trusted release workflow only' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'policy-result.json')
