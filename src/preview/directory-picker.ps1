$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $owner.Text = 'FengZaiY'
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.Width = 1
  $owner.Height = 1
  $owner.Show()
  $dialog.Description = 'FengZaiY - 选择文件夹'
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine((ConvertTo-Json -InputObject $dialog.SelectedPath -Compress))
  } else {
    [Console]::WriteLine('null')
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
