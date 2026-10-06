"""Offline release regressions: only owned temporary synthetic trees, no real source scan."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_check", Path(__file__).with_name("release-check.py"))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class ReleaseCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="es-release-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.network = patch("socket.create_connection", side_effect=AssertionError("network forbidden"))
        self.process = patch("subprocess.Popen", side_effect=AssertionError("subprocess forbidden"))
        self.network.start(); self.process.start()
        self.addCleanup(self.network.stop); self.addCleanup(self.process.stop)

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")

    def scan(self, allow=False):
        args = ["release-check.py", str(self.root)]
        if allow:
            self.write("allow.json", json.dumps([{"path": ".*", "pattern": ".*"}]))
            args += ["--allow", str(self.root / "allow.json")]
        output = io.StringIO()
        with patch("sys.argv", args), contextlib.redirect_stdout(output):
            result = CHECK.main()
        return result, output.getvalue()

    def test_clean_document_links_do_not_claim_publication_approval(self):
        self.write("README.md", "[Guide](docs/guide.md#usage)\n")
        self.write("docs/guide.md", "# Usage\n[Home](../README.md)\n")
        result, output = self.scan()
        self.assertEqual(result, 0)
        self.assertIn("not publication approval", output)
        self.assertNotIn("can be published", output)

    def test_missing_document_blocks_release(self):
        self.write("README.md", "[Guide](docs/missing.md)\n")
        result, output = self.scan()
        self.assertEqual(result, 1)
        self.assertIn("broken or escaping local Markdown links", output)

    def test_internal_markers_are_blocked_even_by_broad_allow_lists(self):
        for marker in ["B82", "dot", "DOT", "gpt-wip"]:
            with self.subTest(marker=marker):
                self.write("README.md", "internal: " + marker + "\n")
                result, output = self.scan(allow=True)
                self.assertEqual(result, 1)
                self.assertIn("internal work markers", output)

    def test_external_links_and_fenced_examples_are_never_fetched(self):
        self.write("README.md", "[Remote](https://example.invalid/no-request)\n```md\n[Example](missing.md)\n```\n")
        self.assertEqual(self.scan()[0], 0)

    def test_encoding_names_are_not_mistaken_for_internal_ticket_numbers(self):
        self.write("README.md", "Values retain the documented b64: encoding.\n")
        self.assertEqual(self.scan()[0], 0)

    def test_relative_links_cannot_escape_the_candidate_tree(self):
        self.write("README.md", "[Outside](../elsewhere.md)\n")
        self.assertEqual(self.scan()[0], 1)

    def test_encoded_local_paths_and_fragments_are_resolved(self):
        self.write("README.md", "[Space](docs/with%20space.md?view=1#heading)\n")
        self.write("docs/with space.md", "# Heading\n")
        self.assertEqual(self.scan()[0], 0)

    def test_dummy_secret_still_blocks_and_is_never_printed(self):
        dummy = "sk-" + "fixture" * 5
        self.write("fixture.txt", dummy)
        result, output = self.scan()
        self.assertEqual(result, 1)
        self.assertIn("secrets: API key", output)
        self.assertNotIn(dummy, output)

    def test_attribution_and_private_files_remain_blocked(self):
        self.write("NOTICE", "Copyright (c) fixture\n")
        self.write("HANDOVER.md", "private fixture\n")
        result, output = self.scan()
        self.assertEqual(result, 1)
        self.assertIn("attribution / licence wording", output)
        self.assertIn("files that must not be published", output)

    def test_snapshot_script_keeps_docs_and_excludes_internal_reviews(self):
        # Static shell contract only; never invoke git archive, tar, or a publication command.
        script = Path(__file__).with_name("make-public-snapshot.sh").read_text(encoding="utf-8")
        removals = "\n".join(line for line in script.splitlines() if line.startswith("rm "))
        self.assertNotIn('"$out/docs"', removals)
        self.assertIn('"$out/research"', removals)
        self.assertIn('"$out/tools/release"', removals)


if __name__ == "__main__":
    unittest.main()
