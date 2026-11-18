#!/usr/bin/env python3
"""Explicit HTTP/CONNECT proxy that permits only public HTTP(S) destinations."""

import asyncio
import base64
import hmac
import ipaddress
import json
import os
import socket
import ssl
import time
from urllib.parse import urlsplit

MAX_HEADER = 64 * 1024
ALLOWED_PORTS = {80, 443}
PREVIEW_HOST = os.environ.get("AUTOFORUM_PREVIEW_HOST")
PREVIEW_PORT = int(os.environ.get("AUTOFORUM_PREVIEW_PORT", "8080"))
PREVIEW_RELAY_PORT = 8081
ARTIFACT_PORT = int(os.environ.get("AUTOFORUM_ARTIFACT_PORT", "8082"))
ARTIFACT_RELAY_PORT = 8082
GATEWAY_RELAY_PORT = 8083
BROKER_PORT = 8084
TLS_CONTEXT = ssl.create_default_context()


def load_service_routes():
    encoded = os.environ.get("AUTOFORUM_SERVICE_ROUTES", "W10")
    padding = "=" * (-len(encoded) % 4)
    routes = json.loads(base64.urlsafe_b64decode(encoded + padding).decode("utf8"))
    return {route["name"]: route for route in routes}


SERVICE_ROUTES = load_service_routes()
SERVICE_BROKER_TOKEN = os.environ.get("AUTOFORUM_SERVICE_BROKER_TOKEN", "")
SERVICE_BROKERS = asyncio.Queue()
PREVIEW_RELAY_TOKEN = os.environ.get("AUTOFORUM_PREVIEW_RELAY_TOKEN", "")
PREVIEW_RELAY_HEADER = b"x-autoforum-preview-relay"


async def connect_public(host: str, port: int, use_tls=False):
    if port not in ALLOWED_PORTS:
        raise PermissionError("destination port is not allowed")
    loop = asyncio.get_running_loop()
    addresses = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    public = []
    for family, socktype, proto, _canonname, sockaddr in addresses:
        if ipaddress.ip_address(sockaddr[0]).is_global:
            public.append((family, socktype, proto, sockaddr))
    if not public:
        raise PermissionError("destination did not resolve only to public addresses")
    if len(public) != len(addresses):
        raise PermissionError("destination also resolved to a non-public address")
    last_error = None
    for family, _socktype, _proto, sockaddr in public:
        try:
            return await asyncio.open_connection(
                sockaddr[0],
                port,
                family=family,
                ssl=TLS_CONTEXT if use_tls else None,
                server_hostname=host if use_tls else None,
            )
        except OSError as error:
            last_error = error
    raise last_error or ConnectionError("no usable public address")


async def relay(reader, writer):
    try:
        while data := await reader.read(64 * 1024):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle_proxy(client_reader, client_writer):
    try:
        header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=30)
        if len(header) > MAX_HEADER:
            raise ValueError("header too large")
        first, *rest = header.split(b"\r\n")
        method, target, version = first.decode("latin1").split(" ", 2)
        if method.upper() == "CONNECT":
            host, separator, port_text = target.rpartition(":")
            if not separator:
                raise ValueError("CONNECT target must include a port")
            upstream_reader, upstream_writer = await connect_public(host.strip("[]"), int(port_text))
            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client_writer.drain()
        else:
            parsed = urlsplit(target)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("proxy requests require an absolute HTTP URL")
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            upstream_reader, upstream_writer = await connect_public(parsed.hostname, port)
            origin_target = parsed.path or "/"
            if parsed.query:
                origin_target += "?" + parsed.query
            upstream_writer.write(f"{method} {origin_target} {version}\r\n".encode("latin1"))
            for line in rest:
                if not line.lower().startswith(b"proxy-connection:"):
                    upstream_writer.write(line + b"\r\n")
            upstream_writer.write(b"\r\n")
            await upstream_writer.drain()
        await asyncio.gather(relay(client_reader, upstream_writer), relay(upstream_reader, client_writer))
    except Exception as error:
        try:
            body = str(error).encode("utf8")
            client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
            await client_writer.drain()
        except Exception:
            pass
        client_writer.close()


async def authenticated_preview_header(client_reader):
    header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=30)
    if len(header) > MAX_HEADER:
        raise ValueError("header too large")
    first, *rest = header.split(b"\r\n")
    forwarded = [first]
    supplied = None
    for line in rest:
        if not line:
            continue
        name, separator, value = line.partition(b":")
        if not separator:
            raise ValueError("invalid HTTP header")
        if name.strip().lower() == PREVIEW_RELAY_HEADER:
            if supplied is not None:
                raise PermissionError("duplicate preview relay credential")
            supplied = value.strip()
        else:
            forwarded.append(line)
    if (
        supplied is None
        or len(supplied) > 256
        or not PREVIEW_RELAY_TOKEN
        or not hmac.compare_digest(supplied.decode("ascii"), PREVIEW_RELAY_TOKEN)
    ):
        raise PermissionError("invalid preview relay credential")
    return b"\r\n".join(forwarded) + b"\r\n\r\n"


async def reject_preview(client_writer):
    body = b'{"error":"preview_relay_forbidden"}'
    client_writer.write(
        b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode("ascii")
        + b"\r\n\r\n"
        + body
    )
    await client_writer.drain()


async def handle_preview(client_reader, client_writer):
    try:
        header = await authenticated_preview_header(client_reader)
        if not PREVIEW_HOST:
            raise ConnectionError("preview target is not configured")
        upstream_reader, upstream_writer = await asyncio.open_connection(PREVIEW_HOST, PREVIEW_PORT)
        upstream_writer.write(header)
        await upstream_writer.drain()
        await asyncio.gather(relay(client_reader, upstream_writer), relay(upstream_reader, client_writer))
    except PermissionError:
        await reject_preview(client_writer)
        client_writer.close()
    except Exception:
        client_writer.close()


async def handle_artifact(client_reader, client_writer):
    try:
        header = await authenticated_preview_header(client_reader)
        if not PREVIEW_HOST:
            raise ConnectionError("artifact target is not configured")
        upstream_reader, upstream_writer = await asyncio.open_connection(PREVIEW_HOST, ARTIFACT_PORT)
        upstream_writer.write(header)
        await upstream_writer.drain()
        await asyncio.gather(relay(client_reader, upstream_writer), relay(upstream_reader, client_writer))
    except PermissionError:
        await reject_preview(client_writer)
        client_writer.close()
    except Exception:
        client_writer.close()


async def handle_broker(client_reader, client_writer):
    try:
        token = await asyncio.wait_for(client_reader.readline(), timeout=10)
        token = token.rstrip(b"\r\n")
        if len(token) > 256 or not SERVICE_BROKER_TOKEN or not hmac.compare_digest(
            token.decode("ascii"), SERVICE_BROKER_TOKEN
        ):
            raise PermissionError("invalid service broker")
        await SERVICE_BROKERS.put((client_reader, client_writer))
        await client_writer.wait_closed()
    except Exception:
        client_writer.close()


async def next_broker():
    while True:
        reader, writer = await asyncio.wait_for(SERVICE_BROKERS.get(), timeout=15)
        if not writer.is_closing():
            return reader, writer


async def handle_gateway(client_reader, client_writer):
    try:
        header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=30)
        if len(header) > MAX_HEADER:
            raise ValueError("header too large")
        first, *rest = header.split(b"\r\n")
        method, target, version = first.decode("latin1").split(" ", 2)
        if method.upper() == "CONNECT" or not target.startswith("/") or target.startswith("//"):
            raise ValueError("gateway requests require an origin-form HTTP target")
        requested = urlsplit(target)
        service = requested.path.lstrip("/").split("/", 1)[0]
        route = SERVICE_ROUTES.get(service)
        if not route or route["expiresAt"] <= time.time() * 1000:
            body = b'{"error":"service_access_not_granted"}'
            client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
            await client_writer.drain()
            return

        upstream_reader, upstream_writer = await next_broker()
        relay_target = requested.path
        if requested.query:
            relay_target += "?" + requested.query
        upstream_writer.write(f"{method} {relay_target} {version}\r\n".encode("latin1"))
        blocked = {
            b"authorization",
            b"connection",
            b"cookie",
            b"forwarded",
            b"host",
            b"keep-alive",
            b"proxy-authorization",
            b"proxy-connection",
            b"x-api-key",
            b"x-forwarded-for",
            b"x-forwarded-host",
            b"x-forwarded-proto",
            b"x-autoforum-service-grant",
        }
        for line in rest:
            if not line:
                continue
            name, separator, _value = line.partition(b":")
            if separator and name.strip().lower() not in blocked:
                upstream_writer.write(line + b"\r\n")
        upstream_writer.write(f'X-Autoforum-Service-Grant: {route["grantToken"]}\r\n'.encode("ascii"))
        upstream_writer.write(b"Host: autoforum-service-relay\r\nConnection: close\r\n\r\n")
        await upstream_writer.drain()
        await asyncio.gather(relay(client_reader, upstream_writer), relay(upstream_reader, client_writer))
    except Exception:
        try:
            body = b'{"error":"service_access_upstream_failed"}'
            client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body)
            await client_writer.drain()
        except Exception:
            pass
        client_writer.close()


async def main():
    proxy = await asyncio.start_server(handle_proxy, "0.0.0.0", 3128)
    preview = await asyncio.start_server(handle_preview, "0.0.0.0", PREVIEW_RELAY_PORT)
    artifacts = await asyncio.start_server(handle_artifact, "0.0.0.0", ARTIFACT_RELAY_PORT)
    gateway = await asyncio.start_server(handle_gateway, "0.0.0.0", GATEWAY_RELAY_PORT)
    broker = await asyncio.start_server(handle_broker, "0.0.0.0", BROKER_PORT)
    print("Autoforum network sidecar listening on public egress 3128, application relay 8081, artifact relay 8082, service gateway 8083, and host broker 8084", flush=True)
    async with proxy, preview, artifacts, gateway, broker:
        await asyncio.gather(proxy.serve_forever(), preview.serve_forever(), artifacts.serve_forever(), gateway.serve_forever(), broker.serve_forever())


asyncio.run(main())
