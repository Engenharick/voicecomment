$ErrorActionPreference = 'Stop'

$root  = 'C:\Users\SAMSUNG\Documents\VoiceComment'
$vault = 'C:\Obsidian\Infinity Sistem 8'
$dst   = Join-Path $vault '.obsidian\plugins\voicecomment'
$old   = Join-Path $vault '.obsidian\plugins\rickvoice'

# 1) main.js = lame.min.js + \n + src/voicecomment.js  (exact bytes, no BOM)
$lame = [IO.File]::ReadAllBytes((Join-Path $root 'lame.min.js'))
$mine = [IO.File]::ReadAllBytes((Join-Path $root 'src\voicecomment.js'))
$all  = New-Object byte[] ($lame.Length + 1 + $mine.Length)
[Array]::Copy($lame, 0, $all, 0, $lame.Length)
$all[$lame.Length] = 0x0A
[Array]::Copy($mine, 0, $all, $lame.Length + 1, $mine.Length)
$mainJs = Join-Path $root 'main.js'
[IO.File]::WriteAllBytes($mainJs, $all)

# 2) install into the vault
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item $mainJs (Join-Path $dst 'main.js') -Force
Copy-Item (Join-Path $root 'manifest.json') (Join-Path $dst 'manifest.json') -Force
Copy-Item (Join-Path $root 'styles.css') (Join-Path $dst 'styles.css') -Force
Get-ChildItem $dst | Unblock-File

# 3) carry the old diagnostic log over, then drop the previous plugin folder
$oldLog = Join-Path $old 'rickvoice.log'
$newLog = Join-Path $dst 'voicecomment.log'
if ((Test-Path $oldLog) -and -not (Test-Path $newLog)) { Copy-Item $oldLog $newLog -Force }
if (Test-Path $old) { Remove-Item $old -Recurse -Force }

# 4) community-plugins.json: rickvoice out, voicecomment in
$cp = Join-Path $vault '.obsidian\community-plugins.json'
$list = [System.Collections.ArrayList]@()
foreach ($item in (Get-Content $cp -Raw | ConvertFrom-Json)) { [void]$list.Add([string]$item) }
if ($list.Contains('rickvoice')) { $list.Remove('rickvoice') }
if (-not $list.Contains('voicecomment')) { [void]$list.Add('voicecomment') }
$body = ($list | ForEach-Object { '  "' + $_ + '"' }) -join ",`r`n"
Set-Content -Path $cp -Value ("[`r`n" + $body + "`r`n]`r`n") -Encoding ASCII

# 5) report
Write-Output ('main.js: ' + (Get-Item $mainJs).Length + ' bytes (lame ' + $lame.Length + ' + code ' + $mine.Length + ')')
Get-ChildItem $dst | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 90
Write-Output 'enabled plugins matching voice/comment:'
(Get-Content $cp -Raw) -split "`r?`n" | Where-Object { $_ -match 'voice|comment' }
