"""Balance the default E2E suite across workers without splitting test classes."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import unittest
from collections import defaultdict
from collections.abc import Iterator


def test_cases(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from test_cases(item)
        else:
            yield item


def select_shard(suite: unittest.TestSuite, index: int, count: int) -> unittest.TestSuite:
    if count < 1:
        raise ValueError("shard count must be positive")
    if not 0 <= index < count:
        raise ValueError("shard index must be between zero and count minus one")
    classes: dict[type, list[unittest.TestCase]] = defaultdict(list)
    for case in test_cases(suite):
        classes[type(case)].append(case)
    shards: list[list[unittest.TestCase]] = [[] for _ in range(count)]
    groups = sorted(classes.items(), key=lambda item: (-len(item[1]), item[0].__module__, item[0].__qualname__))
    for _, cases in groups:
        target = min(range(count), key=lambda candidate: (len(shards[candidate]), candidate))
        shards[target].extend(cases)
    if not shards[index]:
        raise ValueError(f"shard {index} of {count} contains no tests")
    return unittest.TestSuite(shards[index])


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", required=True, type=int, help="zero-based shard index")
    parser.add_argument("--count", required=True, type=int, help="number of shards")
    options = parser.parse_args(arguments)
    directory = Path(__file__).resolve().parent
    loader = unittest.TestLoader()
    suite = loader.discover(str(directory), pattern="test_*.py", top_level_dir=str(directory))
    try:
        selected = select_shard(suite, options.index, options.count)
    except ValueError as error:
        parser.error(str(error))
    print(f"E2E shard {options.index}/{options.count}: {selected.countTestCases()} tests", flush=True)
    result = unittest.TextTestRunner(verbosity=2).run(selected)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
