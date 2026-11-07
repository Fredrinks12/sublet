# Boots a stock Debian 13 image in QEMU, with SSH forwarded to 127.0.0.1:2222 only.
# The image is used through a copy-on-write overlay, so the download stays pristine.
#
# -Unlock boots once straight into a shell, using the image's own kernel, to give root a password
# that works on the serial console. Debian's nocloud image ships with no usable login.
param(
    [string]$Vm = "$env:USERPROFILE\dev-tools\vm",
    [int]$MemoryMb = 640,
    [switch]$Fresh,
    [switch]$Unlock
)

$overlay = Join-Path $Vm 'sublet-vm.qcow2'
$base = Join-Path $Vm 'debian-13-nocloud-amd64.qcow2'

if ($Fresh -and (Test-Path $overlay)) { Remove-Item $overlay }
if (-not (Test-Path $overlay)) {
    & "$Vm\qemu\qemu-img.exe" create -q -f qcow2 -b $base -F qcow2 $overlay 8G
}

$qemuArgs = @(
    '-m', "$MemoryMb", '-smp', '2', '-accel', 'tcg,thread=multi',
    '-drive', "file=$overlay,if=virtio,cache=unsafe",
    '-nic', 'user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2222-:22',
    '-serial', 'tcp:127.0.0.1:4555,server=on,wait=off',
    '-display', 'none', '-monitor', 'none'
)
if ($Unlock) {
    $kernel = (Get-ChildItem (Join-Path $Vm 'boot') -Filter 'vmlinuz-*').FullName
    $initrd = (Get-ChildItem (Join-Path $Vm 'boot') -Filter 'initrd.img-*').FullName
    $qemuArgs += @('-kernel', $kernel, '-initrd', $initrd, '-append', '"root=/dev/vda1 rw console=ttyS0 init=/bin/bash"')
}
$process = Start-Process -FilePath "$Vm\qemu\qemu-system-x86_64.exe" -ArgumentList $qemuArgs -WindowStyle Hidden -PassThru
$process.Id | Out-File (Join-Path $Vm 'qemu.pid') -Encoding ascii
Write-Output "QEMU started, pid $($process.Id)"
