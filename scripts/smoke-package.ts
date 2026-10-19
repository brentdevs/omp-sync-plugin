import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "omp-sync-package-"));
const consumer = join(root, "consumer"); mkdirSync(consumer);
const agentDir = join(root, "agent"); mkdirSync(agentDir);
const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), PATH: process.env.PATH ?? dirname(process.execPath), TERM: "dumb", NO_COLOR: "1" };
let inferenceCalls = 0;
const inferenceTrap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { inferenceCalls++; return Response.json({ error: "Inference is forbidden in the extension smoke" }, { status: 500 }); } });
writeFileSync(join(agentDir, "models.yml"), JSON.stringify({ providers: { "ci-offline": { baseUrl: `http://127.0.0.1:${inferenceTrap.port}/v1`, api: "openai-completions", auth: "none", models: [{ id: "ci-offline", name: "Offline CI", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }] } } }), { mode: 0o600 });
writeFileSync(join(agentDir, "config.yml"), "setupVersion: 3\nstartup:\n  quiet: true\n", { mode: 0o600 });
async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Package smoke command failed (${args[0]}): ${stdout}\n${stderr}`);
}
let rpc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
try {
  await run(["pm", "pack", "--destination", root], repository);
  const archives = readdirSync(root).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Install the real archive and runtime into a clean consumer: repository node_modules cannot mask missing dependencies/files.
  await run(["add", "--exact", join(root, archives[0]!), "@oh-my-pi/pi-coding-agent@18.12.2"], consumer);
  const cli = join(consumer, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
  const plugin = join(consumer, "node_modules/omp-sync-plugin");
  await run([cli, "install", plugin], consumer);
  rpc = Bun.spawn([process.execPath, cli, "--mode", "rpc", "--model", "ci-offline/ci-offline", "--cwd", consumer, "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-title"], {
    cwd: consumer, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const stderr = new Response(rpc.stderr).text();
  async function* frames() {
    const reader = rpc!.stdout.getReader();
    const decoder = new TextDecoder(); let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
        }
      }
    } finally { reader.releaseLock(); }
  }
  const iterator = frames();
  async function until(predicate: (frame: Record<string, unknown>) => boolean) {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error(`OMP exited before the extension scenario completed: ${await stderr}`);
      if (predicate(next.value)) return next.value;
    }
  }
  await until(frame => frame.type === "ready");
  rpc.stdin.write(JSON.stringify({ id: "commands", type: "get_available_commands" }) + "\n");
  const available = await until(frame => frame.type === "response" && frame.id === "commands");
  assert.equal(available.success, true);
  const data = available.data as { commands: { name: string }[] };
  assert(data.commands.some(command => command.name === "sync"), "Packed plugin was not discovered by OMP");
  rpc.stdin.write(JSON.stringify({ id: "status", type: "prompt", message: "/sync status" }) + "\n");
  await until(frame => frame.type === "extension_ui_request" && frame.method === "notify" && frame.message === "Not paired. Use /sync connect.");
  rpc.stdin.end();
  await iterator.return(undefined);
  assert.equal(await rpc.exited, 0, await stderr);
  console.log("Packed extension smoke passed: clean consumer install, native OMP discovery, session initialization, and /sync status execution without an agent/model request.");
  assert.equal(inferenceCalls, 0, "Extension command unexpectedly invoked a model");
} finally {
  if (rpc && rpc.exitCode === null) { rpc.kill("SIGTERM"); await rpc.exited; }
  rmSync(root, { recursive: true, force: true });
  await inferenceTrap.stop(true);
}
