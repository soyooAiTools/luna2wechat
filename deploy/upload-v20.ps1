$project = 'C:\Users\Nick\luna-wx-mg'
$info = 'C:\Users\Nick\upload-info-v20.json'
$out = 'C:\Users\Nick\cli-upload-v20.out'
$ver = 'v20-may4'
$desc = 'v20'
$cmd = "cmd /c D:\wechatDev\cli.bat upload --project $project -v $ver -d $desc -i $info > $out 2>&1"
schtasks /Delete /TN UploadV20 /F 2>$null | Out-Null
schtasks /Create /SC ONCE /ST 23:59 /TN UploadV20 /TR "$cmd" /F | Out-Null
schtasks /Run /TN UploadV20 | Out-Null
Start-Sleep -Seconds 90
Write-Host "==== cli-upload-v20.out ===="
Get-Content $out -ErrorAction SilentlyContinue
Write-Host ""
if (Test-Path $info) { Write-Host "==== upload-info-v20.json ===="; Get-Content $info } else { Write-Host "info file not generated" }
