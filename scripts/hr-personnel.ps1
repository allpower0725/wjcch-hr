param(
    [Parameter(Mandatory)]
    [ValidateSet('report','snapshot','verify-preserved','audit')]
    [string]$Command,
    [ValidateSet('test','local','cloud')][string]$Target = 'test'
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dockerArgs = @('run','--pull','never','--rm','--user','0:0',
    '--mount',"type=bind,source=$workspacePath,target=/workspace")
if ($Target -ne 'cloud') {
    $dockerArgs += @('--network','wjcch_default')
}
$dockerArgs += @('--entrypoint','python','wjcch-collector:hr-modes','-B',
    '/workspace/database/tools/personnel.py',$Command,'--target',$Target)
& docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw "人事維護未完成，exit=$LASTEXITCODE" }
