/** Windows ACL boundary for the durable trust store; no POSIX mode emulation. */
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

export type PrivatePathOperation = "directory-create" | "directory-check" | "file-create" | "file-check";

export function privatePathCommand(path: string, operation: PrivatePathOperation): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("private path must be absolute");
  if (!["directory-create", "directory-check", "file-create", "file-check"].includes(operation)) throw new Error("invalid private path operation");
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  return `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
  $operation = '${operation}'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $isDirectory = $operation.StartsWith('directory-')
  # Reject aliases before creation as well as before validation.
  $cursor = $path
  while ($cursor) {
    if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
      if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  if ($operation.EndsWith('-create')) {
    $security = if ($isDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $security.SetOwner($sid)
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($principal in @($sid, $system)) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $security.AddAccessRule($rule)
    }
    if ($isDirectory) {
      # The descriptor is applied at creation; existing directories are not repaired.
      [IO.Directory]::CreateDirectory($path, $security) | Out-Null
    } else {
      $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
      $stream.Dispose()
    }
  }
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH' }
  if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $isDirectory) { throw 'PATH_KIND' }
  $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'OWNER_DIFFERS' }
  $ownerFull = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'DENY_RULE' }
    if ($rule.IdentityReference.Value -notin @($sid.Value, $system.Value)) { throw 'BROAD_ACCESS' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownerFull = $true }
  }
  if (-not $ownerFull) { throw 'OWNER_ACCESS_MISSING' }
  [Console]::Out.Write('OK')
} catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  $errorCode = $exception.HResult -band 0xffff
  if ($operation -eq 'file-create' -and $errorCode -in @(80, 183)) { [Console]::Out.Write('EXISTS'); exit 0 }
  [Console]::Out.Write('REFUSED'); exit 1
}
`;
}

export function windowsPrivatePath(path: string, operation: PrivatePathOperation): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows security tool unavailable");
  let result: string;
  try {
    result = execFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(privatePathCommand(path, operation), "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Windows private-path ACL verification failed");
  }
  if (result === "EXISTS") throw Object.assign(new Error("private file already exists"), { code: "EEXIST" });
  if (result !== "OK") throw new Error("Windows private-path ACL verification failed");
}
