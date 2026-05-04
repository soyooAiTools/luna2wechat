$project = 'C:\Users\Nick\luna-wx-mg'
$qr = 'C:\Users\Nick\preview-qr-v20-12.png'
$info = 'C:\Users\Nick\preview-info-v20-12.json'
$out = 'C:\Users\Nick\cli-preview-v20-12.out'
$cmd = "cmd /c D:\wechatDev\cli.bat preview --project $project --qr-format image --qr-output $qr --info-output $info > $out 2>&1"
schtasks /Delete /TN PreviewV2012 /F 2>$null | Out-Null
schtasks /Create /SC ONCE /ST 23:59 /TN PreviewV2012 /TR "$cmd" /F | Out-Null
schtasks /Run /TN PreviewV2012 | Out-Null
Start-Sleep -Seconds 180
Write-Host "==== cli-preview-v20-12.out ===="
Get-Content $out -ErrorAction SilentlyContinue
Write-Host ""
if (Test-Path $qr) { Write-Host "QR exists: $((Get-Item $qr).Length) bytes at $qr" }
else { Write-Host "QR not generated" }
