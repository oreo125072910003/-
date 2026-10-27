$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    switch ($request.operation) {
        'protect' {
            Add-Type -AssemblyName System.Security
            $result = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($request.value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
        }
        'unprotect' {
            Add-Type -AssemblyName System.Security
            $result = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($request.value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
        }
        'dialog' {
            Add-Type -AssemblyName System.Windows.Forms
            $options = $request.value
            if ($options.kind -eq 'directory') {
                $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
                $dialog.Description = $options.title
                if ($options.initial) { $dialog.SelectedPath = $options.initial }
                $result = $null
                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $result = $dialog.SelectedPath }
            } else {
                if ($options.kind -eq 'save') { $dialog = New-Object System.Windows.Forms.SaveFileDialog }
                else { $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Multiselect = [bool]$options.multiple }
                $dialog.Title = $options.title
                $dialog.Filter = 'All files (*.*)|*.*'
                if ($options.filename) { $dialog.FileName = $options.filename }
                $result = $null
                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                    if ($options.kind -eq 'save') { $result = $dialog.FileName }
                    else { $result = @($dialog.FileNames) }
                }
            }
            $dialog.Dispose()
        }
        default { throw 'Unsupported operation' }
    }
    [Console]::Write((ConvertTo-Json -InputObject $result -Compress -Depth 8))
} catch { [Console]::Error.Write('Windows operation failed'); exit 1 }
