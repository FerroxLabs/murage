# Selfcheck producer: winsac-qualsign; workflow/helper consumer: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $StepsJson, [Parameter(Mandatory)][string] $Scratch,
    [ValidateSet('Pe','Tokens','Scrub','Receipt','Identity','Packs')][string] $Group, [string] $HelperPath)
$ErrorActionPreference = 'Stop'
$helper = if ($HelperPath) { $HelperPath } else { [IO.Path]::GetFullPath("$PSScriptRoot/../infra/windows-signing/qualsign/Write-QualsignReceipt.ps1") }
$steps = Get-Content -LiteralPath $StepsJson -Raw | ConvertFrom-Json
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw "Helper parse failed: $parseErrors" }
foreach ($step in $steps) {
    $null = [Management.Automation.Language.Parser]::ParseInput($step.run,[ref]$tokens,[ref]$parseErrors)
    if ($parseErrors.Count) { throw "PowerShell parse failed: $($step.id)" }
}
foreach ($function in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    Invoke-Expression $function.Extent.Text
}
function Assert-Reject([scriptblock] $Code, [string] $Label) {
    $failed = $false
    try { & $Code | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw "Mutant survived: $Label" }
}
function Assert-Equal($Actual,$Expected,[string] $Label) {
    if ($Actual -cne $Expected) { throw "Control failed: $Label ($Actual)" }
}
$env:RUNNER_TEMP = $Scratch
$env:GITHUB_OUTPUT = Join-Path $Scratch 'outputs'
$env:GITHUB_STEP_SUMMARY = Join-Path $Scratch 'summary'
if ($Group -in @('Pe','Tokens')) {
    $image = [byte[]]::new(512)
    [BitConverter]::GetBytes([uint16]0x5a4d).CopyTo($image,0)
    [BitConverter]::GetBytes([uint32]64).CopyTo($image,60)
    [BitConverter]::GetBytes([uint32]0x4550).CopyTo($image,64)
    [BitConverter]::GetBytes([uint16]240).CopyTo($image,84)
    [BitConverter]::GetBytes([uint16]0x20b).CopyTo($image,88)
    [BitConverter]::GetBytes([uint32]16).CopyTo($image,196)
    Assert-Equal (Get-CertificateTable $image).size 0 'empty PE'
    foreach ($offset in @(232,236)) {
        $mutant=$image.Clone(); [BitConverter]::GetBytes([uint32]8).CopyTo($mutant,$offset)
        Assert-Reject { Get-CertificateTable $mutant } "half-empty certificate directory $offset"
    }
    foreach ($mutant in @([byte[]]::new(3),[byte[]]::new(512))) { Assert-Reject { Get-CertificateTable $mutant } 'malformed PE' }
    [BitConverter]::GetBytes([uint32]400).CopyTo($image,232); [BitConverter]::GetBytes([uint32]16).CopyTo($image,236)
    Assert-Equal (Get-CertificateTable $image).size 16 'embedded table'
    foreach ($pair in @(@(232,401),@(236,999),@(232,8),@(236,0))) {
        $mutant=$image.Clone(); [BitConverter]::GetBytes([uint32]$pair[1]).CopyTo($mutant,$pair[0])
        Assert-Reject { Get-CertificateTable $mutant } "malformed table $pair"
    }
    $folder=Join-Path $Scratch 'tosign'; $null=New-Item -ItemType Directory -Path $folder
    $file=Join-Path $folder 'witness-collector.exe'
    $image[232]=0; $image[233]=0; $image[236]=0
    [IO.File]::WriteAllBytes($file,$image); Save-Json (Join-Path $Scratch 'bind.json') @{}
    function global:Get-AuthenticodeSignature { [pscustomobject]@{Status=$global:FixtureSignatureStatus} }
    $global:FixtureSignatureStatus='NotSigned'
    & $helper -Mode PreSign
    $bind=Get-Content (Join-Path $Scratch 'bind.json') -Raw | ConvertFrom-Json
    Assert-Equal $bind.unsignedSha256 (Get-Sha256 $file) 'unsigned digest'
    $global:FixtureSignatureStatus='Valid'; Assert-Reject { & $helper -Mode PreSign } 'Authenticode disagreement'
    $global:FixtureSignatureStatus='NotSigned'
    'extra' | Set-Content (Join-Path $folder 'other.exe'); Assert-Reject { & $helper -Mode PreSign } 'extra image'
    Remove-Item -LiteralPath (Join-Path $folder 'other.exe')
    [BitConverter]::GetBytes([uint32]400).CopyTo($image,232); [BitConverter]::GetBytes([uint32]16).CopyTo($image,236)
    [IO.File]::WriteAllBytes($file,$image); Assert-Reject { & $helper -Mode PreSign } 'signed image before sign'
    # Execute the actual Verify preamble, stopping before any platform signature tool.
    $verifyBranch = $ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith("if (`$env:ACTIONS_ID_TOKEN_REQUEST_URL")},$true)[0].Extent.Text
    foreach ($name in @('ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN','AZURE_FEDERATED_TOKEN')) {
        [Environment]::SetEnvironmentVariable($name,'neutral'); Assert-Reject { Invoke-Expression $verifyBranch } "surviving OIDC $name"
        [Environment]::SetEnvironmentVariable($name,'')
    }
    Invoke-Expression $verifyBranch
    $tableGate=$ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("throw 'Embedded certificate table required'") -and $node.Extent.Text.StartsWith('if ($table.size')},$true)[0].Extent.Text
    $table=@{size=0}; Assert-Reject { Invoke-Expression $tableGate } 'catalog-only'
    $table=@{size=16}; Invoke-Expression $tableGate
}
if ($Group -eq 'Scrub') {
    $scrub=@($steps | Where-Object id -eq 'scrub'); if ($scrub.Count -ne 1 -or $scrub[0].if -cne 'always()') { throw 'Unconditional scrub required' }
    if ($PSVersionTable.PSVersion -lt [version]'7.4') { throw 'pwsh 7.4+ required to exercise native error semantics' }
    # Mock az is a real external program that exits non-zero, so the native-command error preference applies to it.
    $bin=Join-Path $Scratch 'mockbin'; $null=New-Item -ItemType Directory -Path $bin -Force
    $mock=Join-Path $bin $(if($IsWindows){'az.cmd'}else{'az'})
    if ($IsWindows) {
        [IO.File]::WriteAllText($mock,"@echo off`r`necho %*>>`"%QS_CALLS%`"`r`nif `"%QS_FAIL%`"==`"%*`" exit /b 1`r`nif `"%*`"==`"account list --all --output json`" (if defined QS_ACCOUNTS (echo [{`"id`":`"neutral`"}]) else (echo []))`r`nexit /b 0`r`n")
    } else {
        [IO.File]::WriteAllText($mock,"#!/bin/sh`necho `"`$*`" >> `"`$QS_CALLS`"`n[ `"`$QS_FAIL`" = `"`$*`" ] && exit 1`nif [ `"`$*`" = 'account list --all --output json' ]; then if [ -n `"`$QS_ACCOUNTS`" ]; then echo '[{`"id`":`"neutral`"}]'; else echo '[]'; fi; fi`nexit 0`n")
        [IO.File]::SetUnixFileMode($mock,[IO.UnixFileMode]'UserRead,UserWrite,UserExecute')
    }
    $env:PATH=$bin + [IO.Path]::PathSeparator + $env:PATH
    $env:QS_CALLS=Join-Path $Scratch 'az-calls'
    $pwshExe=(Get-Process -Id $PID).Path
    $list='account list --all --output json'
    # Each case runs the real step text in a child pwsh with the native preference ON (7.4+ semantics) and the step's own error handling.
    $runStep = {
        param([string] $Fail,[bool] $Accounts,[bool] $UseHome)
        $home2=Join-Path $Scratch 'home'; $config=if($UseHome){Join-Path $home2 '.azure'}else{Join-Path $Scratch 'azure-config'}
        $null=New-Item -ItemType Directory -Path $config -Force; 'neutral' | Set-Content (Join-Path $config 'unknown-future-token-cache')
        Remove-Item -LiteralPath $env:QS_CALLS -ErrorAction Ignore
        $env:QS_FAIL=$Fail; $env:QS_ACCOUNTS=if($Accounts){'1'}else{''}
        $env:HOME=$home2; $env:USERPROFILE=$home2
        if ($UseHome) { Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction Ignore } else { $env:AZURE_CONFIG_DIR=$config }
        $file=Join-Path $Scratch 'scrub-step.ps1'
        [IO.File]::WriteAllText($file,"`$PSNativeCommandUseErrorActionPreference = `$true`n" + $scrub[0].run)
        $saved=$PSNativeCommandUseErrorActionPreference; $PSNativeCommandUseErrorActionPreference=$false
        try { $null = & $pwshExe -NoProfile -Command ". '$file'" 2>&1; $code=$LASTEXITCODE } finally { $PSNativeCommandUseErrorActionPreference=$saved }
        [pscustomobject]@{Code=$code;ConfigExists=(Test-Path -LiteralPath $config);Calls=(@(Get-Content -LiteralPath $env:QS_CALLS -ErrorAction Ignore) -join ';')}
    }
    # Idempotent: logout and clear may fail when nothing is logged in; the config dir is always removed; only a surviving account (or failing list) fails closed.
    foreach ($case in @(
        @('',$false,$false,$true),@('logout',$false,$false,$true),@('account clear',$false,$false,$true),@('logout',$false,$true,$true),@('',$false,$true,$true),
        @('',$true,$false,$false),@('',$true,$true,$false),@($list,$false,$false,$false),@($list,$false,$true,$false))) {
        $label="fail='$($case[0])' accounts=$($case[1]) home=$($case[2])"
        $r = & $runStep $case[0] $case[1] $case[2]
        if ($r.ConfigExists) { throw "CLI config survived scrub: $label" }
        if ($case[3]) {
            if ($r.Code -ne 0) { throw "Control failed: scrub should pass: $label" }
            Assert-Equal $r.Calls "logout;account clear;$list" "fixed scrub calls $label"
        } elseif ($r.Code -eq 0) { throw "Mutant survived: $label" }
    }
    $absence=@($steps | Where-Object id -eq 'token-absence')[0].run
    $env:ACTIONS_ID_TOKEN_REQUEST_URL=''; $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN=''; $env:AZURE_FEDERATED_TOKEN=''
    & ([scriptblock]::Create($absence))
    # The runner re-injects credentials in the OIDC job; only job isolation removes that authority.
    $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN='fixture-token'; $env:ACTIONS_ID_TOKEN_REQUEST_URL='https://oidc.example.invalid'
    Assert-Reject { & ([scriptblock]::Create($absence)) } 'runner reinjection'
    & ([scriptblock]::Create('')) # Gate-removal mutant accepts the same surviving token.
}
if ($Group -eq 'Packs') {
    $sha=[Convert]::ToBase64String([byte[]]::new(64)); $pins=@([pscustomobject]@{id='neutral.pack';version='10.0.0';sha512=$sha})
    $assets=[pscustomobject]@{project=[pscustomobject]@{frameworks=[pscustomobject]@{'net10.0-windows7.0'=[pscustomobject]@{downloadDependencies=@([pscustomobject]@{name='Neutral.Pack';version='[10.0.0, 10.0.0]'})}}}}
    $metadata=Join-Path $Scratch 'neutral.pack/10.0.0'; $null=New-Item -ItemType Directory -Path $metadata -Force
    Save-Json (Join-Path $metadata '.nupkg.metadata') @{contentHash=$sha;source='https://api.nuget.org/v3/index.json'}
    Assert-Packs $assets $pins $Scratch
    $pins[0].sha512=[Convert]::ToBase64String([byte[]](1..64)); Assert-Reject { Assert-Packs $assets $pins $Scratch } 'R2-10 altered pack hash'
    $pins[0].sha512=$sha; Assert-Packs $assets $pins $Scratch
    Save-Json (Join-Path $metadata '.nupkg.metadata') @{contentHash=$sha;source='https://mirror.example.invalid/v3/index.json'}
    Assert-Reject { Assert-Packs $assets $pins $Scratch } 'different package source'
    Save-Json (Join-Path $metadata '.nupkg.metadata') @{contentHash=$sha;source='https://api.nuget.org/v3/index.json'}
    Assert-Reject { Assert-Packs $assets @() $Scratch } 'R2-11 missing pack'
    Assert-Reject { Assert-Packs $assets @($pins[0],$pins[0]) $Scratch } 'R2-11 duplicate pin'
    Assert-Reject { Assert-Packs $assets @($pins[0],[pscustomobject]@{id='extra.pack';version='10.0.0';sha512=$sha}) $Scratch } 'R2-11 extra pin'
    $message=''; try { Assert-Packs $assets @([pscustomobject]@{id='other.pack';version='10.0.0';sha512=$sha}) $Scratch } catch { $message=$_.Exception.Message }
    if (-not $message.Contains("unpinned=[neutral.pack/10.0.0 sha512=$sha]") -or -not $message.Contains('unused-pins=[other.pack/10.0.0]')) { throw "Control failed: swapped pack not named ($message)" }
    $assets.project.frameworks.'net10.0-windows7.0'.downloadDependencies[0].version='[10.0.0, 10.0.1]'
    Assert-Reject { Assert-Packs $assets $pins $Scratch } 'unbounded pack range'
}
if ($Group -eq 'Receipt') {
    $env:GIT_CONFIG_GLOBAL=Join-Path $Scratch 'gitconfig'; $env:GIT_CONFIG_SYSTEM=$env:GIT_CONFIG_GLOBAL
    [IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL,'')
    $repo=Join-Path $Scratch 'repository'; $null=New-Item -ItemType Directory -Path $repo; Push-Location $repo
    try {
        & git init -q
        $paths=@{collector='infra/windows-signing/collector';signingProcess='infra/windows-signing/boundary/SigningProcess.cs';processApi='infra/windows-signing/boundary/WindowsSigningProcessApi.cs';plan='scripts/windows-signing-witness/plan.json';workflow='.github/workflows/windows-qualsign.yml';helper='infra/windows-signing/qualsign/Write-QualsignReceipt.ps1';packs='infra/windows-signing/qualsign/packs.sha512.json'}
        foreach ($entry in $paths.GetEnumerator()) {
            $target=if($entry.Key -eq 'collector'){Join-Path $entry.Value 'source.cs'}else{$entry.Value}
            $null=New-Item -ItemType Directory -Path (Split-Path $target) -Force
            [IO.File]::WriteAllText((Join-Path $repo $target),"neutral $($entry.Key)")
        }
        [IO.File]::WriteAllText((Join-Path $repo 'infra/windows-signing/collector/packages.lock.json'),'{}')
        & git add .; & git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm dev
        $dev=& git rev-parse HEAD
        'scrubbed' | Set-Content public-marker; & git add public-marker; & git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm public
        $pub=& git rev-parse HEAD
        $env:GITHUB_SHA=$pub; $env:GITHUB_REF_NAME='ci/try-012345abcdef'; $env:GITHUB_EVENT_PATH=Join-Path $Scratch 'event.json'
        $env:GITHUB_REPOSITORY='neutral/repository'; $env:GITHUB_RUN_ID='123'; $env:GITHUB_RUN_ATTEMPT='2'
        Save-Json $env:GITHUB_EVENT_PATH @{head_commit=@{message="QUALSIGN collector $dev";id=$pub}}
        & $helper -Mode Bind
        $bind=Get-Content (Join-Path $Scratch 'bind.json') -Raw | ConvertFrom-Json -AsHashtable
        Assert-Equal $bind.devSha $dev 'DEV_SHA'; Assert-Equal $bind.treeHashes.Count 7 'seven source objects'
        foreach ($entry in $paths.GetEnumerator()) { Assert-Equal $bind.treeHashes[$entry.Key] (& git rev-parse "${dev}:$($entry.Value)") "bound $($entry.Key)" }
        $previous=@{dev_sha=$dev;dev_sha12=$dev.Substring(0,12);sdk_version='10.0.115';dotnet_sha256=('c'*64);unsigned_sha256=('e'*64);lock_sha256=$bind.lockFileSha256;packs_sha256=(Get-Sha256 $paths.packs)}
        foreach ($key in $paths.Keys) { if ($key -ne 'packs') {$previous[$key]=$bind.treeHashes[$key]} }
        $env:QUALSIGN_BIND=$previous | ConvertTo-Json -Compress
        & $helper -Mode Bind
        foreach ($name in @('dev_sha','collector','signingProcess','processApi','plan','workflow','helper','lock_sha256','packs_sha256','dotnet_sha256','unsigned_sha256','sdk_version','dev_sha12')) {
            $mutant=$previous.Clone(); $mutant[$name]='invalid'; $env:QUALSIGN_BIND=$mutant | ConvertTo-Json -Compress
            Assert-Reject { & $helper -Mode Bind } "invalid job output $name"
        }
        $env:QUALSIGN_BIND=$previous | ConvertTo-Json -Compress; & $helper -Mode Bind
        $folder=Join-Path $Scratch 'tosign'; $null=New-Item -ItemType Directory -Path $folder
        $file=Join-Path $folder 'witness-collector.exe'; [IO.File]::WriteAllText($file,'neutral signed bytes')
        $verified=@{signedSha256=(Get-Sha256 $file);leafDerSha256=('f'*64);subject='CN=Neutral';issuer='CN=Neutral issuer';ekus=@('1.3.6.1.5.5.7.3.3');signtoolExit=0;signtoolPath='C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe';signtoolSha256=('1'*64)}
        Save-Json (Join-Path $Scratch 'verification.json') $verified; & $helper -Mode Receipt
        $receipt=Get-Content (Join-Path $folder 'qualsign-receipt.json') -Raw | ConvertFrom-Json
        Assert-Equal $receipt.devSha $dev 'receipt DEV_SHA'; Assert-Equal $receipt.publicSha $pub 'public SHA'; Assert-Equal $receipt.job 'verify-collector' 'receipt job'
        Assert-Equal $receipt.core 'PARTIAL' 'partial core'; Assert-Equal $receipt.pass $false 'no pass'
        Assert-Equal $receipt.signedArtifactName "qualsign-signed-$($dev.Substring(0,12))-2" 'signed artifact'
        $bind=Get-Content (Join-Path $Scratch 'bind.json') -Raw | ConvertFrom-Json -AsHashtable
        foreach ($bad in @('invalid',('f'*40))) { $m=$bind.Clone(); $m.devSha=$bad; Save-Json (Join-Path $Scratch 'bind.json') $m; Assert-Reject { & $helper -Mode Receipt } 'dev SHA mutation' }
        Save-Json (Join-Path $Scratch 'bind.json') $bind
        $m=$bind.Clone(); $m.unsignedSha256=$verified.signedSha256; Save-Json (Join-Path $Scratch 'bind.json') $m; Assert-Reject { & $helper -Mode Receipt } 'signed equals unsigned'
        Save-Json (Join-Path $Scratch 'bind.json') $bind
        [IO.File]::WriteAllText($file,'changed'); Assert-Reject { & $helper -Mode Receipt } 'changed signed bytes'
        [IO.File]::WriteAllText($file,'neutral signed bytes')
        'changed' | Set-Content $paths.plan; & git add .; & git -c user.name=fixture -c user.email=fixture@example.invalid commit -qm changed
        Assert-Reject { & $helper -Mode Bind } 'checkout SHA mismatch'
        $env:GITHUB_SHA=& git rev-parse HEAD; Save-Json $env:GITHUB_EVENT_PATH @{head_commit=@{message="QUALSIGN collector $dev";id=$env:GITHUB_SHA}}
        Assert-Reject { & $helper -Mode Bind } 'one-byte bound input change across jobs'
    } finally { Pop-Location }
}
# Public v1.0.18 signing certificate and root; no private key.
$publicLeafPem=@'
-----BEGIN CERTIFICATE-----
MIIG3DCCBMSgAwIBAgITMwALfUjMD+RS1XB/hwAAAAt9SDANBgkqhkiG9w0BAQwF
ADBaMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MSswKQYDVQQDEyJNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ1MgQU9DIENBIDA0MB4X
DTI2MTEwODA0NDQ0MloXDTI2MTExMTA0NDQ0MlowgZwxDjAMBgNVBBETBTc4NzAx
MQswCQYDVQQGEwJVUzEOMAwGA1UECBMFVGV4YXMxDzANBgNVBAcTBkF1c3RpbjEm
MCQGA1UECRMdMTAwIENvbmdyZXNzIEF2ZSAtIFN1aXRlIDIwMDAxGTAXBgNVBAoT
EEZlcnJveCBMYWJzLCBMTEMxGTAXBgNVBAMTEEZlcnJveCBMYWJzLCBMTEMwggGi
MA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQCM8rbe9i57injGn9pTBOuI7uKs
llCwoEWnNa2HSZ3ZqSzsMGHkVuLsjAl4ITu8vQIxwhod4VaCsmZ2hVy7uA+KjGjc
ThHsIwxaavsDK0ECluNdkEpuWkIx8e/f6CSOWpjGUH/UmNYKJ4QLSIzo3Qb6KEQR
0m2FSALbo8mTBDTrYniDypyQgp01Ro95WvcUuQ60oQrXZ34PvW27gdkGu8LSNfwo
vwm29oOCU15b4B04RkhpfE6MPLiG0dDEj1SZkjxbWMK7b8/Q6vJKWhTGob2ktl9L
ECHWcVnJaPRSnRDDVOJ6gREXoDqYGNjSG544YIyaA9Pzm9QJFnjoZBhTe6qX/If1
qtnMhCewbhIkFM7RcWrgQqpmUolVzU3y2E0RCCo+SNBawZaMybJHGuC+58DqpvFV
YmUn3nhHozcbCi2FC2iWTe+z/9bAPb/N0lMe5z07xCGPC3gypN/UM4PBz3ojV5Zp
HatUmjV/Z2v7tRh6tw6QtPQYCHm0bXYITBaxlYMCAwEAAaOCAdYwggHSMAwGA1Ud
EwEB/wQCMAAwDgYDVR0PAQH/BAQDAgeAMD0GA1UdJQQ2MDQGCisGAQQBgjdhAQAG
CCsGAQUFBwMDBhwrBgEEAYI3YYLLmu5bgZvh+GCBu8WlRYLJv7FpMB0GA1UdDgQW
BBRvZTlq5mlG+fJyuve486pXLJQKmjAfBgNVHSMEGDAWgBRrJUHe+2t8/RiACi1/
j3ZdqnM9uDBnBgNVHR8EYDBeMFygWqBYhlZodHRwOi8vd3d3Lm1pY3Jvc29mdC5j
b20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ1MlMjBB
T0MlMjBDQSUyMDA0LmNybDB0BggrBgEFBQcBAQRoMGYwZAYIKwYBBQUHMAKGWGh0
dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIw
SUQlMjBWZXJpZmllZCUyMENTJTIwQU9DJTIwQ0ElMjAwNC5jcnQwVAYDVR0gBE0w
SzBJBgRVHSAAMEEwPwYIKwYBBQUHAgEWM2h0dHA6Ly93d3cubWljcm9zb2Z0LmNv
bS9wa2lvcHMvRG9jcy9SZXBvc2l0b3J5Lmh0bTANBgkqhkiG9w0BAQwFAAOCAgEA
NUTtH/yWQHJXPg5FGrqLyXaLbcu7bFDBduR3t3MBbj7Lz236VAOvsVOYVpRnP5Ae
bNyKtiaM9jcIuLe12E/aPNOt8VOI4Uv/8lTfDRG6Mk8XUdAx27sXOnthQ2K1l3j5
VRaqO6CxarYTJzOuCGTX8lKFDXDQt24EqLpjn1X/OMHxFZalvvkLHHHi2NgDPI7M
aFmo78pr0nrK8PQVLxZ7zbk77Wofi9cGY/JuuHzdhrJ/dIGbizfAK39khR/6omcK
kPL/YH/VTlRpuQicZuli51nV2HN8GMbEheFoq/QmKfSqehuA4hg0Pl6uZk8qhttd
y8d2/wTIbgldIA/DyfHPTNhPgl7GckfovducRzMG7/3bgsoBHTa6xi8NPOnY67/Z
U/rpNfmEQ1eSHnpTqKD4+Jdz8mzzTGHigSxgs1WtqSt8f4zBrwn3Mj6QaeRd9+kP
CBpH7630gq40u6ezgKT5xhJfJrYY/ToSwH3YZjpqKHskTFvEEnhlldw5YgUmcvQv
fTYYG3AP+yJh7R2Il4ehnZHGkRgmAxKPemx3gPhVFSyWwYYrxO6NaxbDCQ98KtsP
/4rZg6Qt3nKYRLS/4cAlOKjRnivFYrPgHU6Jt8DtQ0oHtKgz/bCpJ2pkuASDUKyD
jI7eI0ygRRU6tdYaOr0fINxMhWkkpRwOvaKyOSarBYc=
-----END CERTIFICATE-----

subject=postalCode = 78701, C = US, ST = Texas, L = Austin, street = 100 Congress Ave - Suite 2000, O = "Ferrox Labs, LLC", CN = "Ferrox Labs, LLC"
issuer=C = US, O = Microsoft Corporation, CN = Microsoft ID Verified CS AOC CA 04
'@
$publicRootPem=@'
-----BEGIN CERTIFICATE-----
MIIFzDCCA7SgAwIBAgIQVJjS0dRbGZVIE3nIEcCHmTANBgkqhkiG9w0BAQwFADB3
MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMUgw
RgYDVQQDEz9NaWNyb3NvZnQgSWRlbnRpdHkgVmVyaWZpY2F0aW9uIFJvb3QgQ2Vy
dGlmaWNhdGUgQXV0aG9yaXR5IDIwMjAwHhcNMjAwNDE2MTgzNjE2WhcNNDUwNDE2
MTg0NDQwWjB3MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBv
cmF0aW9uMUgwRgYDVQQDEz9NaWNyb3NvZnQgSWRlbnRpdHkgVmVyaWZpY2F0aW9u
IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMjAwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQCzkSoHgwZn/Z6d4MfAt6TmQgR/D6bbX/vVWtdFoPt3
C/CA86ZtWk15U9ighoRXRSDHolT7x6K/isduNfOiFcQvTuNKhZZJDf++mdgU9rwn
B+5Cmyv1C5IG5P1pE2WokXLymITrgz0O5NdxEkghyw3t9kdJt5v5yccXtoRP/7is
mtdzZ0mF44a9N0DQJYbU3rXCbWJq1al4vC1vSfnlbBQU/RTH02UWN97LbrxeKY39
YpsVLNYF5rmJMjOjYsfX1lJnCMQu9FYrnguHzOyntKaq6wXNGVelOgsEJxyRZ54t
Yi0vHr7awCDLBBnKM/uJvpjicqByNb554ZyDb+RtF2+Q8z0AhnU4jtDgSZq729P4
MMrVV4hoTXLTv21/cdj9vQ2ukmRIt1tveSa1zZuVIYTR7w8yPXtXjPNFB0x84F4Y
DjV2i22eyzZ0qwX44HNdMlaUZ5clCsY1PZSX58FEi4D9wfj0dBnlMPYG+yFXPgYc
i2sVhidJe4KTylnodUfoPzj0x1N5oLa04lxR771fOMET5ngMlVouxUBZKMwPJMDs
ugl3I5k4prYc2se6ILbXN9h/N68I4ztx225zG32ZcrDkhjNZdLUWAHtQbcaGE9r9
xDmCPSQAmmDaupTABVEsNKxQmROHu7MFgLJNMAJcuCaDXbRjc++uI5VPYCi+N9Vb
pQIDAQABo1QwUjAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HQ4EFgQUyH7SaoUqG8oZmAQHJ89QEE9oqKIwEAYJKwYBBAGCNxUBBAMCAQAwDQYJ
KoZIhvcNAQEMBQADggIBAK9q3eYZ5y2UQxlOy+lQlWSlA5ECi+I2gDsVolLCFhm2
alpddEMw9Jv/YHQJsSEekBZtxSSPXGaIY/RPzH3yEkxAEIsBn9qpyK7ylRvPnQXr
ST50oGhb5VYsZRyCflPaVtlGF3mSRcQQNghSKRfLL6byftRpJIoej7BzDcwcSquy
qu2nkWMBZCKoMrh+MiizZ3MtkbTcMQEL90cKpvHXSu1WYMQsCKN7QLC8dCdSh9a+
iN03ioluZ4gd9cldoP62qzqA1xqXPBc2IkEerE3Vg+Y8OL1PMOlUqdO2BMMydmG7
sBjFKxizwIDVt5WwXlFNIvzsWKro2JS0pS7tkt7nGHwhV91VY/e/bc0f0qZ3KHDH
4ls6WwjSW07IAJaz4YM2r4YKZVx09ursemp0oPBL7u+Uo6xQ8oft1zowg8n7fVe+
5eP4QcrlZK6zo+xY7IWazO+56vNWGLlcc5qvxXcXg1nbNxoYclSlQdK2I3WjQ5rl
d3yWebdBjb/s3ICgn9F3dVhfNRPgJRpnC33OJfoHCuRhIdjUHOUHxjaZ9JbQxhX+
Ts3Xroud2xb9BMaSvdSI5qmjqrv3ZDg7X8wM0DW+dBkDpsWqTKJhNoI+HfMrvJdd
20t4Oy31O+9gI+j17AsjNpWvmGa/U9N7uGlKKpZmacSUxvRfbqyYeIiABlyisu2i
-----END CERTIFICATE-----

subject=postalCode = 78701, C = US, ST = Texas, L = Austin, street = 100 Congress Ave - Suite 2000, O = "Ferrox Labs, LLC", CN = "Ferrox Labs, LLC"
issuer=C = US, O = Microsoft Corporation, CN = Microsoft ID Verified CS AOC CA 04
'@
if ($Group -eq 'Identity') {
    $leaf=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicLeafPem)
    $rootCert=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicRootPem)
    $env:QUALSIGN_EXPECTED_SUBJECT='Ferrox Labs, LLC'
    $env:QUALSIGN_EXPECTED_ISSUER_PREFIX='Microsoft ID Verified CS AOC CA '
    $env:QUALSIGN_EXPECTED_ROOT_CN='Microsoft Identity Verification Root Certificate Authority 2020'
    $env:QUALSIGN_EXPECTED_ROOT_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rootCert.RawData)).ToLowerInvariant()
    $env:QUALSIGN_EXPECTED_EKU='1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.97.1.0,1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577'
    $ekus=@($leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages | ForEach-Object {$_.Value} })
    Assert-LeafIdentity $leaf $rootCert $ekus
    foreach ($dn in @('CN="Ferrox Labs, LLC"','CN="Ferrox Labs, LLC", O=Other','CN="Ferrox Labs, LLC extra", O="Ferrox Labs, LLC"','CN="ferrox labs, llc", O="Ferrox Labs, LLC"','CN="Ferrox Labs, LLC", CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"')) {
        $mutant=[pscustomobject]@{SubjectName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($dn);IssuerName=$leaf.IssuerName}
        Assert-Reject { Assert-LeafIdentity $mutant $rootCert $ekus } "subject $dn"
    }
    foreach ($dn in @('CN=Microsoft ID Verified CS EOC CA 01, O=Microsoft Corporation','CN=Microsoft ID Verified CS AOC CA 4x, O=Microsoft Corporation','CN=Microsoft ID Verified CS AOC CA 04, O=Other')) {
        $mutant=[pscustomobject]@{SubjectName=$leaf.SubjectName;IssuerName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($dn)}
        Assert-Reject { Assert-LeafIdentity $mutant $rootCert $ekus } "issuer $dn"
    }
    $mutant=[pscustomobject]@{SubjectName=$leaf.SubjectName;IssuerName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=Microsoft ID Verified CS AOC CA 01, O=Microsoft Corporation')}
    Assert-LeafIdentity $mutant $rootCert $ekus
    foreach ($oid in $env:QUALSIGN_EXPECTED_EKU.Split(',')) {
        $wrong=@($ekus | Where-Object { $_ -cne $oid })
        Assert-Reject { Assert-LeafIdentity $leaf $rootCert $wrong } "missing EKU $oid"
    }
    Assert-Reject { Assert-LeafIdentity $leaf $rootCert @($ekus + '1.3.6.1.4.1.311.97.9.8.7.6') } 'extra account EKU'
    Assert-LeafIdentity $leaf $rootCert @($ekus + '1.2.3.4')
    $wrong=@('1.3.6.1.5.5.7.3.3','1.3.6.1.4.1.311.97.1.2.3.4'); Assert-Reject { Assert-LeafIdentity $leaf $rootCert $wrong } 'wrong account EKU'
    $wrongRoot=[pscustomobject]@{RawData=$rootCert.RawData;SubjectName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=Other Root')}
    Assert-Reject { Assert-LeafIdentity $leaf $wrongRoot $ekus } 'wrong root CN'
    $pin=$env:QUALSIGN_EXPECTED_ROOT_SHA256; $env:QUALSIGN_EXPECTED_ROOT_SHA256='0'*64
    Assert-Reject { Assert-LeafIdentity $leaf $rootCert $ekus } 'wrong root hash'; $env:QUALSIGN_EXPECTED_ROOT_SHA256=$pin
    foreach ($name in @('QUALSIGN_EXPECTED_SUBJECT','QUALSIGN_EXPECTED_ISSUER_PREFIX','QUALSIGN_EXPECTED_ROOT_CN','QUALSIGN_EXPECTED_ROOT_SHA256','QUALSIGN_EXPECTED_EKU')) {
        $value=[Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name,'')
        Assert-Reject { Assert-LeafIdentity $leaf $rootCert $ekus } "empty variable $name"; [Environment]::SetEnvironmentVariable($name,$value)
    }
    # Build a real test-only CA and leaf to cover the allowed issuer rotation.
    $rsa=[Security.Cryptography.RSA]::Create(2048)
    try {
        $rootRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Microsoft Identity Verification Root Certificate Authority 2020',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
        $testRoot=$rootRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1))
        $issuerRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Microsoft ID Verified CS AOC CA 01, O=Microsoft Corporation',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $issuerRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
        $issuer=$issuerRequest.Create($testRoot,[DateTimeOffset]::UtcNow.AddHours(-1),[DateTimeOffset]::UtcNow.AddHours(1),[byte[]]@(1,2,3))
        $issuerWithKey=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issuer,$rsa)
        $leafRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $usages=[Security.Cryptography.OidCollection]::new()
        foreach($oid in $ekus){$null=$usages.Add([Security.Cryptography.Oid]::new($oid))}
        $leafRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages,$false))
        $testLeaf=$leafRequest.Create($issuerWithKey,[DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddMinutes(1),[byte[]]@(4,5,6))
        $env:QUALSIGN_EXPECTED_ROOT_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($testRoot.RawData)).ToLowerInvariant()
        Assert-LeafIdentity $testLeaf $testRoot $ekus
    } finally { $rsa.Dispose() }
    # Execute the actual signtool location guard against workspace and temp copies.
    $locationGate=$ast.FindAll({param($node) $node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Extent.Text.Contains("throw 'Windows SDK signtool outside workspace and temp required'")},$true)[0].Extent.Text
    $env:GITHUB_WORKSPACE=Join-Path $Scratch 'workspace'; $env:RUNNER_TEMP=Join-Path $Scratch 'temp'
    foreach ($root in @($env:GITHUB_WORKSPACE,$env:RUNNER_TEMP)) {
        $signtool=[IO.Path]::GetFullPath($root).TrimEnd('\') + '\signtool.exe'
        Assert-Reject { Invoke-Expression $locationGate } 'workspace/temp signtool'
    }
    $signtool=[IO.Path]::GetFullPath((Join-Path $Scratch '../outside-sdk/signtool.exe')); Invoke-Expression $locationGate
}
$build=@($steps | Where-Object id -eq 'build')[0]
$buildAst=[Management.Automation.Language.Parser]::ParseInput($build.run,[ref]$tokens,[ref]$parseErrors)
$singlePe=@($buildAst.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("throw 'Exactly one collector PE required'")},$true))
if ($singlePe.Count -ne 1) { throw 'One publication PE gate required' }
$collector=[pscustomobject]@{FullName="$env:RUNNER_TEMP\pub\witness-collector.exe"}
$images=@($collector); Invoke-Expression $singlePe[0].Extent.Text
foreach ($images in @(@(),@($collector,$collector),@([pscustomobject]@{FullName="$env:RUNNER_TEMP\pub\other.exe"}))) { Assert-Reject { Invoke-Expression $singlePe[0].Extent.Text } 'single PE publication' }
Write-Output "QUALSIGN_POWERSHELL_GREEN group=$Group"
