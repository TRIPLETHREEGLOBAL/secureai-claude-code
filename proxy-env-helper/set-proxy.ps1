# Route Claude Code in this PowerShell window through SecureAI.
# Usage:  . "$env:SECUREAI_HOME\adapters\claude\proxy-env-helper\set-proxy.ps1"
# The proxy URL carries Claude's own SecureAI credentials, so the gateway can
# accept the traffic and SecureAI can show "Claude is using the protected route".
# Claude Desktop manages its own connection and is not covered by this helper.

function Resolve-SecureAiProxyUrl {
    if ($env:SECUREAI_PROXY_URL -and $env:SECUREAI_PROXY_URL.Trim() -ne "") {
        return $env:SECUREAI_PROXY_URL.Trim()
    }
    $cli = (Get-Command secureai -ErrorAction SilentlyContinue).Source
    if (-not $cli -and $env:SECUREAI_HOME) {
        $candidate = Join-Path $env:SECUREAI_HOME "bin\secureai.exe"
        if (Test-Path $candidate) { $cli = $candidate }
    }
    if ($cli) {
        $lines = & $cli proxy-env --platform claude --shell posix 2>$null
        foreach ($line in $lines) {
            if ($line -match '^export HTTPS_PROXY=(.+)$') {
                return $Matches[1]
            }
        }
    }
    return $null
}

$Url = Resolve-SecureAiProxyUrl
if (-not $Url) {
    Write-Host "SecureAI isn't installed or isn't running, so Claude Code was left unchanged."
    exit 1
}
$env:HTTP_PROXY = $Url
$env:HTTPS_PROXY = $Url
$env:NO_PROXY = "localhost,127.0.0.1,::1"
$env:SECUREAI_PROXY_URL = $Url

Write-Host "Claude Code in this window will now use SecureAI."
