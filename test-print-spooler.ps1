$printer = "EPSON L3210 Series"
$testFile = "$env:TEMP\test_print_multitool.txt"

# Create test file
"Test page for auto-increment check - MultiTool Pro $(Get-Date -Format 'HH:mm:ss')" | Out-File -FilePath $testFile -Encoding utf8

Write-Host "Printing to: $printer"

# Print through Windows Spooler (goes via driver -> EventLog ID 307)
Get-Content $testFile | Out-Printer -Name $printer

Write-Host "Print sent. Waiting 5 seconds..."
Start-Sleep -Seconds 5

# Clean up
Remove-Item $testFile -ErrorAction SilentlyContinue

Write-Host "Done"
