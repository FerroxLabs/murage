# No compilation or mutation while loading this boundary.
function Assert-GatePath([string]$Path,[string]$Root='C:\murage-ci') {
  if(-not $Path){throw 'Empty gate path'}
  $full=[IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $base=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if($full -ine $base -and -not $full.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw "Path outside gate root: $Path"}
  if($env:OS -eq 'Windows_NT' -and ($full -notmatch '^C:\\' -or $full.Substring(2).Contains(':') -or $full -match '[. ](?:\\|$)')){throw 'Noncanonical Windows path'}
  $current=$full
  while($current) {
    try {$item=Get-Item -LiteralPath $current -Force -ErrorAction Stop}
    catch [System.Management.Automation.ItemNotFoundException] {$item=$null}
    if($null -ne $item) {
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse point ancestor refused: $current"}
      $resolved=(Resolve-Path -LiteralPath $current -ErrorAction Stop).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
      if($resolved -ine $current.TrimEnd([IO.Path]::DirectorySeparatorChar)){throw "Resolved path changed: $current"}
    }
    $parent=Split-Path -Parent $current
    if($parent -eq $current){break};$current=$parent
  }
  return $full
}
function New-GateDirectory([string]$Path) {
  $checked=Assert-GatePath $Path
  New-Item -ItemType Directory -Path $checked -Force | Out-Null
  [void](Assert-GatePath $checked)
}
function Set-FixtureEnvironment([string]$Fixture,[switch]$DefaultProfile) {
  [void](Assert-GatePath $Fixture)
  $values=@{TEMP=(Join-Path $Fixture 'temp');TMP=(Join-Path $Fixture 'temp')}
  if(-not $DefaultProfile) {
    $values+=@{MURAGE_DATA_DIR=(Join-Path $Fixture 'data');MURAGE_USER_DATA=(Join-Path $Fixture 'user-data');HOME=(Join-Path $Fixture 'home');USERPROFILE=(Join-Path $Fixture 'home');APPDATA=(Join-Path $Fixture 'home\AppData\Roaming');LOCALAPPDATA=(Join-Path $Fixture 'home\AppData\Local')}
  } elseif($env:COMPUTERNAME -ine 'gate-win-nogit' -or $env:USERNAME -cne 'murage-gate' -or $env:MURAGE_DATA_DIR -or $env:MURAGE_USER_DATA){throw 'Default profile is gate user only'}
  $saved=@{}
  try {foreach($key in $values.Keys){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process');New-GateDirectory $values[$key];[Environment]::SetEnvironmentVariable($key,$values[$key],'Process')}}catch{Restore-FixtureEnvironment $saved;throw}
  return $saved
}
function Restore-FixtureEnvironment($Saved) {foreach($key in $Saved.Keys){[Environment]::SetEnvironmentVariable($key,$Saved[$key],'Process')}}
function Get-AppManifest([string]$Directory) {
  [void](Assert-GatePath $Directory)
  $rows=New-Object 'System.Collections.Generic.List[object]'
  function Walk-App([string]$Here) {
    [void](Assert-GatePath $Here)
    foreach($item in @(Get-ChildItem -LiteralPath $Here -Force -ErrorAction Stop)) {
      [void](Assert-GatePath $item.FullName)
      if($item.PSIsContainer){Walk-App $item.FullName}else{
        $rows.Add(@{path=$item.FullName.Substring($Directory.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
      }
    }
  }
  Walk-App $Directory
  # Ordinal order matches the Node receipt validator on every locale.
  $names=[string[]]@($rows | ForEach-Object {$_.path});[Array]::Sort($names,[StringComparer]::Ordinal)
  foreach($name in $names){$rows | Where-Object {$_.path -ceq $name}}
}
function Assert-StagedPackage([string]$PackageSha256) {
  $stageFile=Assert-GatePath 'C:\murage-ci\stage.json'
  $stage=Get-Content -LiteralPath $stageFile -Raw | ConvertFrom-Json
  if($PackageSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $stage.packageSha256 -ne $PackageSha256){throw 'MAIN verified ZIP digest required'}
  $zip=Assert-GatePath $stage.package
  if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $PackageSha256){throw 'Verified ZIP changed'}
  $actual=@(Get-AppManifest 'C:\murage-ci\app')
  if($actual.Count -ne $stage.appManifest.Count){throw 'Staged file set changed'}
  for($i=0;$i -lt $actual.Count;$i++) {
    if($actual[$i].path -cne $stage.appManifest[$i].path -or $actual[$i].sha256 -ne $stage.appManifest[$i].sha256){throw 'Staged file changed'}
  }
  $provenance=Get-Content -LiteralPath (Assert-GatePath 'C:\murage-ci\app\resources\build-provenance.json') -Raw | ConvertFrom-Json
  if($provenance.commit -notmatch '^[a-f0-9]{40}$' -or $provenance.commit -cne $stage.commit){throw 'Packaged provenance mismatch'}
  return $stage
}
