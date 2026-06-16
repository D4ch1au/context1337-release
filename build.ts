/**
 * Build context1337 (the wgpsec AboutSecurity knowledge MCP, binary name `absec`)
 * for release distribution.
 *
 * Recipe (mirrors upstream build/Dockerfile):
 *   1. clone context1337 + AboutSecurity at the pinned commits (pins.json)
 *   2. apply the loopback-binding security patch (default 127.0.0.1, not 0.0.0.0)
 *   3. python venv + `pip install jieba pyyaml` + build_index.py -> builtin.db (FTS5)
 *   4. `CGO_ENABLED=0 GOOS/GOARCH go build` absec per platform (pure-Go sqlite, so
 *      one runner cross-compiles every target with no C toolchain)
 *   5. assemble dist/<platformKey>/context1337/{absec[.exe], data/{builtin.db,
 *      skills, Dic, Payload, Vuln}} — data/runtime is NEVER included (it is an
 *      absec runtime artifact, regenerated on first launch)
 *
 * Usage:
 *   bun run build.ts                 # all release platforms
 *   bun run build.ts --only=linux-amd64,win32-amd64
 *   bun run build.ts --zip           # also produce dist/context1337-<platform>.zip
 *   bun run build.ts --refresh       # re-clone even if the work tree exists
 *
 * Requires go (>= the version in the upstream go.mod), python3, git, and network
 * to GitHub / PyPI / the Go module proxy. In CI these are provided by the runner.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import pins from "./pins.json" with { type: "json" }

const ROOT = import.meta.dir
const WORK = resolve(ROOT, ".build-work")
const CTX_DIR = join(WORK, "ctx")
const ABOUTSEC_DIR = join(WORK, "aboutsec")
const VENV_DIR = join(WORK, "venv")
const DB_PATH = join(WORK, "builtin.db")
const DIST = resolve(ROOT, "dist")

interface PlatformSpec {
    goos: string
    goarch: string
    exe: string
}

const PLATFORMS: Record<string, PlatformSpec> = {
    "win32-amd64": { goos: "windows", goarch: "amd64", exe: "absec.exe" },
    "linux-amd64": { goos: "linux", goarch: "amd64", exe: "absec" },
    "linux-arm64": { goos: "linux", goarch: "arm64", exe: "absec" },
    "darwin-amd64": { goos: "darwin", goarch: "amd64", exe: "absec" },
    "darwin-arm64": { goos: "darwin", goarch: "arm64", exe: "absec" },
}

function venvPython(): string {
    return process.platform === "win32" ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python")
}

function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): void {
    execFileSync(cmd, args, { cwd: cwd ?? ROOT, stdio: "inherit", env: env ?? process.env })
}

/** Shallow-fetch an exact commit (reproducible pin). GitHub allows fetch-by-SHA. */
function cloneAtCommit(repo: string, commit: string, dir: string, refresh: boolean): void {
    if (refresh && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (existsSync(join(dir, ".git"))) {
        process.stderr.write(`[context1337] reusing existing clone ${dir}\n`)
        return
    }
    mkdirSync(dir, { recursive: true })
    run("git", ["-C", dir, "init", "-q"])
    run("git", ["-C", dir, "remote", "add", "origin", repo])
    run("git", ["-C", dir, "fetch", "--depth", "1", "origin", commit])
    run("git", ["-C", dir, "checkout", "-q", "FETCH_HEAD"])
}

/**
 * Loopback-binding security patch. Upstream absec hardcodes
 * `http.ListenAndServe(":port")`, binding 0.0.0.0 on every interface. A daemon
 * that launches absec automatically would expose the knowledge MCP on the LAN
 * by default. This patch adds a `--host` flag (default 127.0.0.1) and threads it
 * into the listen address. Idempotent + fail-closed (throws if an anchor is gone,
 * e.g. after an upstream commit bump — that is the signal to re-review the patch).
 */
function patchLoopbackBinding(): void {
    const mainGo = join(CTX_DIR, "cmd", "absec", "main.go")
    let src = readFileSync(mainGo, "utf8").replace(/\r\n/g, "\n")
    if (src.includes('fmt.Sprintf("%s:%d", host, cfg.Port)')) {
        process.stderr.write("[context1337] loopback patch already applied; skipping\n")
        return
    }
    const anchors: Array<[string, string]> = [
        ["\tvar port int\n\tvar dataDir string\n", "\tvar port int\n\tvar host string\n\tvar dataDir string\n"],
        ['\t\t\taddr := fmt.Sprintf(":%d", cfg.Port)', '\t\t\taddr := fmt.Sprintf("%s:%d", host, cfg.Port)'],
        [
            '\tcmd.Flags().IntVar(&port, "port", 1337, "HTTP listen port")\n',
            '\tcmd.Flags().IntVar(&port, "port", 1337, "HTTP listen port")\n\tcmd.Flags().StringVar(&host, "host", "127.0.0.1", "HTTP listen host (loopback default; set 0.0.0.0 to expose on LAN)")\n',
        ],
    ]
    for (const [oldStr, newStr] of anchors) {
        if (!src.includes(oldStr)) {
            throw new Error(`[context1337] loopback patch anchor missing (upstream changed?): ${JSON.stringify(oldStr.slice(0, 48))}`)
        }
        src = src.replace(oldStr, newStr)
    }
    writeFileSync(mainGo, src, "utf8")
    process.stderr.write("[context1337] applied loopback-binding security patch (cmd/absec/main.go)\n")
}

function buildIndex(): void {
    if (!existsSync(VENV_DIR)) run("python3", ["-m", "venv", VENV_DIR])
    const py = venvPython()
    run(py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "jieba", "pyyaml"])
    run(py, ["build/build_index.py", "--input", `${ABOUTSEC_DIR}/`, "--dict", "build/security_dict.txt", "--output", DB_PATH], CTX_DIR)
}

function buildAndAssemble(platformKey: string): string {
    const spec = PLATFORMS[platformKey]
    if (!spec) throw new Error(`unknown platformKey ${platformKey} (expected one of ${Object.keys(PLATFORMS).join(", ")})`)
    const outDir = join(DIST, platformKey, "context1337")
    const dataDir = join(outDir, "data")
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    process.stderr.write(`[context1337] building absec for ${platformKey} (${spec.goos}/${spec.goarch})\n`)
    run("go", ["build", "-ldflags=-s -w", "-o", join(outDir, spec.exe), "./cmd/absec/"], CTX_DIR, {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: spec.goos,
        GOARCH: spec.goarch,
    })
    copyFileSync(DB_PATH, join(dataDir, "builtin.db"))
    for (const d of pins.dataDirs) {
        const src = join(ABOUTSEC_DIR, d)
        if (!existsSync(src)) throw new Error(`AboutSecurity data dir missing: ${src}`)
        cpSync(src, join(dataDir, d), { recursive: true })
    }
    process.stderr.write(`[context1337] assembled ${outDir}\n`)
    return outDir
}

function zipPlatform(platformKey: string): void {
    const platformDir = join(DIST, platformKey)
    const zipPath = join(DIST, `context1337-${platformKey}.zip`)
    rmSync(zipPath, { force: true })
    // The zip root is the `context1337/` dir so consumers unpack it directly into
    // their tools dir. Use the platform's native zipper: PowerShell on Windows,
    // `zip` elsewhere (present on the ubuntu CI runner).
    if (process.platform === "win32") {
        run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${join(platformDir, "context1337")}' -DestinationPath '${zipPath}' -Force`])
    } else {
        run("zip", ["-r", "-q", zipPath, "context1337"], platformDir)
    }
    process.stderr.write(`[context1337] zipped ${zipPath}\n`)
}

function main(): void {
    const args = process.argv.slice(2)
    const refresh = args.includes("--refresh")
    const doZip = args.includes("--zip")
    const onlyArg = args.find((a) => a.startsWith("--only="))
    const targets = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : Object.keys(PLATFORMS)

    cloneAtCommit(pins.context1337.repo, pins.context1337.commit, CTX_DIR, refresh)
    cloneAtCommit(pins.aboutsecurity.repo, pins.aboutsecurity.commit, ABOUTSEC_DIR, refresh)
    patchLoopbackBinding()
    buildIndex()
    for (const platformKey of targets) {
        buildAndAssemble(platformKey)
        if (doZip) zipPlatform(platformKey)
    }
    process.stderr.write(`[context1337] done: ${targets.join(", ")}\n`)
}

main()
