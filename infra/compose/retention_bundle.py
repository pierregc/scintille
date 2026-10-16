"""Stream the reviewed collector into an existing pipelines container without deploying it."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULES = {
    "scintille_lake.retention": "data/packages/scintille-lake/src/scintille_lake/retention.py",
    "scintille_pipelines.retention_collection": (
        "data/packages/scintille-pipelines/src/scintille_pipelines/retention_collection.py"
    ),
}
SOURCES = {name: (ROOT / path).read_text() for name, path in MODULES.items()}

print("import sys, types, importlib")
print(f"sources = {json.dumps(SOURCES)!r}")
print("import json; sources = json.loads(sources)")
print("for name, source in sources.items():")
print("    importlib.import_module(name.rpartition('.')[0])")
print("    module = types.ModuleType(name)")
print("    module.__package__ = name.rpartition('.')[0]")
print("    sys.modules[name] = module")
print("    exec(compile(source, name, 'exec'), module.__dict__)")
print("sys.exit(sys.modules['scintille_pipelines.retention_collection'].main())")
