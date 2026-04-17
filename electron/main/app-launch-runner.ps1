function Write-InvalidPayloadAndExit {
    Write-Host "Invalid app launch payload."
    exit 1
}

function Parse-EnvironmentPair {
    param(
        [string]$Pair
    )

    $separatorIndex = $Pair.IndexOf("=")
    if ($separatorIndex -lt 1) {
        Write-InvalidPayloadAndExit
    }

    return @{
        Key = $Pair.Substring(0, $separatorIndex)
        Value = $Pair.Substring($separatorIndex + 1)
    }
}

function Invoke-AppCommand {
    param(
        [hashtable]$EnvironmentMap,
        [string[]]$CommandArgs,
        [switch]$SuppressOutput
    )

    if (-not $CommandArgs -or $CommandArgs.Count -eq 0) {
        return 1
    }

    $originalValues = @{}
    foreach ($entry in $EnvironmentMap.GetEnumerator()) {
        $name = [string]$entry.Key
        $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, [string]$entry.Value, "Process")
    }

    try {
        $command = $CommandArgs[0]
        $arguments = @()
        if ($CommandArgs.Count -gt 1) {
            $arguments = $CommandArgs[1..($CommandArgs.Count - 1)]
        }

        if ($SuppressOutput) {
            & $command @arguments 2>&1 | Out-Null
        } else {
            & $command @arguments
        }

        if ($null -ne $LASTEXITCODE) {
            return [int]$LASTEXITCODE
        }

        if ($?) {
            return 0
        }

        return 1
    } finally {
        foreach ($entry in $originalValues.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, "Process")
        }
    }
}

$buildEnv = @{}
$runEnv = @{}
$buildArgs = @()
$runArgs = @()

for ($index = 0; $index -lt $args.Count; ) {
    if ($index + 1 -ge $args.Count) {
        Write-InvalidPayloadAndExit
    }

    $flag = [string]$args[$index]
    $value = [string]$args[$index + 1]

    switch ($flag) {
        "--build-env" {
            $entry = Parse-EnvironmentPair -Pair $value
            $buildEnv[$entry.Key] = $entry.Value
            $index += 2
            continue
        }
        "--build-arg" {
            $buildArgs += $value
            $index += 2
            continue
        }
        "--run-env" {
            $entry = Parse-EnvironmentPair -Pair $value
            $runEnv[$entry.Key] = $entry.Value
            $index += 2
            continue
        }
        "--run-arg" {
            $runArgs += $value
            $index += 2
            continue
        }
        default {
            Write-InvalidPayloadAndExit
        }
    }
}

if ($buildArgs.Count -eq 0 -or $runArgs.Count -eq 0) {
    Write-Host "Build and run commands are required."
    exit 1
}

$frames = @("|", "/", "-", "\")
$frameIndex = 0

[Console]::Write("`e[2J`e[H")

$job = Start-Job -ScriptBlock {
    param(
        [hashtable]$EnvironmentMap,
        [string[]]$CommandArgs
    )

    $originalValues = @{}
    foreach ($entry in $EnvironmentMap.GetEnumerator()) {
        $name = [string]$entry.Key
        $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, [string]$entry.Value, "Process")
    }

    try {
        $command = $CommandArgs[0]
        $arguments = @()
        if ($CommandArgs.Count -gt 1) {
            $arguments = $CommandArgs[1..($CommandArgs.Count - 1)]
        }

        & $command @arguments 2>&1 | Out-Null

        if ($null -ne $LASTEXITCODE) {
            [int]$LASTEXITCODE
        } elseif ($?) {
            0
        } else {
            1
        }
    } finally {
        foreach ($entry in $originalValues.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, "Process")
        }
    }
} -ArgumentList $buildEnv, $buildArgs

while ($job.State -eq "Running") {
    $frame = $frames[$frameIndex % $frames.Count]
    [Console]::Write("`r`e[K$frame Building...")
    $frameIndex += 1
    Start-Sleep -Milliseconds 100
}

$buildStatus = Receive-Job $job -Wait
Remove-Job $job

if ($buildStatus -is [array]) {
    $buildStatus = $buildStatus[-1]
}

$buildExitCode = if ($null -eq $buildStatus) { 0 } else { [int]$buildStatus }
if ($buildExitCode -ne 0) {
    Write-Host "`r`e[KBuilding`nBuild failed ($buildExitCode)."
    exit $buildExitCode
}

Write-Host "`r`e[KBuilding`nBuilt`nNow running..."
$runExitCode = Invoke-AppCommand -EnvironmentMap $runEnv -CommandArgs $runArgs
exit $runExitCode
