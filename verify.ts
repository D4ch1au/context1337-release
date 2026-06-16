/**
 * Post-build release gate. Boots the freshly built absec for the host platform,
 * checks /health, then performs a real MCP initialize + tools/list over the
 * Streamable HTTP transport. Exits non-zero on any failure so CI does NOT cut a
 * release from a binary that an upstream breaking change silently broke.
 *
 * Run on the CI runner (ubuntu = linux-amd64) after build.ts. It only verifies
 * the native platform's binary — the other cross-compiled targets share the same
 * source + data, so a green native run is a strong signal the build is sound.
 *
 * Usage: bun run verify.ts <platformKey>   (default linux-amd64)
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { createServer } from "node:net"

const ROOT = import.meta.dir
const platformKey = process.argv[2] ?? "linux-amd64"
const exe = platformKey.startsWith("win32") ? "absec.exe" : "absec"
const binary = resolve(ROOT, "dist", platformKey, "context1337", exe)
const dataDir = resolve(ROOT, "dist", platformKey, "context1337", "data")

const EXPECTED_TOOLS = ["search_security", "get_security_detail", "read_security_file"]

function fail(msg: string): never {
    console.error(`[verify] FAIL: ${msg}`)
    process.exit(1)
}

async function freePort(): Promise<number> {
    return new Promise((res, rej) => {
        const s = createServer()
        s.once("error", rej)
        s.listen(0, "127.0.0.1", () => {
            const a = s.address()
            s.close(() => res(a && typeof a === "object" ? a.port : 0))
        })
    })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
    if (!existsSync(binary)) fail(`binary not found: ${binary}`)
    if (!existsSync(join(dataDir, "builtin.db"))) fail(`builtin.db not found under ${dataDir}`)

    const port = await freePort()
    console.error(`[verify] launching absec on 127.0.0.1:${port}`)
    const proc = spawn(binary, ["serve", "--port", String(port), "--data-dir", dataDir], {
        stdio: ["ignore", "inherit", "inherit"],
    })
    let exited = false
    proc.on("exit", (code) => {
        exited = true
        if (code !== 0 && code !== null) console.error(`[verify] absec exited code=${code}`)
    })

    try {
        // health poll
        let healthy = false
        for (let i = 0; i < 60 && !exited; i++) {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
                if (r.ok && (await r.text()).trim() === "OK") {
                    healthy = true
                    break
                }
            } catch {
                /* not up yet */
            }
            await sleep(500)
        }
        if (!healthy) fail("absec did not pass /health within 30s")
        console.error("[verify] /health OK")

        // MCP initialize + tools/list over Streamable HTTP
        const mcpUrl = `http://127.0.0.1:${port}/mcp`
        const initBody = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } },
        }
        const initRes = await fetch(mcpUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
            body: JSON.stringify(initBody),
            signal: AbortSignal.timeout(8000),
        })
        if (!initRes.ok) fail(`MCP initialize HTTP ${initRes.status}`)
        const sessionId = initRes.headers.get("mcp-session-id") ?? undefined
        const initText = await initRes.text()
        if (!initText.includes("protocolVersion")) fail(`MCP initialize did not return a protocol response: ${initText.slice(0, 200)}`)
        console.error(`[verify] MCP initialize OK${sessionId ? ` (session ${sessionId})` : ""}`)

        const listHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        }
        if (sessionId) listHeaders["mcp-session-id"] = sessionId
        const listRes = await fetch(mcpUrl, {
            method: "POST",
            headers: listHeaders,
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
            signal: AbortSignal.timeout(8000),
        })
        if (!listRes.ok) fail(`MCP tools/list HTTP ${listRes.status}`)
        const listText = await listRes.text()
        const missing = EXPECTED_TOOLS.filter((t) => !listText.includes(t))
        if (missing.length > 0) fail(`MCP tools/list missing expected tools: ${missing.join(", ")}\nbody: ${listText.slice(0, 400)}`)
        console.error(`[verify] PASS — MCP tools/list contains ${EXPECTED_TOOLS.join(", ")}`)
    } finally {
        try {
            proc.kill("SIGTERM")
        } catch {
            /* already gone */
        }
    }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
