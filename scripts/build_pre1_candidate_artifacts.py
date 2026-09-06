#!/usr/bin/env python3
"""Build and prove the TypeScript pre-stable npm artifact fragment."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

import pre1_artifact_common as common


ROOT = Path(__file__).resolve().parents[1]
COMPONENT = "client-typescript"
TARGETS = {
    "linux-x86_64",
    "linux-aarch64",
    "macos-x86_64",
    "macos-arm64",
    "windows-x86_64",
}


def describe() -> dict:
    return {
        "schema": "iicp.pre1-artifact-builder-description.v1",
        "component": COMPONENT,
        "targets": sorted(TARGETS),
        "artifact_identities": [
            ["npm-tarball", "any"],
            ["package-content-manifest", "any"],
        ],
        "gates": sorted(common.GATES),
        "requires_clean_source": True,
        "non_authorizing": True,
    }


def package_contents(tarball: Path, package: str, version: str) -> dict:
    rows: list[dict] = []
    with tarfile.open(tarball, "r:gz") as archive:
        for member in archive.getmembers():
            parsed = PurePosixPath(member.name)
            if (
                parsed.is_absolute()
                or ".." in parsed.parts
                or not parsed.parts
                or parsed.parts[0] != "package"
                or member.issym()
                or member.islnk()
            ):
                raise ValueError("npm package contains an unsafe path or link")
            if not member.isfile():
                continue
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("npm package member cannot be read")
            body = stream.read()
            rows.append(
                {
                    "path": PurePosixPath(*parsed.parts[1:]).as_posix(),
                    "sha256": "sha256:" + hashlib.sha256(body).hexdigest(),
                    "size_bytes": len(body),
                }
            )
    return {
        "schema": "iicp.pre1-npm-package-contents.v1",
        "package": package,
        "version": version,
        "files": sorted(rows, key=lambda row: row["path"]),
        "content_free": True,
        "non_authorizing": True,
    }


def npm_environment(cache: Path, *, offline: bool = False) -> dict[str, str]:
    value = dict(os.environ)
    value.update(
        {
            "npm_config_cache": str(cache),
            "npm_config_engine_strict": "true",
            "npm_config_ignore_scripts": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
        }
    )
    if offline:
        value["npm_config_offline"] = "true"
    return value


def cli_path(root: Path) -> Path:
    return root / "node_modules/.bin" / ("iicp-node.cmd" if os.name == "nt" else "iicp-node")


def npm_command() -> list[str]:
    if sys.platform != "win32":
        return ["npm"]
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        raise ValueError("Windows artifact build requires Node and npm on PATH")
    # Avoid CreateProcess lookup of extensionless npm and cmd.exe argument
    # interpretation. The pinned Node distribution carries this JS entrypoint.
    entry = Path(npm).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not entry.is_file():
        raise ValueError("Windows npm CLI entrypoint is unavailable")
    return [node, str(entry)]


def build(destination: Path, requested_target: str | None) -> dict:
    common.safe_output(destination)
    target = common.require_target(requested_target, TARGETS)
    commit = common.require_clean_source(ROOT)
    package = json.loads((ROOT / "package.json").read_text())
    version = package["version"]
    if package.get("engines", {}).get("node") != "^22.0.0 || ^24.0.0":
        raise ValueError("Node package support boundary differs from the qualification policy")
    npm = npm_command()
    node_version = common.output(["node", "--version"], ROOT)
    match = re.fullmatch(r"v(\d+)\.\d+\.\d+", node_version)
    if match is None or int(match.group(1)) not in {22, 24}:
        raise ValueError("artifact build requires declared Node 22 or Node 24")

    run_root = Path(tempfile.mkdtemp(prefix="iicp-pre1-typescript-", dir=destination.parent))
    staging = run_root / "fragment"
    staging.mkdir()
    try:
        cache = run_root / "npm-cache"
        online_env = npm_environment(cache)
        common.run([*npm, "ci"], ROOT, online_env)
        common.run([*npm, "test"], ROOT, online_env)
        common.run([*npm, "run", "build"], ROOT, online_env)
        packed = run_root / "packed"
        packed.mkdir()
        raw = common.output(
            [*npm, "pack", "--json", "--pack-destination", str(packed)],
            ROOT,
            online_env,
        )
        result = json.loads(raw)
        if not isinstance(result, list) or len(result) != 1:
            raise ValueError("npm pack did not report exactly one artifact")
        tarball = packed / result[0]["filename"]
        if not tarball.is_file():
            raise ValueError("npm tarball is unavailable")
        content = package_contents(tarball, package["name"], version)
        content_path = staging / f"iicp-client-{version}-package-contents.json"
        content_path.write_text(json.dumps(content, indent=2, sort_keys=True) + "\n")

        online = run_root / "online"
        online.mkdir()
        (online / "package.json").write_text('{"private":true}\n')
        common.run([*npm, "install", str(tarball)], online, online_env)
        online_version = common.output([str(cli_path(online)), "--version"], online, online_env)
        if version not in online_version:
            raise ValueError("online npm package self-report differs")

        offline = run_root / "offline"
        offline.mkdir()
        (offline / "package.json").write_text('{"private":true}\n')
        offline_env = npm_environment(cache, offline=True)
        common.run([*npm, "install", str(tarball)], offline, offline_env)
        offline_version = common.output([str(cli_path(offline)), "--version"], offline, offline_env)
        if offline_version != online_version or version not in offline_version:
            raise ValueError("offline npm package self-report differs")

        copied = staging / tarball.name
        shutil.copyfile(tarball, copied)
        fragment = common.emit_fragment(
            staging,
            component=COMPONENT,
            source_commit=commit,
            source_version=version,
            build_target=target,
            artifacts=[
                common.artifact("npm-tarball", "any", copied),
                common.artifact("package-content-manifest", "any", content_path),
            ],
            lock_inputs_sha256=common.files_sha256(
                ROOT, [ROOT / "package.json", ROOT / "package-lock.json"]
            ),
            dependency_cache_sha256=common.tree_sha256(cache),
            toolchains={
                "node": node_version,
                "npm": common.output([*npm, "--version"], ROOT),
            },
        )
        common.publish_staging(staging, destination)
        return fragment
    finally:
        common.clean_failed_staging(run_root)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--target")
    args = parser.parse_args()
    if args.describe:
        print(json.dumps(describe(), indent=2, sort_keys=True))
        return 0
    if args.output is None:
        parser.error("--output is required unless --describe is used")
    try:
        value = build(args.output.resolve(), args.target)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(value, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
