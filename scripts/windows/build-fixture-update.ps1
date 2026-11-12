# On the existing authorized Windows signing builder, never a publish job.
# Start from the exact clean candidate commit. The only source edit is package.json version.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
 [Parameter(Mandatory=$true)][string]$CandidateExecutable,
 [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version='1.0.190',
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:OS -ne 'Windows_NT'){throw 'Use the same Windows signing builder as the candidate'}
. (Join-Path $PSScriptRoot 'owned-process.ps1')
$root=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $root
$package=Join-Path $root 'package.json'
$original=[IO.File]::ReadAllBytes($package)
$oldFeed=$env:MURAGE_QUALIFICATION_FEED_URL
$oldWorkingDirectory=[Environment]::CurrentDirectory
try {
 [Environment]::CurrentDirectory=$root
 $git=(Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
 $head=Invoke-WindowsNative $git @('rev-parse','HEAD')
 if($head.ExitCode -ne 0 -or $head.Stdout.Trim() -ne $Commit){throw 'Build commit mismatch'}
 $status=Invoke-WindowsNative $git @('status','--porcelain','--untracked-files=no')
 if($status.ExitCode -ne 0 -or $status.Stdout.Trim()){throw 'Clean candidate checkout required'}
 if([version]$Version -le [version]'1.0.19' -or ([version]$Version).Major -ne 1 -or ([version]$Version).Minor -ne 0 -or ([version]$Version).Build -gt 65535){throw 'Fixture version must be higher than 1.0.19'}
 if((Get-Item -LiteralPath $CandidateExecutable).VersionInfo.ProductVersion -ne '1.0.19'){throw 'Wrong base candidate'}
 if(Test-Path -LiteralPath $OutputDirectory){throw 'Output directory must be new'}
 $candidateHash=(Get-FileHash -LiteralPath $CandidateExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
 $candidateSignature=Get-AuthenticodeSignature -LiteralPath $CandidateExecutable
 if($candidateSignature.Status -ne 'Valid'){throw 'Candidate must be signed'}
 $p=Get-Content -LiteralPath $package -Raw | ConvertFrom-Json
 $text=[Text.Encoding]::UTF8.GetString($original)
 $pattern='(?m)^  "version": "'+[regex]::Escape($p.version)+'"'
 if([regex]::Matches($text,$pattern).Count -ne 1){throw 'Expected exactly one root package version'}
 $text=[regex]::Replace($text,$pattern,('  "version": "'+$Version+'"'))
 [IO.File]::WriteAllText($package,$text,(New-Object Text.UTF8Encoding($false)))
 $env:MURAGE_QUALIFICATION_FEED_URL='http://127.0.0.1:18919/'
 # --publish never is also embedded in package:win. Existing signing identity is used unchanged.
 $pnpm=(Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop).Source
 if(($pnpm+$OutputDirectory) -match '[%!^&|<>"\r\n]'){throw 'Unsafe build command argument'}
 $command='"'+$pnpm+'" package:win --config electron-builder.qualification.yml --publish never -c.forceCodeSigning=true "-c.directories.output='+$OutputDirectory+'"'
 $build=Invoke-OwnedNative -File (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments ('/d /s /c "'+$command+'"') -TimeoutSeconds 3600
 if($build.ExitCode -ne 0){throw ('Fixture build failed: '+$build.Stderr)}
 $installers=@(Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.exe' -File)
 if($installers.Count -ne 1){throw 'Expected exactly one NSIS fixture installer'}
 $installer=$installers[0]
 $sig=Get-AuthenticodeSignature -LiteralPath $installer.FullName
 if($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Thumbprint -ne $candidateSignature.SignerCertificate.Thumbprint){throw 'Fixture must be signed the same way as candidate'}
 $built=Join-Path $OutputDirectory 'win-unpacked\Murage.exe'
 if((Get-Item -LiteralPath $built).VersionInfo.ProductVersion -ne $Version){throw 'Fixture build version mismatch'}
 if(-not (Test-Path -LiteralPath (Join-Path $OutputDirectory 'latest.yml'))){throw 'Missing local feed metadata'}
 $yaml=Get-Content -LiteralPath (Join-Path $OutputDirectory 'win-unpacked\resources\app-update.yml') -Raw
 if($yaml -notmatch 'http://127\.0\.0\.1:18919/' -or $yaml -match 'provider: github'){throw 'Fixture build escaped local feed'}
 @{commit=$Commit;candidateVersion='1.0.19';candidateSha256=$candidateHash;version=$Version;feedUrl=$env:MURAGE_QUALIFICATION_FEED_URL;installer=$installer.Name;updateSha256=(Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant();signer=$sig.SignerCertificate.Thumbprint;published=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'fixture-update.json') -Encoding UTF8
} finally {
 [IO.File]::WriteAllBytes($package,$original)
 $env:MURAGE_QUALIFICATION_FEED_URL=$oldFeed
 [Environment]::CurrentDirectory=$oldWorkingDirectory
 Pop-Location
}
