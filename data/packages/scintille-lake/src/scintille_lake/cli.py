"""`scintille-lake` command line."""

import argparse
import sys

from .config import LakeConfig
from .connect import pyiceberg_catalog
from .migrate import IncompatibleChange, migrate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-lake")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="create or update namespaces and tables")
    parser.parse_args(argv)

    config = LakeConfig.from_env()
    print(f"catalog {config.uri} warehouse {config.warehouse}")
    try:
        changes = migrate(pyiceberg_catalog(config))
    except IncompatibleChange as error:
        print(f"refused: {error}", file=sys.stderr)
        return 1
    for change in changes:
        print(change)
    print(f"{len(changes)} change(s)" if changes else "up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
