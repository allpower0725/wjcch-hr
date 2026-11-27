param([switch]$Tunnel)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Get-LineTestPassword([string]$Role) {
    $secretPath = Join-Path $project ".local/database/secrets/${Role}_password"
    if (!(Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($secretPath)) | Out-Null
        [IO.File]::WriteAllText($secretPath, [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
    }
    $password = [IO.File]::ReadAllText($secretPath).Trim()
    if ($password -cnotmatch '^[A-F0-9]{64}$') { throw '本機 LINE 測試密碼檔格式不符' }
    return $password
}

$testPassword = Get-LineTestPassword 'hr_line_web_test'
$tunnelSettings = '\set configure_tunnel false'
if ($Tunnel) {
    $tunnelPassword = Get-LineTestPassword 'hr_line_web_tunnel'
    $tunnelSettings = "\set configure_tunnel true`n\set tunnel_password $tunnelPassword"
}
$setupSql = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'database/tools/setup-line-web-test.sql')
$testFunctions = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'database/tools/line-web-test-functions.sql')
$previousOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    "\set app_password $testPassword`n$tunnelSettings`n$setupSql`n$testFunctions`nCOMMIT;" | docker exec -i wjcch psql -X -w -q -U db_owner -d wjcch_db_test -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw '本機 LINE 測試資料庫設定失敗' }
} finally {
    $OutputEncoding = $previousOutputEncoding
}
Write-Output '已設定 wjcch_db_test.hr 的 Web 測試角色及合成員工。'
