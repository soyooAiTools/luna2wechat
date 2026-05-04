# 预览 luna-wx-unity (unity 渠道) 工程,生成 QR
# 与 preview-v20-12.ps1 同模式,只是 project / TaskName / output 路径换 unity 后缀。
# 复用到下个渠道(tiktok/mintegral 等)时改 $project 名 + $qr/$info/$out 后缀即可。
$project = 'C:\Users\Nick\luna-wx-unity'
$qr = 'C:\Users\Nick\preview-qr-unity.png'
$info = 'C:\Users\Nick\preview-info-unity.json'
$out = 'C:\Users\Nick\cli-preview-unity.out'
$cmd = "cmd /c D:\wechatDev\cli.bat preview --project $project --qr-format image --qr-output $qr --info-output $info > $out 2>&1"
schtasks /Delete /TN PreviewUnity /F 2>$null | Out-Null
schtasks /Create /SC ONCE /ST 23:59 /TN PreviewUnity /TR "$cmd" /F | Out-Null
schtasks /Run /TN PreviewUnity | Out-Null
Start-Sleep -Seconds 60
Write-Host "==== cli-preview-unity.out ===="
Get-Content $out -ErrorAction SilentlyContinue
Write-Host ""
if (Test-Path $qr) { Write-Host "QR exists: $((Get-Item $qr).Length) bytes at $qr" }
else { Write-Host "QR not generated" }
