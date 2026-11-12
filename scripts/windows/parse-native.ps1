# Parse source as data only. Never dot-source or execute a scanned file.
param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$hits=[Collections.Generic.List[object]]::new()
function Report($Entry,$Ast,[string]$Rule) {
  $hits.Add(@{file=$Entry.file;line=$Ast.Extent.StartLineNumber;rule=$Rule})
}
$aliases=@{}
foreach($alias in Get-Alias){$aliases[$alias.Name]=$alias.Definition}
foreach($entry in @(Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json)) {
  if($entry.file -match '\.cs$') {
    Add-Type -AssemblyName Microsoft.CodeAnalysis.CSharp
    $tree=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText([IO.File]::ReadAllText($entry.path))
    foreach($diagnostic in $tree.GetDiagnostics()) {
      if($diagnostic.Severity.ToString() -eq 'Error'){$hits.Add(@{file=$entry.file;line=1+$diagnostic.Location.GetLineSpan().StartLinePosition.Line;rule='parse failure: C# '+$diagnostic.Id})}
    }
    foreach($token in $tree.GetRoot().DescendantTokens()) {
      if($token.RawKind -eq [int][Microsoft.CodeAnalysis.CSharp.SyntaxKind]::IdentifierToken -and $token.ValueText -match '^(Kill|Terminate|TerminateProcess|ProcessStartInfo)$'){$hits.Add(@{file=$entry.file;line=1+$token.GetLocation().GetLineSpan().StartLinePosition.Line;rule='unowned C# native operation'})}
    }
    foreach($node in $tree.GetRoot().DescendantNodes()) {
      if($node -is [Microsoft.CodeAnalysis.CSharp.Syntax.InvocationExpressionSyntax] -and $node.Expression -is [Microsoft.CodeAnalysis.CSharp.Syntax.MemberAccessExpressionSyntax] -and $node.Expression.Name.Identifier.ValueText -ieq 'Start' -and $node.Expression.Expression.ToString() -match '(^|\.)Process$') {
        $hits.Add(@{file=$entry.file;line=1+$node.GetLocation().GetLineSpan().StartLinePosition.Line;rule='unowned C# process start'})
      }
    }
    continue
  }
  $tokens=$null;$errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile($entry.path,[ref]$tokens,[ref]$errors)
  foreach($error in $errors){$hits.Add(@{file=$entry.file;line=$error.Extent.StartLineNumber;rule='parse failure: PowerShell '+$error.ErrorId})}
  foreach($node in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -or $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]},$true)) {
    if($node -is [System.Management.Automation.Language.CommandAst]) {
      $name=$node.GetCommandName()
      if(-not $name) {
        # A dot-source of a literal sibling via Join-Path is statically known;
        # arbitrary expressions, call operators and variable paths are refused.
        $first=$node.CommandElements[0]
        $known=$false
        if($node.InvocationOperator -eq 'Dot' -and $first -is [System.Management.Automation.Language.ParenExpressionAst]) {
          $pipeline=$first.Pipeline
          if($pipeline -is [System.Management.Automation.Language.PipelineAst] -and $pipeline.PipelineElements.Count -eq 1) {
            $join=$pipeline.PipelineElements[0]
            if($join -is [System.Management.Automation.Language.CommandAst] -and $join.GetCommandName() -ieq 'Join-Path' -and $join.CommandElements.Count -eq 3) {
              $base=$join.CommandElements[1];$leaf=$join.CommandElements[2]
              $known=$base -is [System.Management.Automation.Language.VariableExpressionAst] -and $base.VariablePath.UserPath -ieq 'PSScriptRoot' -and $leaf -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $leaf.Value -match '^[\w-]+\.ps1$'
            }
          }
        }
        if(-not $known){Report $entry $node 'dynamic PowerShell invocation'}
        continue
      }
      $name=($name -split '[\\/]')[-1]
      $seen=@{}
      while($aliases.ContainsKey($name) -and -not $seen.ContainsKey($name)){$seen[$name]=$true;$name=$aliases[$name]}
      if($name -match '^(Stop-Process|Start-Process|Start-Job|Start-ThreadJob|Invoke-Expression|Invoke-Command|Set-Alias|New-Alias|kill|spps|saps|start|iex|taskkill(?:\.exe)?|tskill(?:\.exe)?|wmic(?:\.exe)?|TerminateProcess)$' -or $name -match '\.(exe|com|cmd|bat)$') {
        Report $entry $node 'unowned native or dynamic PowerShell command'
      }
      if($name -ieq 'Invoke-CimMethod' -or $name -ieq 'Invoke-WmiMethod') {
        # Only the existing read-only owner-SID query is statically safe.
        $method=$null;$splat=$false
        for($i=1;$i -lt $node.CommandElements.Count;$i++) {
          $element=$node.CommandElements[$i]
          if($element -is [System.Management.Automation.Language.VariableExpressionAst] -and $element.Splatted){$splat=$true}
          if($element -is [System.Management.Automation.Language.CommandParameterAst] -and $element.ParameterName -ieq 'MethodName') {
            if($null -ne $element.Argument){$method=$element.Argument}
            elseif($i+1 -lt $node.CommandElements.Count){$method=$node.CommandElements[$i+1]}
          }
        }
        if($splat -or $method -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $method.Value -ine 'GetOwnerSid') {Report $entry $node 'unowned CIM/WMI method'}
      }
      if($name -ieq 'Add-Type') {
        # Assembly loading is data; compiling inline or file-supplied code is not.
        $assemblyOnly=$node.CommandElements.Count -eq 3 -and $node.CommandElements[1] -is [System.Management.Automation.Language.CommandParameterAst] -and $node.CommandElements[1].ParameterName -ieq 'AssemblyName' -and $node.CommandElements[2] -is [System.Management.Automation.Language.StringConstantExpressionAst]
        if(-not $assemblyOnly){Report $entry $node 'dynamic Add-Type compilation'}
      }
    } else {
      $member=$node.Member
      if($member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {Report $entry $node 'dynamic PowerShell member invocation';continue}
      if($member.Value -match '^(Kill|Terminate|TerminateProcess|Invoke|InvokeReturnAsIs|InvokeWithContext)$'){Report $entry $node 'unowned native or dynamic PowerShell member'}
      if($node.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
        $type=$node.Expression.TypeName.FullName
        if(($type -match '(^|\.)(ScriptBlock|PowerShell)$' -and $member.Value -ieq 'Create') -or ($type -match '(^|\.)Process$' -and $member.Value -ieq 'Start')) {Report $entry $node 'dynamic code or native process creation'}
      }
    }
  }
}
ConvertTo-Json -InputObject @($hits.ToArray()) -Depth 5 -Compress
