"""Sharding preserves discovery results and keeps each class on one worker."""

from collections import Counter
import contextlib
import io
import unittest
from unittest import mock

import shard


class ShardTest(unittest.TestCase):
    def suite(self) -> unittest.TestSuite:
        classes = [type(name, (unittest.TestCase,), {"runTest": lambda self: None}) for name in ("Large", "Medium", "Small", "Tiny")]
        return unittest.TestSuite(unittest.TestSuite(case() for _ in range(size)) for case, size in zip(classes, (7, 4, 3, 1)))

    def test_coverage_disjoint_classes_and_greedy_balance(self) -> None:
        suite = self.suite()
        original = list(shard.test_cases(suite))
        # load_tests can deliberately return the same object more than once.
        suite.addTest(original[0])
        original.append(original[0])
        selections = [list(shard.test_cases(shard.select_shard(suite, index, 3))) for index in range(3)]
        self.assertEqual(Counter(map(id, original)), Counter(id(case) for selected in selections for case in selected))
        groups = [set(type(case) for case in selected) for selected in selections]
        for index, group in enumerate(groups):
            for other in groups[index + 1:]:
                self.assertFalse(group & other)
        self.assertEqual([len(selected) for selected in selections], [8, 4, 4])

    def test_deterministic_assignment_independent_of_group_discovery_order(self) -> None:
        suite = self.suite()
        reversed_suite = unittest.TestSuite(reversed(list(suite)))
        for index in range(3):
            first = [id(case) for case in shard.test_cases(shard.select_shard(suite, index, 3))]
            second = [id(case) for case in shard.test_cases(shard.select_shard(reversed_suite, index, 3))]
            self.assertEqual(first, second)

    def test_rejects_invalid_or_empty_selection(self) -> None:
        for index, count in ((0, 0), (0, -1), (-1, 2), (2, 2), (4, 5)):
            with self.subTest(index=index, count=count), self.assertRaises(ValueError):
                shard.select_shard(self.suite(), index, count)
        with self.assertRaises(ValueError):
            shard.select_shard(unittest.TestSuite(), 0, 1)

    def test_cli_preserves_load_tests_duplicates_and_reports_failures(self) -> None:
        class Passing(unittest.TestCase):
            def runTest(self) -> None:
                pass

        class Failing(unittest.TestCase):
            def runTest(self) -> None:
                self.fail("expected failure")

        passing = Passing()
        cases = unittest.TestSuite([passing, unittest.TestSuite([passing, Failing()])])
        with mock.patch.object(unittest.TestLoader, "discover", return_value=cases) as discover, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(shard.main(["--index", "0", "--count", "1"]), 1)
        self.assertEqual(discover.call_args.kwargs["pattern"], "test_*.py")
        self.assertEqual(discover.call_args.args[0], discover.call_args.kwargs["top_level_dir"])

    def test_cli_empty_selection_is_an_error(self) -> None:
        with mock.patch.object(unittest.TestLoader, "discover", return_value=unittest.TestSuite()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exit:
            shard.main(["--index", "0", "--count", "1"])
        self.assertEqual(exit.exception.code, 2)
