"""`scintille-lake` command line."""

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from .config import LakeConfig
from .connect import pyiceberg_catalog
from .maintenance import MaintenancePolicy
from .migrate import IncompatibleChange, migrate
from .retention import inventory_coverage, inventory_measurement, read_inventory, table_measurement


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-lake")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="create or update namespaces and tables")
    maintenance = commands.add_parser(
        "maintenance", help="print the wrangler commands that apply the maintenance policy"
    )
    maintenance.add_argument("--bucket", default="scintille-lake")
    report = commands.add_parser(
        "retention-report", help="read Iceberg metadata and optional exported object inventories"
    )
    report.add_argument(
        "--label", required=True, help="observation label, e.g. production-2026-10-12"
    )
    report.add_argument("--table", action="append", help="table name; default silver.flashes")
    report.add_argument("--lake-inventory", type=Path)
    report.add_argument("--live-inventory", type=Path)
    args = parser.parse_args(argv)

    if args.command == "retention-report":
        started = datetime.now(UTC).isoformat()
        catalog = pyiceberg_catalog()
        lake_objects = read_inventory(args.lake_inventory) if args.lake_inventory else None
        tables: dict[str, object] = {}
        for name in args.table or ["silver.flashes"]:
            table = catalog.load_table(name)
            measured = table_measurement(table)
            if lake_objects is not None:
                measured["inventory_coverage"] = inventory_coverage(table, lake_objects)
            tables[name] = measured
        inventories: dict[str, object] = {}
        if lake_objects is not None:
            inventories["lake"] = inventory_measurement(lake_objects)
        if args.live_inventory:
            inventories["live"] = inventory_measurement(read_inventory(args.live_inventory))
        print(
            json.dumps(
                {
                    "label": args.label,
                    "collection_started_at": started,
                    "collection_finished_at": datetime.now(UTC).isoformat(),
                    "tables": tables,
                    "inventories": inventories,
                    "scope": "metadata and exported listings; no data scan, writes, or deletion",
                },
                indent=2,
            )
        )
        return 0

    if args.command == "maintenance":
        for command in MaintenancePolicy.from_env().wrangler_commands(args.bucket):
            print(command)
        return 0

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
