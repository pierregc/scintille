"""Command line: generate code from the schemas, check it, build fixtures."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from scintille_contract import codegen, compat
from scintille_contract.schema import SchemaSet, from_files, load_dir

CONTRACT_DIR = Path("data/contract")
PYTHON_OUT = Path("data/packages/scintille-contract/src/scintille_contract/models.py")
TS_OUT = Path("web/src/contract/types.ts")
DOC = Path("docs/data-contract.md")


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def repo_root() -> Path:
    return Path(_git("rev-parse", "--show-toplevel").strip())


def expected_outputs(root: Path) -> dict[Path, str]:
    schemas = load_dir(root / CONTRACT_DIR)
    return {
        PYTHON_OUT: codegen.python_module(schemas),
        TS_OUT: codegen.typescript_module(schemas),
        DOC: codegen.render_doc((root / DOC).read_text(encoding="utf-8"), schemas),
    }


def base_schemas(ref: str) -> SchemaSet | None:
    listing = (
        _git("ls-tree", "--full-tree", "--name-only", f"{ref}:{CONTRACT_DIR}") if _has(ref) else ""
    )
    names = [name for name in listing.split() if name.endswith(".schema.json")]
    if not names:
        return None
    files = {name: json.loads(_git("show", f"{ref}:{CONTRACT_DIR / name}")) for name in names}
    return from_files(files)


def _has(ref: str) -> bool:
    result = subprocess.run(
        ["git", "cat-file", "-e", f"{ref}:{CONTRACT_DIR}"], capture_output=True, check=False
    )
    return result.returncode == 0


def generate(root: Path) -> int:
    for path, content in expected_outputs(root).items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            target.write_text(content, encoding="utf-8")
            print(f"wrote {path}")
    return 0


def check(root: Path, base: str | None) -> int:
    errors = [
        f"{path} is stale: run `uv run scintille-contract generate`"
        for path, content in expected_outputs(root).items()
        if not (root / path).exists() or (root / path).read_text(encoding="utf-8") != content
    ]
    if base is not None:
        previous = base_schemas(base)
        if previous is None:
            print(f"no contract at {base}, skipping the breaking change check")
        else:
            errors += compat.check(previous, load_dir(root / CONTRACT_DIR))
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print("contract is up to date")
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scintille-contract")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("generate", help="regenerate models, types and the doc reference")
    check_parser = commands.add_parser("check", help="fail if generated code is stale")
    check_parser.add_argument("--base", help="git ref to compare schemas against for SemVer")
    fixtures_parser = commands.add_parser("fixtures", help="write the synthetic live feed")
    fixtures_parser.add_argument("--out", type=Path, default=Path("fixtures/live"))
    commands.add_parser("bench", help="compare chunk encodings on a 10-minute sample")
    args = parser.parse_args(argv)

    root = repo_root()
    if args.command == "generate":
        return generate(root)
    if args.command == "check":
        return check(root, args.base)
    if args.command == "fixtures":
        from scintille_contract import synthetic

        synthetic.write_feed(root / args.out)
        return 0
    from scintille_contract import bench

    print(bench.report())
    return 0


if __name__ == "__main__":
    sys.exit(main())
