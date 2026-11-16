# Owner wg-proof, fixture producer/consumer. No native filesystem/disk mutator backend.
# Compiled cmdlets supply real Cmdlet metadata to production steppable proxies.
# Autoloading stays off. Selection is asserted before dot-sourcing the guard.
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
# Remove native mutators before the guard can capture CommandInfo metadata.
$functionSetter = Get-Command Microsoft.PowerShell.Management\Set-Item -ErrorAction Stop
Remove-Module Microsoft.PowerShell.Management -Force -ErrorAction Ignore
Import-Module Microsoft.PowerShell.Management -Cmdlet Get-Item,Get-ChildItem,Resolve-Path,Split-Path,Join-Path,Test-Path,Get-Location,Set-Location -ErrorAction Stop
# The guard installs functions through Set-Item. Preserve that use alone; never
# expose the captured cmdlet as an unconstrained filesystem mutation command.
& $functionSetter -Path Function:global:Set-Item -Value ({
    [CmdletBinding()] param([string] $Path, [object] $Value)
    if ($Path -notmatch '^Function:') { throw 'fixture non-function assignment' }
    & $functionSetter -Path $Path -Value $Value
}.GetNewClosure())
$PSModuleAutoLoadingPreference = 'None'
$source = @'
using System;
using System.IO;
using System.Management.Automation;
namespace WipeProof {
  public static class Boundary {
    public static readonly StringComparison Comparison = System.IO.Path.DirectorySeparatorChar == '\\'
      ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    public static string Check(string value) {
      string root = System.IO.Path.GetFullPath(Environment.GetEnvironmentVariable("WIPE_PROOF_TREE"));
      string temp = System.IO.Path.GetFullPath(System.IO.Path.GetTempPath());
      string prefix = temp.TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar + "wipe-proof-";
      if (!root.StartsWith(prefix, Comparison)) throw new Exception("fixture root outside temp");
      string full = System.IO.Path.GetFullPath(value);
      if (!full.Equals(root, Comparison) &&
          !full.StartsWith(root + System.IO.Path.DirectorySeparatorChar, Comparison))
        throw new Exception("fixture outside tree");
      // Inspect every existing ancestor, including the fixture root. Reject junctions
      // and symlinks regardless of their destination, before any mutation happens.
      string cursor = full;
      while (!String.IsNullOrEmpty(cursor)) {
        try {
          if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
            throw new Exception("fixture reparse point");
        } catch (FileNotFoundException) {} catch (DirectoryNotFoundException) {}
        cursor = System.IO.Path.GetDirectoryName(cursor);
      }
      return full;
    }
    public static void Subtree(string full) {
      Check(full);
      if (Directory.Exists(full)) foreach (string child in Directory.GetFileSystemEntries(full)) Subtree(child);
    }
  }
  public abstract class Filesystem : PSCmdlet {
    [Parameter(Position=0, Mandatory=true, ValueFromPipeline=true, ValueFromPipelineByPropertyName=true, ParameterSetName="Path")]
    public string[] Path {get;set;}
    [Parameter(Mandatory=true, ValueFromPipelineByPropertyName=true, ParameterSetName="LiteralPath")]
    [Alias("PSPath","FullName")] public string[] LiteralPath {get;set;}
    [Parameter] public SwitchParameter Force {get;set;}
    [Parameter] public SwitchParameter Recurse {get;set;}
    protected string[] Sources() {
      var result = new System.Collections.Generic.List<string>();
      foreach (string value in LiteralPath ?? Path) {
        ProviderInfo provider;
        if (LiteralPath != null) {
          PSDriveInfo drive;
          string full = SessionState.Path.GetUnresolvedProviderPathFromPSPath(value, out provider, out drive);
          if (provider.Name != "FileSystem") throw new Exception("fixture non-filesystem provider");
          result.Add(Boundary.Check(full));
        } else {
          foreach (string full in SessionState.Path.GetResolvedProviderPathFromPSPath(value, out provider)) {
            if (provider.Name != "FileSystem") throw new Exception("fixture non-filesystem provider");
            result.Add(Boundary.Check(full));
          }
        }
      }
      foreach (string full in result) Boundary.Subtree(full);
      return result.ToArray();
    }
  }
  [Cmdlet("Remove","Item",DefaultParameterSetName="Path",SupportsShouldProcess=true)]
  public class RemoveItem : Filesystem {
    protected override void ProcessRecord() {
      string[] sources = Sources(); // Validate the entire call before deleting its first path.
      foreach (string full in sources) {
        if (!ShouldProcess(full)) continue;
        if (Directory.Exists(full)) Directory.Delete(full, Recurse);
        else if (File.Exists(full)) File.Delete(full);
      }
    }
  }
  [Cmdlet("Move","Item",DefaultParameterSetName="Path",SupportsShouldProcess=true)]
  public class MoveItem : Filesystem {
    [Parameter(Position=1,Mandatory=true)] public string Destination {get;set;}
    protected override void ProcessRecord() {
      string destination = Boundary.Check(SessionState.Path.GetUnresolvedProviderPathFromPSPath(Destination));
      string[] sources = Sources();
      var destinations = new System.Collections.Generic.List<string>();
      foreach (string full in sources) destinations.Add(Boundary.Check(Directory.Exists(destination) ?
        System.IO.Path.Combine(destination, System.IO.Path.GetFileName(full)) : destination));
      for (int i=0; i<sources.Length; i++) {
        if (!ShouldProcess(sources[i])) continue;
        if (Directory.Exists(sources[i])) Directory.Move(sources[i], destinations[i]);
        else File.Move(sources[i], destinations[i]);
      }
    }
  }
  public abstract class Disk : PSCmdlet {
    [Parameter(Position=0,ValueFromPipelineByPropertyName=true)] public string Path {get;set;}
    [Parameter] public SwitchParameter Force {get;set;}
    protected override void ProcessRecord() {
      string root = Environment.GetEnvironmentVariable("WIPE_PROOF_TREE");
      string value = System.IO.Path.GetFullPath(Path ?? root);
      if (!value.StartsWith(root + System.IO.Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new Exception("fixture outside tree");
      File.AppendAllText(Environment.GetEnvironmentVariable("WIPE_PROOF_BACKEND"), "disk-backend\n");
      WriteObject("fixture disk backend");
    }
  }
  [Cmdlet("Format","Volume")] public class FormatVolume : Disk {}
  [Cmdlet("Clear","Disk")] public class ClearDisk : Disk {}
  [Cmdlet("Initialize","Disk")] public class InitializeDisk : Disk {}
  [Cmdlet("Remove","Partition")] public class RemovePartition : Disk {}
}
'@
$types = Add-Type -TypeDefinition $source -PassThru
Import-Module -Assembly $types[0].Assembly -Force
foreach ($name in @('Remove-Item','Move-Item','Format-Volume','Clear-Disk','Initialize-Disk','Remove-Partition')) {
    $selected = Get-Command -Name $name -CommandType Cmdlet -ErrorAction Stop | Select-Object -First 1
    if ($selected.ImplementingType.Namespace -ne 'WipeProof') { throw 'Unsafe disk fixture selection' }
}

foreach ($name in @('Remove-Item','Move-Item')) {
    foreach ($cmd in @(Get-Command $name -CommandType Cmdlet -All)) {
        if ($cmd.ImplementingType.Namespace -ne 'WipeProof') { throw 'Unsafe filesystem fixture selection' }
    }
    if (Get-Command ('Microsoft.PowerShell.Management\'+$name) -ErrorAction Ignore) {
        throw 'Native filesystem mutator still available'
    }
}
