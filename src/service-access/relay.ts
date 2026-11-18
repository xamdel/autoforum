import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

import { isPublicAddress } from "../network/public-address.ts";
import type { ServiceAccess, ServiceGrant } from "./services.ts";
import type { ServiceBrokerTarget } from "../sandbox/lifecycle.ts";

const GRANT_HEADER = "x-autoforum-service-grant";
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  GRANT_HEADER,
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface RunningServiceRelay {
  /** Opaque process-lifetime capability for the sidecar's loopback-only broker. */
  brokerToken: string;
  /** Keep host-initiated tunnels ready for one running project sidecar. */
  connectBroker(target: ServiceBrokerTarget): void;
  /** Loopback address used only by tests and local host checks. */
  localOrigin: string;
  stop(): Promise<void>;
}

function replyJson(response: http.ServerResponse, status: number, error: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error }));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    connection: "close",
  });
  response.end(body);
}

async function publicAddress(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("service_access_host_not_found");
  for (const address of addresses) {
    const family = address.family === 4 ? 4 : 6;
    if (!isPublicAddress(address.address, family)) throw new Error("service_access_private_address");
  }
  return addresses.find((address) => address.family === 4) ?? addresses[0]!;
}

function requestHeaders(
  request: http.IncomingMessage,
  grant: ServiceGrant,
  upstream: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const credentialHeader = grant.service.authHeader.toLowerCase();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || BLOCKED_REQUEST_HEADERS.has(name) || name === credentialHeader) continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  headers[grant.service.authHeader] = grant.service.authPrefix + grant.credential;
  return headers;
}

function responseHeaders(upstream: http.IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

function serviceRequest(request: http.IncomingMessage): { name: string; path: string } | null {
  const target = request.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  const parsed = new URL(target, "http://autoforum-relay.invalid");
  const name = parsed.pathname.slice(1).split("/", 1)[0] ?? "";
  if (!SERVICE_NAME.test(name)) return null;
  return { name, path: `${parsed.pathname}${parsed.search}` };
}

async function relayRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  access: ServiceAccess,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (request.method === "CONNECT") {
    replyJson(response, 405, "service_access_method_not_allowed");
    return;
  }
  const target = serviceRequest(request);
  const grantToken = request.headers[GRANT_HEADER];
  if (!target || typeof grantToken !== "string") {
    replyJson(response, 403, "service_access_not_granted");
    return;
  }
  const grant = await access.resolveGrant(grantToken, target.name);
  if (!grant) {
    replyJson(response, 403, "service_access_not_granted");
    return;
  }

  const upstream = new URL(grant.service.upstream);
  const suffix = target.path.slice(target.name.length + 1);
  const split = suffix.indexOf("?");
  const suffixPath = split === -1 ? suffix : suffix.slice(0, split);
  const query = split === -1 ? "" : suffix.slice(split);
  const upstreamPath = `${upstream.pathname.replace(/\/$/, "")}${suffixPath || ""}` || "/";
  const address = await publicAddress(upstream.hostname);

  const outgoing = https.request({
    protocol: "https:",
    hostname: address.address,
    family: address.family,
    port: 443,
    servername: upstream.hostname,
    method: request.method,
    path: `${upstreamPath}${query}`,
    headers: requestHeaders(request, grant, upstream),
    agent: false,
  }, (upstreamResponse) => {
    const headers = responseHeaders(upstreamResponse);
    headers.connection = "close";
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.on("error", () => response.destroy());
    upstreamResponse.pipe(response);
  });
  outgoing.setTimeout(30 * 60_000, () => outgoing.destroy(new Error("service_access_upstream_timeout")));
  outgoing.once("error", (error) => {
    onError?.(error);
    replyJson(response, 502, "service_access_upstream_failed");
  });
  request.once("aborted", () => outgoing.destroy());
  request.pipe(outgoing);
}

export async function startServiceRelay(
  access: ServiceAccess,
  options: {
    port?: number;
    brokerPoolSize?: number;
    onError?: (error: unknown) => void;
  } = {},
): Promise<RunningServiceRelay> {
  const server = http.createServer((request, response) => {
    void relayRequest(request, response, access, options.onError)
      .catch((error) => {
        options.onError?.(error);
        replyJson(response, 502, "service_access_upstream_failed");
      });
  });
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("service_relay_address_unavailable");
  const port = (address as AddressInfo).port;
  const brokerToken = randomBytes(32).toString("base64url");
  const poolSize = options.brokerPoolSize ?? 4;
  const pools = new Map<string, {
    target: ServiceBrokerTarget;
    connections: Set<{
      broker: net.Socket;
      local?: net.Socket;
      closed: boolean;
    }>;
  }>();
  let isStopping = false;

  const fillPool = (project: string) => {
    const pool = pools.get(project);
    if (isStopping || !pool) return;
    while (pool.connections.size < poolSize) {
      const connection = {
        broker: net.createConnection({ host: pool.target.host, port: pool.target.port }),
        local: undefined as net.Socket | undefined,
        closed: false,
      };
      pool.connections.add(connection);
      const cleanup = () => {
        if (connection.closed) return;
        connection.closed = true;
        connection.broker.destroy();
        connection.local?.destroy();
        pool.connections.delete(connection);
        if (!isStopping && pools.get(project) === pool) {
          const retry = setTimeout(() => fillPool(project), 250);
          retry.unref();
        }
      };
      connection.broker.setKeepAlive(true);
      connection.broker.once("error", cleanup);
      connection.broker.once("close", cleanup);
      connection.broker.once("connect", () => {
        connection.broker.write(`${brokerToken}\n`, () => {
          if (connection.closed || isStopping) return cleanup();
          const local = net.createConnection({ host: "127.0.0.1", port });
          connection.local = local;
          local.setKeepAlive(true);
          local.once("error", cleanup);
          local.once("close", cleanup);
          local.once("connect", () => {
            connection.broker.pipe(local);
            local.pipe(connection.broker);
          });
        });
      });
    }
  };

  let stopping: Promise<void> | undefined;
  return {
    brokerToken,
    connectBroker(target) {
      const existing = pools.get(target.project);
      if (existing && existing.target.containerId === target.containerId && existing.target.port === target.port) {
        fillPool(target.project);
        return;
      }
      if (existing) {
        pools.delete(target.project);
        for (const connection of existing.connections) {
          connection.broker.destroy();
          connection.local?.destroy();
        }
      }
      pools.set(target.project, { target, connections: new Set() });
      fillPool(target.project);
    },
    localOrigin: `http://127.0.0.1:${port}`,
    stop() {
      stopping ??= (async () => {
        isStopping = true;
        for (const pool of pools.values()) {
          for (const connection of pool.connections) {
            connection.broker.destroy();
            connection.local?.destroy();
          }
        }
        pools.clear();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      })();
      return stopping;
    },
  };
}
