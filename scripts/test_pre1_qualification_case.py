#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "pre1_driver", ROOT / "scripts/run_pre1_qualification_case.py"
)
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


class DriverContractTests(unittest.TestCase):
    def test_description_is_complete_and_content_free(self) -> None:
        value = module.description()
        self.assertEqual(
            value["schema"], "iicp.pre1-component-driver-description.v1"
        )
        self.assertEqual(value["component"], module.COMPONENT)
        self.assertEqual(value["scenarios"], sorted(module.SCENARIO_COMMANDS))
        self.assertTrue(value["commands_sha256"].startswith("sha256:"))
        self.assertTrue(value["semantic_binding"]["exact_assertion_per_scenario"])
        self.assertTrue(value["semantic_binding"]["exact_assertion_result_required"])
        self.assertEqual(
            set(value["semantic_binding"]["cell_dimensions_consumed"]),
            {
                "runtime",
                "target",
                "directory_flavor",
                "mode",
                "cell_id",
                "scenario_id",
            },
        )
        self.assertTrue(value["non_authorizing"])

    def test_cell_parser_rejects_wrong_component_and_boundary(self) -> None:
        good = "|".join(
            (
                module.COMPONENT,
                module.RUNTIMES[0],
                module.TARGETS[0],
                module.DIRECTORIES[0],
                module.MODES[0],
            )
        )
        self.assertEqual(module.parse_cell(good)[0], module.COMPONENT)
        with self.assertRaises(ValueError):
            module.parse_cell("wrong|" + "|".join(good.split("|")[1:]))
        with self.assertRaises(ValueError):
            module.parse_cell(good.replace(module.RUNTIMES[0], "unsupported"))

    def test_referenced_test_files_exist(self) -> None:
        cases = [module.SUPPORT_CASE, *module.SCENARIO_CASES.values()]
        for case in cases:
            command = case["command"]
            source = ROOT / command[6]
            self.assertTrue(source.is_file(), source)
            self.assertIn(case["assertion"], source.read_text())

    def test_exact_tap_result_refuses_missing_skipped_or_ambiguous_assertions(self) -> None:
        assertion = "exact assertion"
        good = "\n".join(
            (
                "TAP version 13",
                f"# Subtest: {assertion}",
                f"ok 1 - {assertion}",
                "# tests 1",
                "# pass 1",
                "# fail 0",
                "# skipped 0",
            )
        )
        self.assertTrue(module.exact_tap_assertion_passed(good, assertion))
        self.assertFalse(module.exact_tap_assertion_passed(good.replace("# tests 1", "# tests 0"), assertion))
        self.assertFalse(module.exact_tap_assertion_passed(good.replace("# skipped 0", "# skipped 1"), assertion))

    def test_every_scenario_has_one_unique_exact_assertion(self) -> None:
        self.assertEqual(set(module.SCENARIO_CASES), set(module.SCENARIO_COMMANDS))
        assertions = [row["assertion"] for row in module.SCENARIO_CASES.values()]
        self.assertEqual(len(assertions), len(set(assertions)))
        self.assertNotIn(module.SUPPORT_CASE["assertion"], assertions)

    def test_semantic_context_negative_controls_change_the_binding(self) -> None:
        base = (
            "client-typescript|node-22|macos-arm64|rust|restricted",
            "rate-limit",
            "sha256:" + "a" * 64,
            "sha256:" + "b" * 64,
            "sha256:" + "c" * 64,
            "sha256:" + "d" * 64,
        )
        expected = module.canonical_sha256(module.semantic_execution_context(*base))
        mutations = [
            (base[0].replace("node-22", "node-24"), *base[1:]),
            (base[0].replace("macos-arm64", "windows-x86_64"), *base[1:]),
            (base[0].replace("|rust|", "|php|"), *base[1:]),
            (base[0].replace("restricted", "public"), *base[1:]),
            (base[0], "disk-full", *base[2:]),
            (*base[:2], "sha256:" + "e" * 64, *base[3:]),
            (*base[:3], "sha256:" + "e" * 64, *base[4:]),
            (*base[:4], "sha256:" + "e" * 64, base[5]),
            (*base[:5], "sha256:" + "e" * 64),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation[:2]):
                try:
                    observed = module.canonical_sha256(
                        module.semantic_execution_context(*mutation)
                    )
                except ValueError:
                    continue
                self.assertNotEqual(observed, expected)

    def test_environment_manifest_requires_offline_package_smoke_and_digest(self) -> None:
        candidate = "sha256:" + "a" * 64
        artifacts = "sha256:" + "b" * 64
        runtime_map = "sha256:" + "c" * 64
        value = {
            "schema": "iicp.pre1-qualification-environment.v1",
            "status": "READY",
            "target": "macos-arm64",
            "bindings": {
                "candidate_manifest_sha256": candidate,
                "artifact_materialization_sha256": artifacts,
                "runtime_map_sha256": runtime_map,
                "runner_inventory_sha256": "sha256:" + "d" * 64,
            },
            "network": {},
            "source_state": {},
            "runtimes": {
                "node-22": {
                    "lock_inputs_sha256": "sha256:" + "e" * 64,
                    "dependency_cache_sha256": "sha256:" + "f" * 64,
                    "online_prepare_status": "PASS",
                    "offline_install_status": "PASS",
                    "package_artifact_smoke_status": "PASS",
                    "egress_disabled_during_offline": True,
                    "empty_volatile_cache_at_start": True,
                }
            },
            "content_free": True,
            "secrets_present": False,
            "non_authorizing": True,
            "environment_sha256": None,
        }
        value["environment_sha256"] = module.canonical_sha256(value)
        self.assertEqual(
            module._validate_environment_manifest(
                value,
                target="macos-arm64",
                runtime="node-22",
                candidate_digest=candidate,
                materialization_digest=artifacts,
                runtime_map_digest=runtime_map,
            ),
            value["environment_sha256"],
        )
        for mutation in (
            ("offline_install_status", "FAIL"),
            ("package_artifact_smoke_status", "FAIL"),
            ("egress_disabled_during_offline", False),
        ):
            changed = copy.deepcopy(value)
            changed["runtimes"]["node-22"][mutation[0]] = mutation[1]
            changed["environment_sha256"] = None
            changed["environment_sha256"] = module.canonical_sha256(changed)
            with self.assertRaises(ValueError):
                module._validate_environment_manifest(
                    changed,
                    target="macos-arm64",
                    runtime="node-22",
                    candidate_digest=candidate,
                    materialization_digest=artifacts,
                    runtime_map_digest=runtime_map,
                )

    def test_node_runtime_is_exactly_bound_to_cell(self) -> None:
        self.assertEqual(module.expected_runtime_version("node-22", {}), "22")


if __name__ == "__main__":
    unittest.main()
