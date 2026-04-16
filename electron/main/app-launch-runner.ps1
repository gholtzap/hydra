param(
    [string]$BuildCommand,
    [string]$RunCommand
)

if (-not $BuildCommand -or -not $RunCommand) {
    Write-Host "Build and run commands are required."
    exit 1
}

$frames = @('|', '/', '-', '\')
$frameIndex = 0

# Clear screen
[Console]::Write("`e[2J`e[H")

$job = Start-Job -ScriptBlock {
    param($cmd)
    cmd /c $cmd 2>&1 | Out-Null
    exit $LASTEXITCODE
} -ArgumentList $BuildCommand

while ($job.State -eq 'Running') {
    $frame = $frames[$frameIndex % 4]
    [Console]::Write("`r`e[K$frame Building...")
    $frameIndex++
    Start-Sleep -Milliseconds 100
}

$result = Receive-Job $job
$exitCode = $job.ChildJobs[0].JobStateInfo.Reason.ExitCode
Remove-Job $job

if ($exitCode -ne 0 -and $null -ne $exitCode) {
    Write-Host "`r`e[KBuilding`nBuild failed ($exitCode)."
    exit $exitCode
}

Write-Host "`r`e[KBuilding`nBuilt`nNow running..."
cmd /c $RunCommand
exit $LASTEXITCODE
