$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = 'C:\xampp\htdocs\01\301\runway'
$out = 'C:\xampp\htdocs\01\301\runway_external_backups'
$tag = 'W3A5DONE'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$zip = Join-Path $out ("runway_" + $tag + "_" + $stamp + ".zip")
$man = Join-Path $out ("MANIFEST_" + $tag + "_" + $stamp + ".sha256.txt")
$files = Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object { $_.FullName -notlike "$root\_backups\*" }
$lines = New-Object System.Collections.Generic.List[string]
$za = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    $lines.Add("$h  $rel")
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $za.Dispose() }
$zh = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
$lines.Add("")
$lines.Add("ZIP  $zh  " + (Split-Path $zip -Leaf) + "  files=" + $files.Count)
[System.IO.File]::WriteAllLines($man, $lines, (New-Object System.Text.UTF8Encoding($false)))
# проверка: прочитать архив назад и сверить хэши записей с манифестом
$expect = @{}
foreach ($l in $lines) { if ($l -match '^([0-9a-f]{64})  (.+)$' -and $l -notmatch '^ZIP') { $expect[$Matches[2]] = $Matches[1] } }
$bad = 0; $n = 0
$zr = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  foreach ($e in $zr.Entries) {
    $n++
    $s = $e.Open()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hh = ([BitConverter]::ToString($sha.ComputeHash($s)) -replace '-', '').ToLower()
    $s.Dispose()
    $key = $e.FullName -replace '/', '\'
    if (-not $expect.ContainsKey($key) -or $expect[$key] -ne $hh) { $bad++; "НЕ СОВПАЛО: " + $e.FullName }
  }
} finally { $zr.Dispose() }
"zip=" + $zip
"files_in_manifest=" + $files.Count + " entries_in_zip=" + $n + " mismatches=" + $bad
"zip_sha256=" + $zh
"size_MB=" + [math]::Round((Get-Item $zip).Length / 1MB, 2)
