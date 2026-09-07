# Windows durable dispatch trust stores

`FileDispatchTrustBundleStore` uses Windows DACLs on Windows, not `chmod` mode
bits. A new store directory and its lock/state files grant full control to the
current Windows identity and LocalSystem. Existing directories are checked rather
than having their permissions silently changed. Broader allow entries, unexpected
ownership, deny entries, and reparse paths are rejected conservatively.

The implementation invokes the system Windows PowerShell executable without a
profile or shell interpolation. Paths are encoded separately. Each invocation
has a ten-second timeout and bounded output. Missing tools, inaccessible ACLs,
and timeouts fail closed. This synchronous security check has process-startup
cost; it is not a high-throughput performance claim. Memory-only trust stores do
not use this path.

Keep the store in a dedicated directory. Do not point it at an existing shared
application directory and expect installation to rewrite that directory's ACLs.
An administrator changing permissions is a separate operator action, not an SDK
migration side effect. LocalSystem access does not claim protection from a
privileged Windows administrator.

The Windows diagnostic tests exercise creation, atomic replacement, corruption
recovery, held locks, broad and inherited access rejection, junction rejection,
and missing security-tool handling. Diagnostic VM results are not clean candidate
qualification. POSIX permission enforcement is unchanged.
