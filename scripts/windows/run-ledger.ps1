# The surviving launcher owns this append-only write-ahead intent ledger.
function Add-RunLedger([string]$Ledger,[string]$Prefix,[string]$Kind,[string]$Name) {
  [void](Assert-GatePath $Ledger)
  if($Prefix -notmatch '^MurageCI-[a-f0-9]{32}-$' -or $Kind -ne 'task' -or -not $Name.TrimStart('\').StartsWith($Prefix,[StringComparison]::Ordinal)){throw 'Unowned ledger entry'}
  $row=@{kind=$Kind;name=$Name;prefix=$Prefix} | ConvertTo-Json -Compress
  $stream=New-Object IO.FileStream($Ledger,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {$bytes=[Text.Encoding]::UTF8.GetBytes($row+"`n");$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-RunTasks($Folder) {
  # Enumerate, never infer absence from GetTask exceptions (including access denied).
  foreach($task in $Folder.GetTasks(1)){$task}
  foreach($child in $Folder.GetFolders(0)){Get-RunTasks $child}
}
function Complete-RunLedger([string]$Ledger,[string]$Prefix,$Before,[scriptblock]$Enumerate,[scriptblock]$Delete,[ref]$Result) {
  if($null -eq $Before){throw 'Pre-registration snapshot required'}
  $entries=@(Get-Content -LiteralPath $Ledger -ErrorAction Stop | ForEach-Object {$_ | ConvertFrom-Json})
  foreach($entry in $entries){if($entry.prefix -cne $Prefix -or $entry.kind -ne 'task' -or -not (Test-RunPrefix $entry.name $Prefix)){throw 'Invalid launcher ledger'}}
  $diff=Complete-SnapshotDiff $Before $Prefix $Enumerate $Delete
  if($null -ne $Result){$Result.Value=$diff}
  if(-not $diff.ok){throw ($diff.errors -join '; ')}
}
