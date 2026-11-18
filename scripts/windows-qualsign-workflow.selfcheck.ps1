# Selfcheck producer: winsac-qualsign; workflow/helper consumer: MAIN.
[CmdletBinding()]
param([Parameter(Mandatory)][string] $StepsJson, [Parameter(Mandatory)][string] $Scratch,
    [ValidateSet('Pe','Tokens','Scrub','Receipt','Identity','Packs','Callers')][string] $Group, [string] $HelperPath, [string] $CallerRoot)
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
    $altered=$pins[0].sha512; $message=''; try { Assert-Packs $assets $pins $Scratch } catch { $message=$_.Exception.Message }
    if (-not $message.Contains('neutral.pack/10.0.0') -or -not $message.Contains("pinned=$altered") -or -not $message.Contains("metadata=$sha")) { throw "Control failed: hash mismatch not named ($message)" }
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
# Public v1.0.18 signing certificate, issuer, PCA 2021 and root; no private key.
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
$publicIssuerPem=@'
-----BEGIN CERTIFICATE-----
MIIHKDCCBRCgAwIBAgITMwAAABYxko2SAmV7mgAAAAAAFjANBgkqhkiG9w0BAQwF
ADBjMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MTQwMgYDVQQDEytNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ29kZSBTaWduaW5nIFBD
QSAyMDIxMB4XDTI2MDMyNjE4MTEyOVoXDTMxMDMyNjE4MTEyOVowWjELMAkGA1UE
BhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjErMCkGA1UEAxMi
TWljcm9zb2Z0IElEIFZlcmlmaWVkIENTIEFPQyBDQSAwNDCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAMpV+sjb6Akwz/RtDk5Uo1284BLMttRQy9e5/5WX
tga6h89pkdWjeAwcXmKdP4YxKkhx8hn2q1dTVQbryvLy81tC04vg2bfSJ9emojX4
HKIBYs7VhPRafMbtc866hN55aw1m/kWaPEKxF4Fm/LPLMLJdlu7URB8nFZMfh5tT
C0CJb2uox/14OP/BiGIR8214lXdkV6JsPbO0Iev0mEV133tducIeBChMipzTZfnG
VEq1QYFr7460cEGOIn+7AGfNOSq7gWOlmNB4m2uZ1r66vUJPaN+VYgH/Kmfu7tX2
29b3Alsli38fYS0nQY41bElntMS7yNY+Kd047eXM8/tS3NL+ZUNX3ge5xZqW2ayt
rrNIbwGgQnzsgzxBJvu9+b87jUWFiRS/z1YiPkRLY7iTHKIxJ973kIyK8K5itE/a
Eq/Ht6A8ytaAMMGTEwuCspk72FE1Qyby+TfDlv1KiAc7IlWHHIWbxoVd8jGCoMXh
LSDhuFuGfOWOZKUIuW6YxlxcUYOOkXa02gC7dUYUZi0e1NI1Uq9mmAHdvjKdqgOR
s9/5aDjnbeO3hWd5qwGBmELWytkjY0KcIEF+CMurTimoQoBYSiHJbYrb0pKSQe+3
lVoTVpzdi36jKI7MxLnu1fBAMksa8uD85cU7RU29zMOd18h9dgTEH9pvY+4xLB3l
UgE7AgMBAAGjggHcMIIB2DAOBgNVHQ8BAf8EBAMCAYYwEAYJKwYBBAGCNxUBBAMC
AQAwHQYDVR0OBBYEFGslQd77a3z9GIAKLX+Pdl2qcz24MFQGA1UdIARNMEswSQYE
VR0gADBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtp
b3BzL0RvY3MvUmVwb3NpdG9yeS5odG0wGQYJKwYBBAGCNxQCBAweCgBTAHUAYgBD
AEEwEgYDVR0TAQH/BAgwBgEB/wIBADAfBgNVHSMEGDAWgBTZQSmwDw9jbO9p1/XN
KZ6kSGow5jBwBgNVHR8EaTBnMGWgY6Bhhl9odHRwOi8vd3d3Lm1pY3Jvc29mdC5j
b20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ29kZSUy
MFNpZ25pbmclMjBQQ0ElMjAyMDIxLmNybDB9BggrBgEFBQcBAQRxMG8wbQYIKwYB
BQUHMAKGYWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMvTWlj
cm9zb2Z0JTIwSUQlMjBWZXJpZmllZCUyMENvZGUlMjBTaWduaW5nJTIwUENBJTIw
MjAyMS5jcnQwDQYJKoZIhvcNAQEMBQADggIBAAbVUF5UdNVEGWOVxkPciIzHA/Iy
NDIs1oSdW7mY4ObaFEEl8fwawEsBOascBzwXjuOaTkKelQ+IiC4JvDpn8pWPgOyi
Krbbw1Iswt7AV8YyuLu7A0YshILlxyny9R0AMMQixLZ0T5Aj07CQOm/de5QPt36E
CBwtVww6XUCx8Rm2xl6eEa9JhSub8W4urQGoQYv0Zczlz4ej2ryj5Wf9L4ZZA3bL
6CRE7XmzSQjTmdSmr904PiuL2uBWzq2KkR3RhmoaAP4Jk2JplasNM5Bs0+dx3YX2
o6xRrbSaJiu6hPk/AkBoj5BCJMTZkl4wk6Q6nOFNSCpUxnBmJ0RRkoKq51p5ADTx
bCeRAx8rIfNpTyPjxQtxTiFTC8yy/t9K6s570YB1FAI+8XxZxIrmgMd7xVUkzi2/
oooKb3UeovH0lqYGBEjpHZJ9jee7boQbOe7SsKD/vr3PzFabg9VwLZlovpWUpWoW
nU2w3xiozJ/m35tsZVvT2egUpwkb9TDIaXFGZAGV94FRDHn/K2XNnOwSeGskX19M
B+N7yPc51fmUSd49MVAtGW/NkUGpRech5Aq/d8dCML2bZ+j9nTUMgj+qnd3wuEZV
RbQEIbTh9HAck0fyKqoIb+qh8y/6TKbYDEEOcfM2BGMvrQk4WIGCK6u8uFhA2EH3
kpaiMUDqyFCeCCQx
-----END CERTIFICATE-----
'@
$publicPcaPem=@'
-----BEGIN CERTIFICATE-----
MIIHnjCCBYagAwIBAgITMwAAAAeHozSje6WOHAAAAAAABzANBgkqhkiG9w0BAQwF
ADB3MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MUgwRgYDVQQDEz9NaWNyb3NvZnQgSWRlbnRpdHkgVmVyaWZpY2F0aW9uIFJvb3Qg
Q2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMjAwHhcNMjEwNDAxMjAwNTIwWhcNMzYw
NDAxMjAxNTIwWjBjMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENv
cnBvcmF0aW9uMTQwMgYDVQQDEytNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ29kZSBT
aWduaW5nIFBDQSAyMDIxMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA
svDArxmIKOLdVHpMSWxpCFUJtFL/ekr4weslKPdnF3cpTeuV8veqtmKVgok2rO0D
05BpyvUDCg1wdsoEtuxACEGcgHfjPF/nZsOkg7c0mV8hpMT/GvB4uhDvWXMIeQPs
DgCzUGzTvoi76YDpxDOxhgf8JuXWJzBDoLrmtThX01CE1TCCvH2sZD/+Hz3RDwl2
MsvDSdX5rJDYVuR3bjaj2QfzZFmwfccTKqMAHlrz4B7ac8g9zyxlTpkTuJGtFnLB
GasoOnn5NyYlf0xF9/bjVRo4Gzg2Yc7KR7yhTVNiuTGH5h4eB9ajm1OCShIyhrKq
gOkc4smz6obxO+HxKeJ9bYmPf6KLXVNLz8UaeARo0BatvJ82sLr2gqlFBdj1sYfq
Of00Qm/3B4XGFPDK/H04kteZEZsBRc3VT2d/iVd7OTLpSH9yCORV3oIZQB/Qr4nD
4YT/lWkhVtw2v2s0TnRJubL/hFMIQa86rcaGMhNsJrhysLNNMeBhiMezU1s5zpus
f54qlYu2v5sZ5zL0KvBDLHtL8F9gn6jOy3v7Jm0bbBHjrW5yQW7S36ALAt03QDpw
W1JG1Hxu/FUXJbBO2AwwVG4Fre+ZQ5Od8ouwt59FpBxVOBGfN4vN2m3fZx1gqn52
GvaiBz6ozorgIEjn+PhUXILhAV5Q/ZgCJ0u2+ldFGjcCAwEAAaOCAjUwggIxMA4G
A1UdDwEB/wQEAwIBhjAQBgkrBgEEAYI3FQEEAwIBADAdBgNVHQ4EFgQU2UEpsA8P
Y2zvadf1zSmepEhqMOYwVAYDVR0gBE0wSzBJBgRVHSAAMEEwPwYIKwYBBQUHAgEW
M2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvRG9jcy9SZXBvc2l0b3J5
Lmh0bTAZBgkrBgEEAYI3FAIEDB4KAFMAdQBiAEMAQTAPBgNVHRMBAf8EBTADAQH/
MB8GA1UdIwQYMBaAFMh+0mqFKhvKGZgEByfPUBBPaKiiMIGEBgNVHR8EfTB7MHmg
d6B1hnNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNyb3Nv
ZnQlMjBJZGVudGl0eSUyMFZlcmlmaWNhdGlvbiUyMFJvb3QlMjBDZXJ0aWZpY2F0
ZSUyMEF1dGhvcml0eSUyMDIwMjAuY3JsMIHDBggrBgEFBQcBAQSBtjCBszCBgQYI
KwYBBQUHMAKGdWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMv
TWljcm9zb2Z0JTIwSWRlbnRpdHklMjBWZXJpZmljYXRpb24lMjBSb290JTIwQ2Vy
dGlmaWNhdGUlMjBBdXRob3JpdHklMjAyMDIwLmNydDAtBggrBgEFBQcwAYYhaHR0
cDovL29uZW9jc3AubWljcm9zb2Z0LmNvbS9vY3NwMA0GCSqGSIb3DQEBDAUAA4IC
AQB/JSqe/tSr6t1mCttXI0y6XmyQ41uGWzl9xw+WYhvOL47BV09Dgfnm/tU4ieeZ
7NAR5bguorTCNr58HOcA1tcsHQqt0wJsdClsu8bpQD9e/al+lUgTUJEV80Xhco7x
dgRrehbyhUf4pkeAhBEjABvIUpD2LKPho5Z4DPCT5/0TlK02nlPwUbv9URREhVYC
tsDM+31OFU3fDV8BmQXv5hT2RurVsJHZgP4y26dJDVF+3pcbtvh7R6NEDuYHYihf
mE2HdQRq5jRvLE1Eb59PYwISFCX2DaLZ+zpU4bX0I16ntKq4poGOFaaKtjIA1vRE
lItaOKcwtc04CBrXSfyL2Op6mvNIxTk4OaswIkTXbFL81ZKGD+24uMCwo/pLNhn7
VHLfnxlMVzHQVL+bHa9KhTyzwdG/L6uderJQn0cGpLQMStUuNDArxW2wF16QGZ1N
tBWgKA8Kqv48M8HfFqNifN6+zt6J0GwzvU8g0rYGgTZR8zDEIJfeZxwWDHpSxB5F
J1VVU1LIAtB7o9PXbjXzGifaIMYTzU4YKt4vMNwwBmetQDHhdAtTPplOXrnI9SI6
HeTtjDD3iUN/7ygbahmYOHk7VB7fwT4ze+ErCbMh6gHV1UuXPiLciloNxH6K4aMf
ZN1oLVk6YFeIJEokuPgNPa6EnTiOL60cPqfny+Fq8UiuZw==
-----END CERTIFICATE-----
'@
# Genuine Microsoft ID Verified CS EOC CA 03 and 04, both issued by PCA 2021 (public AIA certificates); no private key.
$publicEoc03Pem=@'
-----BEGIN CERTIFICATE-----
MIIHKDCCBRCgAwIBAgITMwAAABUFPm4ZjpMp2QAAAAAAFTANBgkqhkiG9w0BAQwF
ADBjMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MTQwMgYDVQQDEytNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ29kZSBTaWduaW5nIFBD
QSAyMDIxMB4XDTI2MDMyNjE4MTEyOFoXDTMxMDMyNjE4MTEyOFowWjELMAkGA1UE
BhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjErMCkGA1UEAxMi
TWljcm9zb2Z0IElEIFZlcmlmaWVkIENTIEVPQyBDQSAwMzCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAOD0yz0Cqi8Ocx4+8w574rJuEJ3z6WiTNg5GVLeQ
FVex55xvIbAFyx6eWblsu0wY+OIgUvMFAX6CGVVX9Tb2rkZx14QQEIdNMaEvaSgi
stzhSuWIxFxu/2Y4y1H+Xv/ECa/QXHgEkefV0e3ft++sGpeYqMp8Z/kOnI7/6GdX
tMSt4y1LX2I75uNn/0eemDc8KTR7thJtFMWTH3sVnBFakLizc16lF9FdCH9YwCPs
maxh5VmiGLhMXnJbYkyslmrAdzLMlli0PYeWejlkQmR2JlwRrEc6hubA7TpnUn1z
bemz08YiEZqrWwosQDP0OhzmsuRhYa14OuxwqECnaQhz+hiUf0iPoGQ6qqBYg0SQ
S0Lxk0bUxqT6HejrlqPSJAqZ3Fbshloc7ly7KgyL4q1h9d4giDexUhtLYQvyRS2w
MZ0So2oCr+KypOLWNeot7qIqnWeLVI9289b0bTcJOxgXrxv/K4hBHBt2gEJd6Yw0
kJLR2isJFjhvZYADLieDtIA1wSCsGBl/nfn5B8tTmEbOsqMilsxptq5ZvkUpZQqQ
yw9xcWRdFY7iego+bgpaUXKmo6lsn8o41VF4iXEdBF6AA4HMiFEHuCv0gNDWxzYy
A6BD7FUZbiirgcPSZ8CLCLIuyRmuRpDsmhqdiME1xH1FLbpjEBVtwG0uK0VPMIgS
Dll1AgMBAAGjggHcMIIB2DAOBgNVHQ8BAf8EBAMCAYYwEAYJKwYBBAGCNxUBBAMC
AQAwHQYDVR0OBBYEFGtepTTDBcViSiFajqtzYGLUrGOFMFQGA1UdIARNMEswSQYE
VR0gADBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtp
b3BzL0RvY3MvUmVwb3NpdG9yeS5odG0wGQYJKwYBBAGCNxQCBAweCgBTAHUAYgBD
AEEwEgYDVR0TAQH/BAgwBgEB/wIBADAfBgNVHSMEGDAWgBTZQSmwDw9jbO9p1/XN
KZ6kSGow5jBwBgNVHR8EaTBnMGWgY6Bhhl9odHRwOi8vd3d3Lm1pY3Jvc29mdC5j
b20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ29kZSUy
MFNpZ25pbmclMjBQQ0ElMjAyMDIxLmNybDB9BggrBgEFBQcBAQRxMG8wbQYIKwYB
BQUHMAKGYWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMvTWlj
cm9zb2Z0JTIwSUQlMjBWZXJpZmllZCUyMENvZGUlMjBTaWduaW5nJTIwUENBJTIw
MjAyMS5jcnQwDQYJKoZIhvcNAQEMBQADggIBAF1uIjzPBctfyCUkSH/xDbZQwJSF
YE7jpn0U+HA5HeZ2WpFUuRg6if8xzNTCuMOHHdf31I8fk9J+WQahO+c71lYczlgV
Vik7s1i4H6Z9VIYAZnCIY4BJaTSLYHu+f2cSUkmaiJfG6B8flh0GytSBO3QAU1eT
OapOCT5LUfFvW7/QcKoQdVk+TYD/p4ldhu2lEzkVzPTSOKxSX0FFmBJ5s4NXzlsH
M696rILd/Q+ccLFEk2ExvzE/+wH9Ujul/auF5JXvOpRK/y+f98gxuVd5pUiWmqir
xI/0EkyMT8KhVcnGeRlBEzUVruQ33LO29F46HFKA+ClnH9eX+OTDIQVUlMF8Gnex
OB8hz+maq/Z6G1qQvYASPvwSY49CiHElPfDJf4/vwYDbm0ukC/OPdEwwd3zPXxm6
5WL7rQwDMak4BIfUvw2Wvd9lFmdA76nLJ7YMK9iYdoh91SBgmqfuejHEZW/z35Fo
ROHW2AIO/A2kUJIbu+XkDhqSj7Z/HjT2v1NaNcLs6J/UhDlknMHhF/wa8GIdiO8y
YemV52nUUZEt1JEVWkLf84qlljpq8ipmnv7yk/9ZA/3TcN2Cu8BPpbjE84HFc9ri
0aSw3dK6olqIVgdI3J4G5+fyKx66NbghsFJscPgE+psXepn7ucb13938bb8vHiQf
1wKYF+axl1KQea6Q
-----END CERTIFICATE-----
'@
$publicEoc04Pem=@'
-----BEGIN CERTIFICATE-----
MIIHKDCCBRCgAwIBAgITMwAAABcnRQkLi4evxgAAAAAAFzANBgkqhkiG9w0BAQwF
ADBjMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MTQwMgYDVQQDEytNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ29kZSBTaWduaW5nIFBD
QSAyMDIxMB4XDTI2MDMyNjE4MTEzMVoXDTMxMDMyNjE4MTEzMVowWjELMAkGA1UE
BhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjErMCkGA1UEAxMi
TWljcm9zb2Z0IElEIFZlcmlmaWVkIENTIEVPQyBDQSAwNDCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAILHZP4DD2YqAZXMn5OrQ8yfj0beK0ixilvHsKUt
JEcV7VEQt09xnWwipY6GxJ/LrLKoRqkKUYf0l70VcDVxCBm++lBuSD5AidUuv/QQ
+tUELCsz3qVtEjY/E14LBcb0uzJbaEbopCCKe0OY0IGjjOkMivfvumVV1KWJmbpQ
HusfCa8GdHTZBPq2euparaKHMHqVElVMTO6HQ5p/Mgx4ydgzT7H697kQ4sd1+Kr4
deIx/0lvtgse1iDIciIkDttNYuoVIsZpOHtmVvFuwtcD3U46ugSm/s6PMW67e2Sk
L0V+UDgOnYS6rj6o+bFSp8an5NfSAtEmn00k7PMguNxMPeuQUUVvFS/XHKDpq+K8
UMu2goGEzZN3Xfy6YTWk05pxqe5Ji08ch5AeYHqFoWLrhq8sEvBNMCb9FuK3zrRw
VdHvbCr7lCHiFKZ7MeopcRFY+lUF74A+sngipz5o94yYiSgJZlA7bYecs0VQVJeO
LDIhuC+Uf8sgAkSpNp9PPENmAqGUtTvOvqDCyrdY2lxhAjo27FafCHdVUMPIXuid
CoqzkuXtuV5U3RjxW+qATjmmnIFu/Co39G6fl8wIJHPdpgxjSRmEo73Z4/u3jMep
nltAwCBnS0TY/P+NvTCLKRQX89yg6qqTe9UuJENiy3q93cYQw3MylRS9By8Ebjr4
I4hvAgMBAAGjggHcMIIB2DAOBgNVHQ8BAf8EBAMCAYYwEAYJKwYBBAGCNxUBBAMC
AQAwHQYDVR0OBBYEFJrxVHd1DIcWN0agrN55+fR/wXjpMFQGA1UdIARNMEswSQYE
VR0gADBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtp
b3BzL0RvY3MvUmVwb3NpdG9yeS5odG0wGQYJKwYBBAGCNxQCBAweCgBTAHUAYgBD
AEEwEgYDVR0TAQH/BAgwBgEB/wIBADAfBgNVHSMEGDAWgBTZQSmwDw9jbO9p1/XN
KZ6kSGow5jBwBgNVHR8EaTBnMGWgY6Bhhl9odHRwOi8vd3d3Lm1pY3Jvc29mdC5j
b20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ29kZSUy
MFNpZ25pbmclMjBQQ0ElMjAyMDIxLmNybDB9BggrBgEFBQcBAQRxMG8wbQYIKwYB
BQUHMAKGYWh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMvTWlj
cm9zb2Z0JTIwSUQlMjBWZXJpZmllZCUyMENvZGUlMjBTaWduaW5nJTIwUENBJTIw
MjAyMS5jcnQwDQYJKoZIhvcNAQEMBQADggIBAJB1Whn9TSbfyXaIppkWWzFq+m2m
g4vJpHVr1krZNIXWQ6cUmEwOx7oqQKCy96iISNdNVzpe3zogoefvo2TmpkHQFe/a
IxFDaCIAmZi9lyay2hmp8HYzcp3nCcmFQk60X9voeypJ6VjqeGsXTrOivWUOYNCL
EFlwsH3NHX5EpCyjWN6Q3Fi5ST4do3eTVLnuqTQ7/9huTBTSYQsJbTg3m8gIxnHl
Plzs2r/u4u9tWEJ0Pt/ZtmkDhTu86QHWigHgBoRHemOgnQxp3ksXKLo1r2n1m7+G
st46NTkUi1LljGyq+V9fEBOEnXvoKaRiy0pGbK1IdnsmEpF9Xp71l+2T84Nv8Iri
kZUBWqw5/jffttAas4ccJDci832CadS4OHwl29uF6hY8fEg3UYHmxSJjnzi1c3vF
0PwsJKxGom9Dx7treBlZOBWK6BGzVBar43Qb02N7okeU3UKMl6GB74fk8aS0mNr6
O4YSvQ/66RKRwvqppnEVBOHdIMjvWW9b77duX8TN3pI7w31R3D6t6jK9EcLJOJKy
mVlBIFNUl0+ajeoKka7IcW0+jkIGff8U9OKol3cz0Eeiop3Qb0qaDp8ZwC8XCcs1
cDaSi/vbvBGWMvfKl+ovuIBP9ienG6XpHAdGVw5/10MaDVFG+v3Y0/8JZVchvryB
5Hau9T82x+a2MXXA
-----END CERTIFICATE-----
'@
function Set-PublicIdentityVariables([string] $RootSha256) {
    $env:QUALSIGN_EXPECTED_SUBJECT='Ferrox Labs, LLC'
    $env:QUALSIGN_EXPECTED_ISSUER_PREFIX='Microsoft ID Verified CS '
    $env:QUALSIGN_EXPECTED_ROOT_CN='Microsoft Identity Verification Root Certificate Authority 2020'
    $env:QUALSIGN_EXPECTED_ROOT_SHA256=$RootSha256
    $env:QUALSIGN_EXPECTED_EKU='1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.97.1.0,1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577'
}
# Subject key and signing key are separate, so each link can carry the right DN under the wrong key.
function New-LinkedTestCert($Subject, $SubjectKey, $IssuerName, $IssuerKey, [bool] $Ca, [string[]] $Ekus) {
    $name = if ($Subject -is [string]) { [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject) } else { $Subject }
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new($name,$SubjectKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($Ca,$false,0,$true))
    if ($Ekus) {
        $usages=[Security.Cryptography.OidCollection]::new(); foreach ($oid in $Ekus) { $null=$usages.Add([Security.Cryptography.Oid]::new($oid)) }
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages,$false))
    }
    $generator=[Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA($IssuerKey,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.Create($IssuerName,$generator,[DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1),[byte[]](Get-Random -Count 8 -Minimum 1 -Maximum 255))
}
function New-TestCa($Subject, $IssuerName, $Key, [bool] $Ca = $true) {
    $name = if ($Subject -is [string]) { [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject) } else { $Subject }
    $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new($name,$Key,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($Ca,$false,0,$true))
    $generator=[Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForRSA($Key,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.Create($IssuerName,$generator,[DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1),[byte[]](Get-Random -Count 8 -Minimum 1 -Maximum 255))
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
        # Receipt mode re-runs the full identity guard on the file's Authenticode signer and the chain Verify recorded.
        $publicChain=@(@($publicLeafPem,$publicIssuerPem,$publicPcaPem,$publicRootPem) | ForEach-Object { [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($_) })
        $signer=$publicChain[0]; Set-PublicIdentityVariables (Get-DerSha256 $publicChain[3])
        function global:Get-AuthenticodeSignature { [pscustomobject]@{Status=$global:FixtureSignatureStatus;SignerCertificate=$global:FixtureSigner} }
        $global:FixtureSignatureStatus='Valid'; $global:FixtureSigner=$signer
        $verificationPath=Join-Path $Scratch 'verification.json'; $receiptPath=Join-Path $folder 'qualsign-receipt.json'
        $neutral=@{signedSha256=(Get-Sha256 $file);leafDerSha256=('f'*64);subject='CN=Neutral';issuer='CN=Neutral issuer';ekus=@('1.3.6.1.5.5.7.3.3');signtoolExit=0;signtoolPath='C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe';signtoolSha256=('1'*64)}
        Save-Json $verificationPath $neutral; Assert-Reject { & $helper -Mode Receipt } 'CN=Neutral chain-less identity'
        $neutral.leafDerSha256=Get-DerSha256 $signer; Save-Json $verificationPath $neutral; Assert-Reject { & $helper -Mode Receipt } 'CN=Neutral identity on the real signer without a chain'
        if (Test-Path -LiteralPath $receiptPath) { throw 'Refused identity wrote a receipt' }
        $ekus=Get-LeafEkus $signer
        $verified=@{signedSha256=(Get-Sha256 $file);leafDerSha256=(Get-DerSha256 $signer);subject=$signer.Subject;issuer=$signer.Issuer;ekus=$ekus;chainSubjects=@($publicChain | ForEach-Object { $_.Subject });chainDer=@($publicChain | ForEach-Object { [Convert]::ToBase64String($_.RawData) });signtoolExit=0;signtoolPath='C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe';signtoolSha256=('1'*64)}
        $receiptKey=[Security.Cryptography.RSA]::Create(2048)
        try {
            $lookalikePca=New-TestCa $publicChain[2].SubjectName $publicChain[3].SubjectName $receiptKey
            $crossRoot=New-TestCa $publicChain[3].SubjectName $publicChain[3].SubjectName $receiptKey
            $otherSigner=New-TestCa 'CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"' $publicChain[1].SubjectName $receiptKey $false
            # Astra's substitution: the recorded issuer keeps both DNs of AOC CA 04 but carries a different key.
            $sameDnIssuer=New-TestCa $publicChain[1].SubjectName $publicChain[2].SubjectName $receiptKey
        } finally { $receiptKey.Dispose() }
        $der={param($certs) @($certs | ForEach-Object { [Convert]::ToBase64String($_.RawData) })}
        foreach ($case in @(
            @{label='lookalike PCA 2021 with the exact DN and a different key';change={param($v) $v.chainDer=& $der @($publicChain[0],$publicChain[1],$lookalikePca,$publicChain[3])}},
            @{label='issuer with the exact DNs and a different key';change={param($v) $v.chainDer=& $der @($publicChain[0],$sameDnIssuer,$publicChain[2],$publicChain[3])}},
            @{label='extra certificate after the root';change={param($v) $v.chainDer=& $der @($publicChain[0],$publicChain[1],$publicChain[2],$publicChain[3],$sameDnIssuer); $v.chainSubjects=@($publicChain[0],$publicChain[1],$publicChain[2],$publicChain[3],$sameDnIssuer | ForEach-Object { $_.Subject })}},
            @{label='three-element chain';change={param($v) $v.chainDer=& $der @($publicChain[0],$publicChain[1],$publicChain[3])}},
            @{label='five-element linked chain with the PCA at index 2';change={param($v) $v.chainDer=& $der @($publicChain[0],$publicChain[1],$publicChain[2],$crossRoot,$publicChain[3])}},
            @{label='chain without the signer leaf';change={param($v) $v.chainDer=& $der @($otherSigner,$publicChain[1],$publicChain[2],$publicChain[3])}},
            @{label='recorded leaf digest of another signer';change={param($v) $v.leafDerSha256=Get-DerSha256 $otherSigner}},
            @{label='recorded subject differs from the signer';change={param($v) $v.subject='CN=Neutral'}},
            @{label='recorded issuer differs from the signer';change={param($v) $v.issuer='CN=Neutral issuer'}},
            @{label='recorded chain subjects differ';change={param($v) $v.chainSubjects=@('CN=Neutral')}},
            @{label='recorded EKUs differ from the signer';change={param($v) $v.ekus=@('1.3.6.1.5.5.7.3.3')}}
        )) {
            $m=$verified.Clone(); & $case.change $m; Save-Json $verificationPath $m
            Assert-Reject { & $helper -Mode Receipt } "receipt $($case.label)"
            if (Test-Path -LiteralPath $receiptPath) { throw "Refused receipt was written: $($case.label)" }
        }
        Save-Json $verificationPath $verified
        $global:FixtureSigner=$otherSigner; Assert-Reject { & $helper -Mode Receipt } 'receipt file signed by another leaf'
        $global:FixtureSigner=$signer; $global:FixtureSignatureStatus='NotSigned'; Assert-Reject { & $helper -Mode Receipt } 'receipt file not Authenticode valid'
        $global:FixtureSignatureStatus='Valid'
        $env:QUALSIGN_EXPECTED_ROOT_SHA256='0'*64; Assert-Reject { & $helper -Mode Receipt } 'receipt root pin'
        $env:QUALSIGN_EXPECTED_ROOT_SHA256=Get-DerSha256 $publicChain[3]
        # Root with the exact DN and a different key, and a root pin that matches it: names and pins pass, the PCA 2021 signature does not.
        $m=$verified.Clone(); $m.chainDer=& $der @($publicChain[0],$publicChain[1],$publicChain[2],$crossRoot); Save-Json $verificationPath $m
        $env:QUALSIGN_EXPECTED_ROOT_SHA256=Get-DerSha256 $crossRoot; Assert-Reject { & $helper -Mode Receipt } 'receipt root with the exact DN and a different key'
        $env:QUALSIGN_EXPECTED_ROOT_SHA256=Get-DerSha256 $publicChain[3]; Save-Json $verificationPath $verified
        if (Test-Path -LiteralPath $receiptPath) { throw 'Refused receipt was written' }
        & $helper -Mode Receipt
        $receipt=Get-Content $receiptPath -Raw | ConvertFrom-Json
        Assert-Equal $receipt.leafDerSha256 (Get-DerSha256 $signer) 'receipt leaf'; Assert-Equal $receipt.chainDer.Count 4 'receipt chain'
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
if ($Group -eq 'Identity') {
    $leaf=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicLeafPem)
    $rootCert=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicRootPem)
    $env:QUALSIGN_EXPECTED_SUBJECT='Ferrox Labs, LLC'
    $env:QUALSIGN_EXPECTED_ISSUER_PREFIX='Microsoft ID Verified CS '
    $env:QUALSIGN_EXPECTED_ROOT_CN='Microsoft Identity Verification Root Certificate Authority 2020'
    $env:QUALSIGN_EXPECTED_ROOT_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rootCert.RawData)).ToLowerInvariant()
    $env:QUALSIGN_EXPECTED_EKU='1.3.6.1.5.5.7.3.3,1.3.6.1.4.1.311.97.1.0,1.3.6.1.4.1.311.97.694597467.326663264.393302725.691001577'
    $ekus=@($leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages | ForEach-Object {$_.Value} })
    Assert-LeafIdentity $leaf $rootCert $ekus
    foreach ($dn in @('CN="Ferrox Labs, LLC"','CN="Ferrox Labs, LLC", O=Other','CN="Ferrox Labs, LLC extra", O="Ferrox Labs, LLC"','CN="ferrox labs, llc", O="Ferrox Labs, LLC"','CN="Ferrox Labs, LLC", CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"')) {
        $mutant=[pscustomobject]@{SubjectName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($dn);IssuerName=$leaf.IssuerName}
        Assert-Reject { Assert-LeafIdentity $mutant $rootCert $ekus } "subject $dn"
    }
    foreach ($dn in @('CN=Microsoft ID Verified CS XOC CA 01, O=Microsoft Corporation','CN=Microsoft ID Verified CS EOC CA 4, O=Microsoft Corporation','CN=Microsoft ID Verified CS AOC CA 4x, O=Microsoft Corporation','CN=Microsoft ID Verified CS EOC CA 04, O=Other','CN=Microsoft ID Verified CS AOC CA 04, O=Other')) {
        $mutant=[pscustomobject]@{SubjectName=$leaf.SubjectName;IssuerName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($dn)}
        Assert-Reject { Assert-LeafIdentity $mutant $rootCert $ekus } "issuer $dn"
    }
    foreach ($dn in @('CN=Microsoft ID Verified CS AOC CA 01, O=Microsoft Corporation','CN=Microsoft ID Verified CS EOC CA 03, O=Microsoft Corporation','CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation')) {
        $mutant=[pscustomobject]@{SubjectName=$leaf.SubjectName;IssuerName=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($dn)}
        Assert-LeafIdentity $mutant $rootCert $ekus
    }
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
    # Execute the actual chain guard (length, leaf, links, PCA 2021 CN and DER pin, then leaf identity) on the real public chain and generated lookalikes.
    $issuerCert=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicIssuerPem)
    $pcaCert=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($publicPcaPem)
    Assert-Equal (Get-DerSha256 $pcaCert) '3d29798cc5d3f0644a7e0dc9cb1cade523ea5ec83b335109b605bfeaa7d5f5c1' 'public PCA 2021 DER'
    Set-PublicIdentityVariables (Get-DerSha256 $rootCert)
    Assert-SignerChain $leaf @($leaf,$issuerCert,$pcaCert,$rootCert) $ekus
    # The offline signature chain accepts the genuine AOC chain and the genuine EOC CA 03 and 04 under PCA 2021, trusting only the pinned root.
    Assert-Equal (@((Get-SignedChain $leaf @($leaf,$issuerCert,$pcaCert,$rootCert)) | ForEach-Object { Get-DerSha256 $_ }) -join ',') ((@($leaf,$issuerCert,$pcaCert,$rootCert) | ForEach-Object { Get-DerSha256 $_ }) -join ',') 'genuine AOC signed chain'
    foreach ($pem in @($publicEoc03Pem,$publicEoc04Pem)) {
        $eocCa=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($pem)
        Assert-Equal (@((Get-SignedChain $eocCa @($eocCa,$pcaCert,$rootCert)) | ForEach-Object { Get-DerSha256 $_ }) -join ',') ((@($eocCa,$pcaCert,$rootCert) | ForEach-Object { Get-DerSha256 $_ }) -join ',') "genuine $(Get-RdnValue $eocCa.SubjectName '2.5.4.3') signed chain"
        if ((Get-RdnValue $eocCa.SubjectName '2.5.4.3') -cnotmatch '\AMicrosoft ID Verified CS EOC CA 0[34]\z') { throw 'Control failed: genuine EOC CA fixture' }
        Assert-Reject { Get-SignedChain $eocCa @($eocCa,$issuerCert,$pcaCert,$rootCert) } "genuine $(Get-RdnValue $eocCa.SubjectName '2.5.4.3') with an unused extra certificate"
    }
    # A fully signed generated hierarchy with the real DNs. Only the PCA DER pin constant is swapped, in a test-side copy of Assert-ChainPins.
    $pcaPin='3d29798cc5d3f0644a7e0dc9cb1cade523ea5ec83b335109b605bfeaa7d5f5c1'
    $pinsText=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ChainPins'},$false))[0].Extent.Text
    if (([regex]::Matches($pinsText,$pcaPin)).Count -ne 1) { throw 'PCA pin swap must replace exactly one constant' }
    $withPin={param([string] $Pin,[scriptblock] $Code) & { Invoke-Expression $pinsText.Replace($pcaPin,$Pin); & $Code } }
    $keys=@{}; foreach ($name in @('root','pca','issuer','leaf','fake')) { $keys[$name]=[Security.Cryptography.RSA]::Create(2048) }
    try {
        $leafDn='CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"'; $eocDn='CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation'
        $gRoot=New-LinkedTestCert $rootCert.SubjectName $keys.root $rootCert.SubjectName $keys.root $true
        $gPca=New-LinkedTestCert $pcaCert.SubjectName $keys.pca $rootCert.SubjectName $keys.root $true
        $gIssuer=New-LinkedTestCert $eocDn $keys.issuer $pcaCert.SubjectName $keys.pca $true
        $gLeaf=New-LinkedTestCert $leafDn $keys.leaf $gIssuer.SubjectName $keys.issuer $false $ekus
        $gAocIssuer=New-LinkedTestCert 'CN=Microsoft ID Verified CS AOC CA 01, O=Microsoft Corporation' $keys.issuer $pcaCert.SubjectName $keys.pca $true
        $gAocLeaf=New-LinkedTestCert $leafDn $keys.leaf $gAocIssuer.SubjectName $keys.issuer $false $ekus
        # Same DN at each link position, different key: leaf signed by a fixture key, issuer, PCA 2021 and root re-keyed.
        $fLeaf=New-LinkedTestCert $leafDn $keys.leaf $gIssuer.SubjectName $keys.fake $false $ekus
        $fIssuer=New-LinkedTestCert $eocDn $keys.fake $pcaCert.SubjectName $keys.pca $true
        $fPca=New-LinkedTestCert $pcaCert.SubjectName $keys.fake $rootCert.SubjectName $keys.root $true
        $fRoot=New-LinkedTestCert $rootCert.SubjectName $keys.fake $rootCert.SubjectName $keys.fake $true
    } finally { foreach ($key in $keys.Values) { $key.Dispose() } }
    $gPin=Get-DerSha256 $gPca
    Set-PublicIdentityVariables (Get-DerSha256 $gRoot)
    Assert-Reject { Assert-SignerChain $gLeaf @($gLeaf,$gIssuer,$gPca,$gRoot) $ekus } 'generated PCA without the pin swap'
    & $withPin $gPin { Assert-SignerChain $gLeaf @($gLeaf,$gIssuer,$gPca,$gRoot) $ekus }
    & $withPin $gPin { Assert-SignerChain $gAocLeaf @($gAocLeaf,$gAocIssuer,$gPca,$gRoot) $ekus }
    foreach ($case in @(
        @{label='leaf signed by a different key';signer=$fLeaf;certs=@($fLeaf,$gIssuer,$gPca,$gRoot);pin=$gPin;root=$gRoot},
        @{label='issuer with the same DN and a different key';signer=$gLeaf;certs=@($gLeaf,$fIssuer,$gPca,$gRoot);pin=$gPin;root=$gRoot},
        @{label='PCA 2021 with the same DN and a different key, pin matching it';signer=$gLeaf;certs=@($gLeaf,$gIssuer,$fPca,$gRoot);pin=(Get-DerSha256 $fPca);root=$gRoot},
        @{label='root with the same DN and a different key, pin matching it';signer=$gLeaf;certs=@($gLeaf,$gIssuer,$gPca,$fRoot);pin=$gPin;root=$fRoot}
    )) {
        $env:QUALSIGN_EXPECTED_ROOT_SHA256=Get-DerSha256 $case.root
        & $withPin $case.pin { Assert-ChainPins $case.signer $case.certs $ekus }
        Assert-Reject { & $withPin $case.pin { Assert-SignerChain $case.signer $case.certs $ekus } } "signed chain $($case.label)"
    }
    $env:QUALSIGN_EXPECTED_ROOT_SHA256=Get-DerSha256 $gRoot
    foreach ($case in @(
        @{label='truncated before the root';certs=@($gLeaf,$gIssuer,$gPca)},
        @{label='truncated to the leaf and issuer';certs=@($gLeaf,$gIssuer)},
        @{label='leaf only';certs=@($gLeaf)},
        @{label='extra certificate after the root';certs=@($gLeaf,$gIssuer,$gPca,$gRoot,$fIssuer)},
        @{label='extra same-DN issuer beside the signing issuer';certs=@($gLeaf,$fIssuer,$gIssuer,$gPca,$gRoot)}
    )) {
        Assert-Reject { & $withPin $gPin { Assert-SignerChain $gLeaf $case.certs $ekus } } "signed chain $($case.label)"
    }
    Set-PublicIdentityVariables (Get-DerSha256 $rootCert)
    $chainKey=[Security.Cryptography.RSA]::Create(2048)
    try {
        $eocIssuer=New-TestCa 'CN=Microsoft ID Verified CS EOC CA 04, O=Microsoft Corporation' $pcaCert.SubjectName $chainKey
        $eocLeafRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN="Ferrox Labs, LLC", O="Ferrox Labs, LLC"',$chainKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $eocUsages=[Security.Cryptography.OidCollection]::new(); foreach($oid in $ekus){$null=$eocUsages.Add([Security.Cryptography.Oid]::new($oid))}
        $eocLeafRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eocUsages,$false))
        $eocLeaf=$eocLeafRequest.Create([Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($eocIssuer,$chainKey),[DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddMinutes(1),[byte[]]@(7,8,9))
        # Same DN, different key: this EOC issuer names the genuine PCA 2021 as its issuer but a fixture key signed it.
        # Names, links and pins alone accept it; only the offline signature chain refuses it.
        Assert-ChainPins $eocLeaf @($eocLeaf,$eocIssuer,$pcaCert,$rootCert) $ekus
        Assert-Reject { Assert-SignerChain $eocLeaf @($eocLeaf,$eocIssuer,$pcaCert,$rootCert) $ekus } 'chain EOC issuer naming the genuine PCA 2021, signed by a different key'
        $lookalikePca=New-TestCa $pcaCert.SubjectName $rootCert.SubjectName $chainKey
        Assert-Equal (Get-RdnValue $lookalikePca.SubjectName '2.5.4.3') 'Microsoft ID Verified Code Signing PCA 2021' 'lookalike PCA CN'
        $crossRoot=New-TestCa $rootCert.SubjectName $rootCert.SubjectName $chainKey
        $selfSignedIssuer=New-TestCa $issuerCert.SubjectName $issuerCert.SubjectName $chainKey
        foreach ($case in @(
            @{label='two elements';signer=$leaf;certs=@($leaf,$rootCert)},
            @{label='three elements without the PCA';signer=$leaf;certs=@($leaf,$issuerCert,$rootCert)},
            @{label='five linked elements with the PCA at index 2';signer=$leaf;certs=@($leaf,$issuerCert,$pcaCert,$crossRoot,$rootCert)},
            @{label='lookalike PCA 2021 with the exact DN and a different key';signer=$eocLeaf;certs=@($eocLeaf,$eocIssuer,$lookalikePca,$rootCert)},
            @{label='PCA one position early';signer=$leaf;certs=@($leaf,$pcaCert,$issuerCert,$rootCert)},
            @{label='self-signed middle with the issuer DN';signer=$leaf;certs=@($leaf,$selfSignedIssuer,$pcaCert,$rootCert)},
            @{label='chain of a different leaf';signer=$leaf;certs=@($eocLeaf,$eocIssuer,$pcaCert,$rootCert)}
        )) {
            Assert-Reject { Assert-SignerChain $case.signer $case.certs $ekus } "chain $($case.label)"
        }
        # The pin stage stays fail-closed on its own: each case below is refused only by its named check.
        foreach ($case in @(
            @{label='length: five linked elements with the PCA at index 2';signer=$leaf;certs=@($leaf,$issuerCert,$pcaCert,$crossRoot,$rootCert)},
            @{label='leaf binding: linked chain of a different leaf';signer=$leaf;certs=@($eocLeaf,$eocIssuer,$pcaCert,$rootCert)},
            @{label='links: issuer DN that the leaf does not name';signer=$leaf;certs=@($leaf,$eocIssuer,$pcaCert,$rootCert)}
        )) {
            Assert-Reject { Assert-ChainPins $case.signer $case.certs $ekus } "pins $($case.label)"
        }
        # A real X509Chain.Build: the same leaf under a self-signed middle with the middle's DN and key does not reach the trusted root.
        $rootRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Neutral Build Root',$chainKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
        $buildRoot=$rootRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1))
        $middleKey=[Security.Cryptography.RSA]::Create(2048)
        try {
            $middleRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Neutral Build Middle',$middleKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
            $middleRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
            $signedMiddle=$middleRequest.Create($buildRoot,[DateTimeOffset]::UtcNow.AddHours(-1),[DateTimeOffset]::UtcNow.AddHours(1),[byte[]]@(4,2))
            # Same DN and key as the root-signed middle, but self-signed: the leaf's signature verifies under both.
            $selfMiddle=$middleRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddHours(-1),[DateTimeOffset]::UtcNow.AddHours(1))
            $buildLeaf=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Neutral Build Leaf',$middleKey,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1).Create([Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($signedMiddle,$middleKey),[DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddMinutes(1),[byte[]]@(3,1))
            $build={param($extra)
                $testChain=[Security.Cryptography.X509Certificates.X509Chain]::new()
                try {
                    $testChain.ChainPolicy.TrustMode=[Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
                    $null=$testChain.ChainPolicy.CustomTrustStore.Add($buildRoot)
                    $null=$testChain.ChainPolicy.ExtraStore.Add($extra)
                    $testChain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
                    $testChain.ChainPolicy.DisableCertificateDownloads=$true
                    [pscustomobject]@{Built=$testChain.Build($buildLeaf);Count=$testChain.ChainElements.Count;Top=$testChain.ChainElements[$testChain.ChainElements.Count-1].Certificate.Thumbprint}
                } finally { $testChain.Dispose() }
            }
            $control=& $build $signedMiddle
            if (-not $control.Built -or $control.Count -ne 3) { throw "Control failed: X509Chain.Build of a root-signed middle ($($control.Built) $($control.Count))" }
            $refused=& $build $selfMiddle
            if ($refused.Built -or $refused.Count -ne 2 -or $refused.Top -cne $selfMiddle.Thumbprint) { throw "Mutant survived: X509Chain.Build accepted a self-signed middle ($($refused.Built) $($refused.Count))" }
        } finally { $middleKey.Dispose() }
    } finally { $chainKey.Dispose() }
    # Every verification.json and qualsign-receipt.json writer runs Assert-SignerChain earlier in the same mode branch.
    $modeIf=@($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Extent.Text.StartsWith("if (`$Mode -eq 'Bind')") })
    if ($modeIf.Count -ne 1) { throw 'Mode dispatch required' }
    $writers=0
    foreach ($clause in $modeIf[0].Clauses) {
        $commands=@($clause.Item2.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
        foreach ($save in @($commands | Where-Object { $_.GetCommandName() -eq 'Save-Json' -and ($_.Extent.Text.Contains("'verification.json'") -or $_.Extent.Text.Contains('$receiptPath')) })) {
            $writers++
            if (-not @($commands | Where-Object { $_.GetCommandName() -eq 'Assert-SignerChain' -and $_.Extent.EndOffset -lt $save.Extent.StartOffset }).Count) { throw "Identity guard required before $($save.Extent.Text)" }
        }
    }
    if ($writers -ne 2 -or ([regex]::Matches($ast.Extent.Text,'verification\.json|qualsign-receipt\.json')).Count -ne 3) { throw 'Exactly one verification writer and one receipt writer required' }
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
if ($Group -eq 'Pe') {
    # The cleared publish child must find the exact package folder restore filled, with no profile lookup.
    . ([IO.Path]::GetFullPath("$PSScriptRoot/../infra/windows-signing/collector/Inputs.ps1"))
    $rootMatch = [regex]::Match($build.run, '-PackageRoot "\$env:RUNNER_TEMP\\(?<leaf>[A-Za-z0-9-]+)"')
    if (-not $rootMatch.Success) { throw 'Build step must pass the restore package root' }
    $packageRoot = Join-Path $Scratch $rootMatch.Groups['leaf'].Value
    $cleanEnvironment = Get-CleanEnvironment (Join-Path $Scratch 'sdk/dotnet.exe') $Scratch $packageRoot
    Assert-Equal $cleanEnvironment['NUGET_PACKAGES'] $packageRoot 'NUGET_PACKAGES equals the restore package root'
    Assert-Equal $cleanEnvironment['USERPROFILE'] $Scratch 'USERPROFILE is the scratch directory'
    Assert-Equal $cleanEnvironment['APPDATA'] (Join-Path $Scratch 'appdata') 'APPDATA is a scratch subdirectory'
    Assert-Equal $cleanEnvironment['LOCALAPPDATA'] (Join-Path $Scratch 'localappdata') 'LOCALAPPDATA is a distinct scratch subdirectory'
    # Failing child: environment names (never values) and the last 200 diagnostic lines reach the thrown error.
    $failure = $null
    $secretValue = 'sentinel-value-' + [Guid]::NewGuid().ToString('N')
    $env:QUALSIGN_SELFCHECK_SENTINEL = $secretValue
    try {
        $pwshPath = (Get-Process -Id $PID).Path
        try { Invoke-Clean $pwshPath @('-NoProfile', '-Command', '1..250 | ForEach-Object { "diag-line-$_" }; exit 3') $Scratch $Scratch $packageRoot } catch { $failure = $_.Exception.Message }
    } finally { Remove-Item Env:QUALSIGN_SELFCHECK_SENTINEL -ErrorAction SilentlyContinue }
    if ($null -eq $failure) { throw 'Failing child must throw' }
    foreach ($expected in @('exit 3', 'Child environment variable names:', 'NUGET_PACKAGES', 'APPDATA', 'LOCALAPPDATA', 'diag-line-250', 'diag-line-51')) { if (-not $failure.Contains($expected)) { throw "Failure message lacks $expected" } }
    if (($failure -match '(?m)^diag-line-50\r?$') -or $failure.Contains($secretValue) -or $failure.Contains('QUALSIGN_SELFCHECK_SENTINEL') -or $failure.Contains($packageRoot)) { throw 'Failure message must hold last 200 lines and env names only' }
    # A child that never exits is killed with its tree inside its own deadline; the output it streamed reaches the error.
    $failure = $null; $clock = [Diagnostics.Stopwatch]::StartNew()
    try { Invoke-Clean $pwshPath @('-NoProfile', '-Command', '"stall-pid-$PID"; 1..5 | ForEach-Object { "stall-line-$_" }; Start-Sleep -Seconds 120') $Scratch $Scratch $packageRoot -TimeoutSeconds:3 } catch { $failure = $_.Exception.Message }
    $clock.Stop()
    if ($null -eq $failure -or -not $failure.StartsWith('Pinned child timed out: no exit within 3 s', [StringComparison]::Ordinal)) { throw 'Stalled child must time out' }
    if ($clock.Elapsed.TotalSeconds -gt 30) { throw 'Stalled child outlived its deadline' }
    foreach ($expected in @('stall-line-1', 'stall-line-5', 'Child environment variable names:')) { if (-not $failure.Contains($expected)) { throw "Timeout message lacks $expected" } }
    $stalledId = [int] [regex]::Match($failure, 'stall-pid-(?<id>[0-9]+)').Groups['id'].Value
    if ($stalledId -le 0) { throw 'Timeout message lacks the streamed child output' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($null -ne (Get-Process -Id $stalledId -ErrorAction Ignore) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($null -ne (Get-Process -Id $stalledId -ErrorAction Ignore)) { throw 'Stalled child survived the timeout' }
    if (-not $IsWindows) {
        # A child that exits while a detached descendant keeps its output pipes open must not hold the caller forever.
        $failure = $null; $clock = [Diagnostics.Stopwatch]::StartNew()
        try { Invoke-Clean '/bin/sh' @('-c', 'echo held-line; /bin/sleep 120 & exit 0') $Scratch $Scratch $packageRoot -TimeoutSeconds:3 } catch { $failure = $_.Exception.Message }
        $clock.Stop()
        if ($null -eq $failure -or -not $failure.StartsWith('Pinned child timed out: exited, but a descendant still holds the output pipes', [StringComparison]::Ordinal) -or -not $failure.Contains('held-line')) { throw 'Pipe-holding descendant must time out' }
        if ($clock.Elapsed.TotalSeconds -gt 30) { throw 'Pipe-holding descendant outlived the drain deadline' }
    }
    foreach ($seconds in @(0, 1201)) { Assert-Reject { Invoke-Clean $pwshPath @('-NoProfile', '-Command', 'exit 0') $Scratch $Scratch $packageRoot -TimeoutSeconds:$seconds } "child timeout $seconds" }
    $buildScript = Get-Content -Raw -LiteralPath ([IO.Path]::GetFullPath("$PSScriptRoot/../infra/windows-signing/collector/Build.ps1"))
    if (-not $buildScript.Contains('-v:diag') -or -not $buildScript.Contains('publish.binlog')) { throw 'Publish must capture diagnostic verbosity and a binlog' }
    Assert-Equal $rootMatch.Groups['leaf'].Value 'qualsign-nuget-packages' 'restore package folder leaf'
    foreach ($relative in @('', 'packages', '../packages', "$packageRoot/../other")) { Assert-Reject { Get-CleanEnvironment (Join-Path $Scratch 'sdk/dotnet.exe') $Scratch $relative } "package root '$relative'" }
}
if ($Group -eq 'Callers') {
    # Every Build.ps1 invocation and every Invoke-Clean call must pass the restored package root; no default exists.
    $callerBase = if ($CallerRoot) { $CallerRoot } else { [IO.Path]::GetFullPath("$PSScriptRoot/..") }
    $sites = 0
    foreach ($script in @(Get-ChildItem -LiteralPath $callerBase -Recurse -File -Include '*.ps1' | Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' })) {
        $callerAst = [Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$tokens,[ref]$parseErrors)
        if ($parseErrors.Count) { throw "Caller parse failed: $($script.Name)" }
        foreach ($command in $callerAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]}, $true)) {
            $name = $command.GetCommandName(); $first = $command.CommandElements[0].Extent.Text.Trim('"', "'")
            $elements = @($command.CommandElements | Select-Object -Skip 1)
            if ($name -eq 'Invoke-Clean') {
                $positional = @($elements | Where-Object { $_ -isnot [Management.Automation.Language.CommandParameterAst] })
                if ($positional.Count -ne 5) { throw "Invoke-Clean without package root: $($script.Name):$($command.Extent.StartLineNumber)" }
                $sites++
            } elseif ($first -match '(^|[\\/])Build\.ps1$') {
                if (-not @($elements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -eq 'PackageRoot' })) { throw "Build.ps1 without -PackageRoot: $($script.Name):$($command.Extent.StartLineNumber)" }
                $sites++
            }
        }
    }
    if ($sites -lt 5 -and -not $CallerRoot) { throw 'Caller scan found too few call sites' }
}
Write-Output "QUALSIGN_POWERSHELL_GREEN group=$Group"
