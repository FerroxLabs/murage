# Run once, elevated, ONLY on the already-owned disposable gate-win-nogit box.
# No password argument, output, transcript, disk file or remote secret retrieval.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:COMPUTERNAME -ine 'gate-win-nogit'){throw 'This setup is bound to gate-win-nogit'}
if(-not (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Elevated gate setup required'}
$user='murage-gate'
if(Get-LocalUser -Name $user -ErrorAction SilentlyContinue){throw 'Gate user already exists; refusing to change its password'}
$key='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if((Get-ItemPropertyValue -LiteralPath $key -Name AutoAdminLogon -ErrorAction SilentlyContinue) -eq '1'){throw 'Existing autologon must be reviewed by MAIN before provisioning'}
. (Join-Path $PSScriptRoot 'owned-process.ps1')
Initialize-GateAutologonSecret$bytes=New-Object byte[] 48
$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
$secure=$null;$generated=$null
try {
 $rng.GetBytes($bytes)
 $generated=[Convert]::ToBase64String($bytes)+'!aA7'
 $secure=ConvertTo-SecureString -String $generated -AsPlainText -Force
 $account=New-LocalUser -Name $user -Password $secure -AccountNeverExpires -PasswordNeverExpires -Description 'Disposable Murage gate user; no owner data'
 Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545').Name -Member $account
 [GateAutologonSecret]::Store($generated)
 New-ItemProperty -LiteralPath $key -Name DefaultUserName -Value $user -PropertyType String -Force | Out-Null
 New-ItemProperty -LiteralPath $key -Name DefaultDomainName -Value $env:COMPUTERNAME -PropertyType String -Force | Out-Null
 New-ItemProperty -LiteralPath $key -Name AutoAdminLogon -Value '1' -PropertyType String -Force | Out-Null
 New-Item -ItemType Directory -Path 'C:\murage-ci' -Force | Out-Null
 $acl=Get-Acl -LiteralPath 'C:\murage-ci'
 $rule=New-Object Security.AccessControl.FileSystemAccessRule($account.SID,'Modify','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule);Set-Acl -LiteralPath 'C:\murage-ci' -AclObject $acl
 @{user=$user;sid=$account.SID.Value;machine=$env:COMPUTERNAME;passwordRecorded=$false;created=[DateTime]::UtcNow.ToString('O')} | ConvertTo-Json | Set-Content -LiteralPath 'C:\murage-ci\gate-user.json' -Encoding UTF8
 Write-Output 'Gate user murage-gate provisioned. MAIN must reboot to enter its interactive desktop.'
} finally {
 if($secure){$secure.Dispose()};$generated=$null;[Array]::Clear($bytes,0,$bytes.Length);$rng.Dispose()
}
