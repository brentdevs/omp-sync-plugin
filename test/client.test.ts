import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ApiError, normalizeServerUrl, pairDevice, SyncClient } from "../src/client";
import type { Json } from "../src/types";

const token = `omps_${"a".repeat(43)}`;
const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
const servers: Server<undefined>[] = [];
afterEach(async () => { for (const stream of streams.splice(0)) { try { stream.close(); } catch {} } await Promise.all(servers.splice(0).map(server => server.stop(true))); });
function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
const record = { kind: "setting" as const, key: "theme", revision: 1, deleted: false, value: "dark", deviceId: "device", updatedAt: 1 };
const snapshot = { epoch: "epoch", profile: "default", cursor: 1, records: [record] };

describe("SyncClient HTTP boundaries", () => {
  test("normalizes only secure origins and loopback HTTP", () => {
    expect(normalizeServerUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeServerUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
    expect(normalizeServerUrl("http://127.42.0.1:8080/")).toBe("http://127.42.0.1:8080");
    for (const value of ["http://example.com", "https://example.com/api", "https://user:pass@example.com", "https://example.com/?token=x", "https://example.com/#x", "file:///tmp/x"]) expect(() => normalizeServerUrl(value)).toThrow();
  });
  test("authentication and arbitrary upstream error fields never leak", async () => {
    const url = serve(() => Response.json({ error: { code: "unauthorized", message: "secret-token https://private.example", details: { token: "secret-token" } } }, { status: 401 }));
    try { await new SyncClient(url, token).snapshot(); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw error;
      expect(error.status).toBe(401); expect(error.code).toBe("unauthorized");
      expect(String(error)).not.toContain("secret-token"); expect(String(error)).not.toContain("private.example");
    }
  });
  test("rejects redirects without contacting the destination", async () => {
    let contacted = false;
    const destination = serve(() => { contacted = true; return Response.json(snapshot); });
    const url = serve(() => new Response(null, { status: 307, headers: { Location: destination } }));
    await expect(new SyncClient(url, token).snapshot()).rejects.toMatchObject({ code: "redirect_refused" });
    expect(contacted).toBe(false);
  });
  test("rejects invalid protocol envelopes and invalid pairing", async () => {
    for (const response of [
      { ...snapshot, cursor: -1 },
      { ...snapshot, records: [{ ...record, revision: 2 }] },
      { ...snapshot, records: [{ ...record, deleted: true }] },
      { ...snapshot, records: [{ ...record, kind: "other" }] },
    ]) {
      const url = serve(() => Response.json(response));
      await expect(new SyncClient(url, token).snapshot()).rejects.toMatchObject({ code: "invalid_response" });
    }
    const url = serve(() => Response.json({ token: "token", device: { id: "id" } }));
    await expect(pairDevice(url, "code")).rejects.toMatchObject({ code: "invalid_response" });
  });
  test("bounds response bytes even without content-length and bounds writes", async () => {
    const url = serve(() => new Response(new ReadableStream({ start(controller) {
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      for (let index = 0; index < 17; index++) controller.enqueue(chunk);
      controller.close();
    } }), { headers: { "Content-Type": "application/json" } }));
    const client = new SyncClient(url, token);
    await expect(client.snapshot()).rejects.toMatchObject({ code: "response_too_large" });
    await expect(client.mutate({ epoch: "epoch", operationId: "operation", mutations: [{ kind: "setting", key: "large", expectedRevision: 0, value: "x".repeat(1024 * 1024) }] })).rejects.toMatchObject({ code: "body_too_large" });
  });
  test("cancels an in-flight response and an already aborted request", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const url = serve(() => { started(); return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }), { headers: { "Content-Type": "application/json" } }); });
    const controller = new AbortController();
    const promise = new SyncClient(url, token).snapshot(controller.signal);
    await ready; controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    await expect(new SyncClient(url, token).snapshot(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
  test("preserves reserved raw keys without creating object prototypes", async () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2}');
    const url = serve(() => Response.json({ ...snapshot, records: [{ ...record, value: raw }] }));
    const result = await new SyncClient(url, token).snapshot();
    expect(result.records[0]!.value).toEqual(raw);
    expect(Object.getPrototypeOf(result.records[0]!.value)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test("rejects invalid local tokens and gives safe pairing input guidance", async () => {
    for (const invalid of ["token", `omps_${"a".repeat(42)}`, `omps_${"a".repeat(44)}`, `omps_${"!".repeat(43)}`]) {
      expect(() => new SyncClient("https://example.com", invalid)).toThrow();
      const url = serve(() => Response.json({ token: invalid, device: { id: "id", name: "name", profile: "profile" } }));
      await expect(pairDevice(url, "code")).rejects.toMatchObject({ code: "invalid_response" });
    }
    await expect(pairDevice("https://example.com", "")).rejects.toMatchObject({ name: "UserError" });
  });
  test("checks exact JSON media types and declared length before reading", async () => {
    const cases: Record<string, string>[] = [
      { "content-type": "application/jsonp" },
      { "content-type": "text/plain" },
      { "content-type": "application/json", "content-length": "16777217" },
      { "content-type": "application/json", "content-length": "-1" },
    ];
    for (const headers of cases) {
      const fake: typeof fetch = Object.assign(async () => new Response(JSON.stringify(snapshot), { headers }), { preconnect: fetch.preconnect });
      await expect(new SyncClient("https://example.com", token, fake).snapshot()).rejects.toMatchObject({ code: headers["content-length"] ? "response_too_large" : "invalid_response" });
    }
    const fake: typeof fetch = Object.assign(async () => new Response(JSON.stringify(snapshot), { headers: { "content-type": "Application/JSON; charset=utf-8" } }), { preconnect: fetch.preconnect });
    expect((await new SyncClient("https://example.com", token, fake).snapshot()).cursor).toBe(1);
  });
  test("uses server operation_reused and rejects undefined serialization as invalid request", async () => {
    const url = serve(() => Response.json({ error: { code: "operation_reused" } }, { status: 409 }));
    await expect(new SyncClient(url, token).snapshot()).rejects.toMatchObject({ code: "operation_reused" });
    const body = { toJSON: () => undefined } as unknown as Parameters<SyncClient["mutate"]>[0];
    await expect(new SyncClient(url, token).mutate(body)).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  });
  test("deadline cancels a response whose body never completes", async () => {
    const url = serve(() => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); controller.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } }));
    await expect(new SyncClient(url, token).snapshot()).rejects.toMatchObject({ code: "timeout" });
  }, 20_000);
  test("accepts server-legal nested values beyond the old depth limit", async () => {
    let value: Json = "leaf";
    for (let depth = 0; depth < 100; depth++) value = [value];
    const url = serve(() => Response.json({ ...snapshot, records: [{ ...record, value }] }));
    expect((await new SyncClient(url, token).snapshot()).records[0]!.value).toEqual(value);
  });
});
