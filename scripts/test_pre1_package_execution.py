"""Negative controls for installed-payload and staged-assertion provenance."""
from __future__ import annotations

import copy
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import pre1_package_execution as adapter


class PackageExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pre1-package-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.root = self.home / "checkout"
        self.workspace = self.home / "run/workspace"
        self.root.mkdir()
        self.workspace.mkdir(parents=True)
        (self.root / "tests").mkdir()
        (self.root / "tests/test_fixture.py").write_text("def test_fixture(): pass\n")
        (self.root / "src").mkdir()
        (self.root / "src/runtime.py").write_text("must not be staged")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        self.installed = self.workspace / "site/iicp_client"
        self.installed.mkdir(parents=True)
        (self.installed / "__init__.py").write_text("__version__ = '0.7.110'\n")
        self.artifact = self.home / "sdk.whl"
        with zipfile.ZipFile(self.artifact, "w") as archive:
            archive.write(self.installed / "__init__.py", "iicp_client/__init__.py")
        self.bindings = {key: "sha256:" + "a" * 64 for key in adapter.BINDINGS}
        self.context = {"component": "client-python", "runtime": "cpython-3.13",
                        "target": "macos-arm64", **self.bindings}
        self.env = patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def binding(self):
        return adapter.create_binding(self.root, self.workspace, self.installed,
            self.artifact, "client-python", "cpython-3.13", "macos-arm64", self.bindings)

    def validate(self, value):
        return adapter.validate_binding(value, self.context, self.artifact, self.root)

    def test_exact_installed_payload_and_no_source_staging(self):
        value = self.binding()
        self.assertEqual(self.validate(value), self.workspace)
        self.assertFalse((self.workspace / "src").exists())
        self.assertFalse(value["qualification_credit"])

    def test_payload_missing_extra_and_modified_fail(self):
        self.binding()
        file = self.installed / "__init__.py"
        original = file.read_bytes()
        for action in (lambda: file.unlink(), lambda: file.write_text("modified")):
            action()
            with self.assertRaises(ValueError):
                adapter.installed_payload(self.artifact, self.installed, "client-python")
            file.write_bytes(original)
        (self.installed / "extra.py").write_text("extra")
        with self.assertRaises(ValueError):
            adapter.installed_payload(self.artifact, self.installed, "client-python")

    def test_each_immutable_dimension_fails_even_when_rehashed(self):
        value = self.binding()
        for key in ("component", "target", "runtime"):
            changed = copy.deepcopy(value)
            changed[key] = "wrong"
            changed["binding_sha256"] = None
            changed["binding_sha256"] = adapter.digest(changed)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(changed)
        for key in adapter.BINDINGS:
            changed = copy.deepcopy(value)
            changed["bindings"][key] = "sha256:" + "b" * 64
            changed["binding_sha256"] = None
            changed["binding_sha256"] = adapter.digest(changed)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate(changed)

    def test_fixture_tamper_and_checkout_source_fallback_fail(self):
        value = self.binding()
        (self.workspace / "tests/test_fixture.py").write_text("tamper")
        with self.assertRaisesRegex(ValueError, "fixtures changed"):
            self.validate(value)
        (self.workspace / "src").mkdir()
        with self.assertRaisesRegex(ValueError, "runtime source"):
            self.validate(value)

    def test_staged_assertions_must_match_reviewed_mapping(self):
        adapter.stage(self.root, self.workspace, "client-python")
        (self.workspace / "tests/test_fixture.py").write_text("tamper")
        with self.assertRaisesRegex(ValueError, "reviewed source mapping"):
            self.binding()

    def test_symlinks_and_unsafe_ancestors_fail(self):
        value = self.binding()
        (self.installed / "link.py").symlink_to(self.root / "src/runtime.py")
        with self.assertRaises(ValueError):
            self.validate(value)
        alias = self.home / "alias"
        alias.symlink_to(self.workspace, target_is_directory=True)
        with self.assertRaises(ValueError):
            adapter.safe_path(alias / "tests")

    def test_dependency_tamper_fails(self):
        value = self.binding()
        (self.installed.parent / "pytest.py").write_text("injected")
        with self.assertRaisesRegex(ValueError, "dependencies changed"):
            self.validate(value)

    def test_rehashed_fixture_and_binding_cannot_replace_reviewed_assertions(self):
        value = self.binding()
        (self.workspace / "tests/test_fixture.py").write_text("def test_fixture(): assert True\n")
        value["fixtures_sha256"] = adapter.digest(adapter.fixture_tree(self.workspace))
        value["binding_sha256"] = None
        value["binding_sha256"] = adapter.digest(value)
        with self.assertRaisesRegex(ValueError, "reviewed source mapping"):
            self.validate(value)

    def test_cli_adapter_decodes_file_urls(self):
        fixture = 'const cli = readFileSync("src/cli.ts");\n  assert.match(cli, /version/);\n'
        staged = adapter.packaged_assertions("tests/pre1_release_boundaries.test.ts", fixture)
        self.assertIn('import { fileURLToPath } from "node:url"', staged)
        self.assertIn("fileURLToPath(new URL(", staged)
        self.assertNotIn(".pathname", staged)

    def test_cli_subprocess_with_spaces_and_unicode_path(self):
        import shutil
        node = shutil.which("node")
        if not node:
            self.fail("Node is required for the CLI portability regression")
        directory = self.home / "IICP space ü"
        directory.mkdir()
        cli = directory / "cli.mjs"
        cli.write_text('console.log("iicp-node 0.7.110");')
        script = '''import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,[fileURLToPath(new URL(process.argv[1])),'--version'],{encoding:'utf8'});
process.stdout.write(result.stdout); process.exit(result.status ?? 1);'''
        result = subprocess.run([node, "--input-type=module", "-e", script, cli.as_uri()],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "iicp-node 0.7.110")

    def test_case_proof_is_portable_and_bound_to_result(self):
        value = adapter.make_case_proof(self.binding(), self.context, "test_fixture", 0, "pre1-test")
        adapter.validate_case_proof(value, self.context, 0, "pre1-test")
        self.assertNotIn(str(self.home), json.dumps(value))
        for field, replacement in (("run_id", "different"), ("exit_code", 1),
                                    ("context", {**self.context, "target": "windows-x86_64"})):
            changed = copy.deepcopy(value)
            changed[field] = replacement
            changed["proof_sha256"] = None
            changed["proof_sha256"] = adapter.digest(changed)
            with self.subTest(field=field), self.assertRaises(ValueError):
                adapter.validate_case_proof(changed, self.context, 0, "pre1-test")

    def test_case_proof_atomic_non_overwriting_and_safe(self):
        proof = adapter.make_case_proof(self.binding(), self.context, "test_fixture", 0, "pre1-test")
        output = self.home / "proof.json"
        with patch.dict(os.environ, {"IICP_PRE1_CASE_PROOF_OUTPUT": str(output)}):
            adapter.write_case_proof(proof)
            self.assertEqual(json.loads(output.read_text()), proof)
            with self.assertRaises(ValueError):
                adapter.write_case_proof(proof)
        self.assertEqual(list(self.home.glob(".case-proof-*")), [])
        link = self.home / "linked-proof"
        link.symlink_to(output)
        for unsafe in (link, self.home.parent / "outside-proof.json"):
            with patch.dict(os.environ, {"IICP_PRE1_CASE_PROOF_OUTPUT": str(unsafe)}), self.assertRaises(ValueError):
                adapter.write_case_proof(proof)

    def test_case_proof_refuses_unknown_fields_and_tampered_summary(self):
        value = adapter.make_case_proof(self.binding(), self.context, "test_fixture", 0, "pre1-test")
        for change in (lambda v: v.update(output="secret"),
                       lambda v: v["execution"].update(installed_package=str(self.installed)),
                       lambda v: v["execution"]["bindings"].update(runtime_map_sha256="wrong")):
            changed = copy.deepcopy(value)
            change(changed)
            changed["proof_sha256"] = None
            changed["proof_sha256"] = adapter.digest(changed)
            with self.assertRaises(ValueError):
                adapter.validate_case_proof(changed, self.context, 0, "pre1-test")

    def test_no_binding_cannot_run_source_case(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(KeyError):
            adapter.package_command(self.root, self.context, {}, self.home, [], {})

    def test_crypto_bridge_uses_runtime_verifier_not_test_local_policy(self):
        text = "def _decision(vector: dict, keys: dict, signature_valid: bool):\n    return 'fake'\n\ndef _assert_fixture_decision(): pass\n"
        bridged = adapter.packaged_assertions("tests/test_dispatch_ticket_trust_crypto.py", text)
        self.assertIn("verify_dispatch_ticket_v2(", bridged)
        self.assertNotIn("return 'fake'", bridged)
        text = "function decision(vector: any, keys: Map<string, any>, signatureValid: boolean): string { return 'fake'; }\nfunction assertFixtureDecision(): void {}"
        bridged = adapter.packaged_assertions("tests/dispatch_ticket_trust_crypto.test.ts", text)
        self.assertIn("verifyDispatchTicketV2(", bridged)
        self.assertNotIn("return 'fake'", bridged)

    def test_cli_fixture_requires_reviewed_shape(self):
        with self.assertRaisesRegex(ValueError, "fixture shape differs"):
            adapter.packaged_assertions("tests/pre1_release_boundaries.test.ts", "changed fixture")

    def test_python_command_uses_only_installed_path_and_guard(self):
        value = self.binding()
        path = self.home / "binding.json"
        path.write_text(json.dumps(value))
        component = {"artifacts": [{"kind": "wheel", "name": "sdk.whl"}]}
        artifact_root = self.home / "artifacts"
        (artifact_root / "client-python").mkdir(parents=True)
        (artifact_root / "client-python/sdk.whl").write_bytes(self.artifact.read_bytes())
        with patch.dict(os.environ, {"IICP_PRE1_PACKAGE_EXECUTION_BINDING": str(path),
                "IICP_PRE1_PACKAGE_EXECUTION_SHA256": value["binding_sha256"]}):
            argv, env, cwd, _ = adapter.package_command(self.root, self.context,
                component, artifact_root, ["python", "-m", "pytest", "-q", "tests/test_fixture.py::test_fixture"], {})
        self.assertEqual(argv[3:5], ["-p", "pre1_origin_guard"])
        self.assertEqual(cwd, self.workspace)
        self.assertNotIn(str(self.root), env["PYTHONPATH"])

    def test_typescript_literals_and_child_worker_bind_to_dist(self):
        text = 'import x from "../src/client.js"; require("../src/trust"); import y from "./src/service_lifecycle.ts";'
        rewritten = adapter.rewrite_typescript(text)
        self.assertNotIn("src/", rewritten)
        self.assertIn('"./node_modules/@iicp/client/dist/service_lifecycle.js"', rewritten)
        with self.assertRaises(ValueError):
            adapter.rewrite_typescript('import "../src/../../escape.js"')

    def test_typescript_archive_and_missing_compiled_file(self):
        artifact = self.home / "sdk.tgz"
        installed = self.workspace / "node_modules/@iicp/client"
        (installed / "dist").mkdir(parents=True)
        (installed / "dist/client.js").write_bytes(b"compiled")
        with tarfile.open(artifact, "w:gz") as archive:
            info = tarfile.TarInfo("package/dist/client.js")
            info.size = len(b"compiled")
            archive.addfile(info, io.BytesIO(b"compiled"))
        adapter.installed_payload(artifact, installed, "client-typescript")
        (installed / "dist/client.js").unlink()
        with self.assertRaises(ValueError):
            adapter.installed_payload(artifact, installed, "client-typescript")


if __name__ == "__main__":
    unittest.main()
