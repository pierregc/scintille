"""`/healthz` and `/metrics` on a small HTTP server, for the container healthcheck and scraping."""

import asyncio
from collections.abc import Callable


async def serve(
    port: int, healthy: Callable[[], bool], metrics: Callable[[], str]
) -> asyncio.Server:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), timeout=5)
            path = request.split()[1].decode() if len(request.split()) > 1 else "/"
            if path == "/healthz":
                ok = healthy()
                status, body = (
                    ("200 OK", "ok\n") if ok else ("503 Service Unavailable", "unhealthy\n")
                )
            elif path == "/metrics":
                status, body = "200 OK", metrics()
            else:
                status, body = "404 Not Found", "not found\n"
            payload = body.encode()
            writer.write(
                f"HTTP/1.1 {status}\r\nContent-Type: text/plain; version=0.0.4\r\n"
                f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
                + payload
            )
            await writer.drain()
        except (TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()

    return await asyncio.start_server(handle, "0.0.0.0", port)
