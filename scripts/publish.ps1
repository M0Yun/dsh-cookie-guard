<#
  一条命令发布 dsh-cookie-guard。

  用法（PowerShell）：
    $env:GITHUB_TOKEN = "ghp_xxx"          # classic PAT，勾 repo 权限
    $env:NPM_TOKEN    = "npm_xxx"          # Automation token，可省略
    powershell -ExecutionPolicy Bypass -File scripts\publish.ps1

  也可以直接传参：
    scripts\publish.ps1 -GitHubToken ghp_xxx -NpmToken npm_xxx

  做四件事：
    1. 建 GitHub 仓库（已存在则跳过）
    2. 推送 main 分支
    3. 发 npm（需要 pnpm + NPM_TOKEN，失败不阻断）
    4. 给 2BingLing/dsh-market 提收录 issue
#>
[CmdletBinding()]
param(
  [string]$GitHubToken = $env:GITHUB_TOKEN,
  [string]$NpmToken = $env:NPM_TOKEN,
  [string]$Owner = 'M1zuyn',
  [string]$Repo = 'dsh-cookie-guard',
  [switch]$SkipNpm,
  [switch]$SkipMarket,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }

function Invoke-GitHub([string]$Method, [string]$Path, $Body) {
  $headers = @{
    Authorization          = "Bearer $GitHubToken"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-cookie-guard-publish'
  }
  $args_ = @{
    Method      = $Method
    Uri         = "https://api.github.com$Path"
    Headers     = $headers
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $args_.Body = ($Body | ConvertTo-Json -Depth 6)
    $args_.ContentType = 'application/json; charset=utf-8'
  }
  Invoke-RestMethod @args_
}

if (-not $GitHubToken) { throw '缺少 GITHUB_TOKEN（classic PAT，勾 repo）。' }

# 0. 本地仓库检查
Step '本地仓库'
Push-Location $root
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($branch -ne 'main') {
    git branch -M main
    $branch = 'main'
  }
  Write-Host "repo=$root branch=$branch commits=$((git rev-list --count HEAD).Trim())"
  if (git status --porcelain) { Write-Host '警告：有未提交的改动' -ForegroundColor Yellow }

  # 1. 建仓库
  Step "GitHub 仓库 $Owner/$Repo"
  $exists = $false
  try { $null = Invoke-GitHub 'GET' "/repos/$Owner/$Repo"; $exists = $true } catch { $exists = $false }
  if ($exists) {
    Write-Host '已存在，跳过创建'
  }
  elseif ($DryRun) {
    Write-Host "[dry-run] 将创建公开仓库 $Owner/$Repo"
  }
  else {
    $null = Invoke-GitHub 'POST' '/user/repos' @{
      name        = $Repo
      description = 'Fix DeepSeek Harness desktop (Windows) 431 / Web authentication failed: it appends one dsh-auth-* login cookie per launch and never cleans them.'
      homepage    = "https://github.com/$Owner/$Repo"
      private     = $false
      has_issues  = $true
      has_wiki    = $false
      topics      = @('dsh', 'dsh-plugin', 'deepseek-harness', 'deepseek', 'cookie', 'windows')
    }
    Write-Host "已创建 https://github.com/$Owner/$Repo"
  }

  # 2. 推送
  Step 'git push'
  $remoteUrl = "https://github.com/$Owner/$Repo.git"
  if ($DryRun) {
    Write-Host "[dry-run] git push $remoteUrl main"
  }
  else {
    git remote remove origin 2>$null
    git remote add origin $remoteUrl
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("x-access-token:$GitHubToken"))
    git -c "http.extraheader=AUTHORIZATION: basic $basic" push -u origin $branch
    if ($LASTEXITCODE -ne 0) { throw "git push 失败（退出码 $LASTEXITCODE）" }
    Write-Host "已推送 https://github.com/$Owner/$Repo"
  }

  # 3. npm
  Step 'npm publish'
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($SkipNpm) {
    Write-Host '跳过（-SkipNpm）'
  }
  elseif (-not $NpmToken) {
    Write-Host '没有 NPM_TOKEN，跳过。市场一键安装会退化为 git 安装。' -ForegroundColor Yellow
  }
  elseif ($DryRun) {
    Write-Host "[dry-run] pnpm publish $($pkg.name)@$($pkg.version)"
  }
  else {
    $pnpm = 'C:\Users\19232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
    $node = 'C:\Users\19232\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    $env:npm_config_registry = 'https://registry.npmjs.org/'
    $env:npm_config_//registry_npmjs_org_:_authToken = $NpmToken
    & $node $pnpm publish --no-git-checks --access public
    if ($LASTEXITCODE -ne 0) {
      Write-Host "npm 发布失败（退出码 $LASTEXITCODE），仓库已可用，稍后可重发。" -ForegroundColor Yellow
    }
    else {
      Write-Host "已发布 $($pkg.name)@$($pkg.version)"
    }
  }

  # 4. 市场收录
  Step 'DSH Market 收录'
  if ($SkipMarket) { Write-Host '跳过（-SkipMarket）' }
  elseif ($DryRun) { Write-Host '[dry-run] 给 2BingLing/dsh-market 提 issue' }
  else {
    $bodyFile = Join-Path $PSScriptRoot 'market-issue.md'
    $body = Get-Content $bodyFile -Raw -ErrorAction SilentlyContinue
    if (-not $body) { $body = "插件仓库：https://github.com/$Owner/$Repo" }
    try {
      $issue = Invoke-GitHub 'POST' '/repos/2BingLing/dsh-market/issues' @{
        title = "【插件提交】dsh-cookie-guard — 修复 DSH 桌面端 Cookie 堆积导致的 431 / 打不开"
        body  = $body
      }
      Write-Host "已提交：$($issue.html_url)"
    }
    catch {
      Write-Host "市场 issue 提交失败：$($_.Exception.Message)" -ForegroundColor Yellow
      Write-Host "可以手写提交：https://github.com/2BingLing/dsh-market/issues/new"
    }
  }
}
finally {
  Pop-Location
}

Step '完成'
Write-Host "仓库：https://github.com/$Owner/$Repo"
