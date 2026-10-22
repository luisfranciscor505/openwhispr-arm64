$ErrorActionPreference = 'Stop'
if ($env:GITHUB_REPOSITORY -ne 'luisfranciscor505/openwhispr-arm64' -or
    $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
    $env:GITHUB_REF -ne 'refs/heads/arm64' -or
    $env:GITHUB_WORKFLOW_REF -ne 'luisfranciscor505/openwhispr-arm64/.github/workflows/arm64-release.yml@refs/heads/arm64') {
  throw 'This Snapdragon runner accepts only the maintained ARM64 release workflow, dispatched from arm64. Contributor PR jobs are refused before checkout.'
}
Write-Output 'Trusted ARM64 release workflow accepted by local runner policy.'
