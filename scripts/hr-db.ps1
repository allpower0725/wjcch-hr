param(
    [Parameter(Mandatory)][ValidateSet('configure','migrate','verify','backup-queue','verify-runtime','fingerprint')][string]$Command,
    [switch]$Cloud,
    [switch]$Test,
    [string]$LocalAdminPasswordFile,
    [string]$CloudAdminEnv,
    [string]$CloudCa
)
$ErrorActionPreference = 'Stop'
if ($Cloud -and $Command -in @('configure','backup-queue','verify')) {
    throw 'configure、backup-queue 與 verify 是本機維護指令，不接受 -Cloud。'
}
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dockerArgs = @('run','--pull','never','--rm','--user','0:0','--mount',"type=bind,source=$workspacePath,target=/workspace",
    '--mount',"type=bind,source=$workspacePath\collector\src,target=/app/src,readonly")
if ($Cloud) {
    if (!$CloudAdminEnv -or !$CloudCa) { throw 'CloudAdminEnv 與 CloudCa 必填；只提供私密檔路徑。' }
    $adminPath = (Resolve-Path -LiteralPath $CloudAdminEnv).Path
    $caPath = (Resolve-Path -LiteralPath $CloudCa).Path
    $dockerArgs += @('--mount',"type=bind,source=$adminPath,target=/run/admin/connections.env,readonly",
        '--mount',"type=bind,source=$caPath,target=/run/admin/ca.crt,readonly",
        '--env','HR_CLOUD_ADMIN_ENV=/run/admin/connections.env','--env','HR_CLOUD_CA=/run/admin/ca.crt')
} else {
    if ($Command -in @('configure','backup-queue')) {
        $dockerArgs += @('--network','none')
    } else {
        $dockerArgs += @('--network','wjcch_default')
    }
    if ($Command -in @('migrate','fingerprint')) {
        if (!$LocalAdminPasswordFile) { throw 'LocalAdminPasswordFile 必填；只提供管理密碼檔路徑。' }
        $adminPath = (Resolve-Path -LiteralPath $LocalAdminPasswordFile).Path
        $dockerArgs += @('--mount',"type=bind,source=$adminPath,target=/run/secrets/db_owner_password,readonly",
            '--env','HR_LOCAL_ADMIN_PASSWORD_FILE=/run/secrets/db_owner_password')
    }
}
$toolImage = if ($Command -eq 'verify') { 'wjcch-collector-test:hr-modes' } else { 'wjcch-collector:hr-modes' }
$dockerArgs += @($toolImage,'python','-B','-m','collector.admin',$Command)
if ($Cloud) { $dockerArgs += '--cloud' }
if ($Test) { $dockerArgs += '--test' }
& docker @dockerArgs
if ($LASTEXITCODE -ne 0) { throw "HR 維護指令失敗，exit=$LASTEXITCODE" }
