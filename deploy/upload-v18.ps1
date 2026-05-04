$project = 'C:\Users\Nick\luna-wx-mg'
$info = 'C:\Users\Nick\upload-info-v18.json'
$out = 'C:\Users\Nick\cli-upload-v18.out'
$ver = 'v18-may4'
$desc = 'v18'
$cmd = "cmd /c D:\wechatDev\cli.bat upload --project $project -v $ver -d $desc -i $info > $out 2>&1"
schtasks /Delete /TN UploadV18 /F 2>$null | Out-Null
schtasks /Create /SC ONCE /ST 23:59 /TN UploadV18 /TR "$cmd" /F | Out-Null
schtasks /Run /TN UploadV18 | Out-Null
Start-Sleep -Seconds 60
Write-Host "==== cli-upload-v18.out ===="
Get-Content $out -ErrorAction SilentlyContinue
Write-Host ""
if (Test-Path $info) { Write-Host "==== upload-info-v18.json ===="; Get-Content $info } else { Write-Host "info file not generated" }
