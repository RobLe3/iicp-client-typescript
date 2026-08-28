from __future__ import annotations

import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
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
