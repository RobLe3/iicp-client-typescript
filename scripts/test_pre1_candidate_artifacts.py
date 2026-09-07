from __future__ import annotations

import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pre1_candidate_artifacts as module


class Pre1CandidateArtifactBuilderTest(unittest.TestCase):
    def test_description_is_content_free_and_complete(self) -> None:
        value = json.loads(
            subprocess.check_output([sys.executable, str(module.__file__), "--describe"], text=True)
        )
        self.assertEqual(value["component"], "client-typescript")
        self.assertEqual(len(value["artifact_identities"]), 2)
        self.assertTrue(value["non_authorizing"])

    def test_windows_npm_uses_node_entrypoint_without_shell(self) -> None:
        with tempfile.TemporaryDirectory(prefix="npm tools ") as temporary:
            root = Path(temporary)
            entry = root / "node_modules/npm/bin/npm-cli.js"
            entry.parent.mkdir(parents=True)
            entry.write_text("// fixture")
            paths = {"node": str(root / "node.exe"), "npm": str(root / "npm.cmd")}
            with patch.object(module.sys, "platform", "win32"), patch.object(module.shutil, "which", side_effect=paths.get):
                self.assertEqual([paths["node"], str(entry)], module.npm_command())
                entry.unlink()
                with self.assertRaisesRegex(ValueError, "entrypoint"):
                    module.npm_command()

    def test_missing_windows_tools_fail_before_build(self) -> None:
        with patch.object(module.sys, "platform", "win32"), patch.object(module.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "requires Node and npm"):
                module.npm_command()

    def test_non_windows_command_is_unchanged(self) -> None:
        with patch.object(module.sys, "platform", "linux"):
            self.assertEqual(["npm"], module.npm_command())

    def test_package_content_manifest_rejects_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            tarball = Path(temporary) / "package.tgz"
            with tarfile.open(tarball, "w:gz") as archive:
                info = tarfile.TarInfo("package/link")
                info.type = tarfile.SYMTYPE
                info.linkname = "../../unsafe"
                archive.addfile(info)
            with self.assertRaisesRegex(ValueError, "unsafe"):
                module.package_contents(tarball, "@iicp/client", "0.7.110")


if __name__ == "__main__":
    unittest.main()
