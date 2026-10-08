"""Serve the fixtures like R2 does: python3 fixtures/serve.py [port], then open http://localhost:8787/."""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".gz": "application/octet-stream",
        ".json": "application/json",
    }

    def end_headers(self) -> None:
        if self.path.endswith(".bin.gz"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif self.path.endswith("manifest.json"):
            self.send_header("Cache-Control", "public, max-age=10")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    handler = partial(Handler, directory=str(Path(__file__).parent))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"serving fixtures on http://localhost:{port}/ (manifest: /live/manifest.json)")
        server.serve_forever()


if __name__ == "__main__":
    main()
