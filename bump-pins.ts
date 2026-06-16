/**
 * Check upstream for newer commits and bump pins.json in place.
 *
 * For each pinned source, `git ls-remote` resolves the current commit of its
 * `ref` (peeling annotated tags). If it differs from the pinned commit, pins.json
 * is rewritten with the new commit; dataSnapshotDate is set to today (passed in
 * via --date, since CI provides the date — this script does no clock access of
 * its own so a re-run is deterministic given the same inputs).
 *
 * Prints `changed=true` / `changed=false` to stdout (consumed by the workflow to
 * decide whether to commit + trigger a release).
 *
 * Usage: bun run bump-pins.ts --date=YYYY-MM-DD
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const PINS = resolve(import.meta.dir, "pins.json")

interface PinEntry {
    repo: string
    ref: string
    commit: string
}
interface Pins {
    context1337: PinEntry
    aboutsecurity: PinEntry
    dataSnapshotDate: string
    dataDirs: string[]
    [k: string]: unknown
}

function resolveRemoteCommit(repo: string, ref: string): string {
    // ls-remote both the ref and its peeled form; prefer the peeled commit for
    // annotated tags. Output lines: "<sha>\t<refname>".
    const out = execFileSync("git", ["ls-remote", repo, ref, `${ref}^{}`], { encoding: "utf8" })
    const lines = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    if (lines.length === 0) throw new Error(`git ls-remote ${repo} ${ref} returned nothing`)
    const peeled = lines.find((l) => l.includes("^{}"))
    const chosen = peeled ?? lines[0]
    const sha = chosen.split(/\s+/)[0]
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve a commit sha for ${repo} ${ref}: got ${JSON.stringify(chosen)}`)
    return sha
}

function main(): void {
    const dateArg = process.argv.slice(2).find((a) => a.startsWith("--date="))
    if (!dateArg) throw new Error("--date=YYYY-MM-DD is required")
    const date = dateArg.slice("--date=".length)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid --date: ${date}`)

    const pins = JSON.parse(readFileSync(PINS, "utf8")) as Pins
    let changed = false
    for (const key of ["context1337", "aboutsecurity"] as const) {
        const entry = pins[key]
        const latest = resolveRemoteCommit(entry.repo, entry.ref)
        if (latest === entry.commit) {
            process.stderr.write(`[bump] ${key} ${entry.ref} up to date (${entry.commit.slice(0, 12)})\n`)
        } else {
            process.stderr.write(`[bump] ${key} ${entry.ref}: ${entry.commit.slice(0, 12)} -> ${latest.slice(0, 12)}\n`)
            entry.commit = latest
            changed = true
        }
    }
    if (changed) {
        pins.dataSnapshotDate = date
        writeFileSync(PINS, JSON.stringify(pins, null, 2) + "\n", "utf8")
        process.stderr.write(`[bump] pins.json updated; dataSnapshotDate=${date}\n`)
    }
    // machine-readable signal for the workflow
    process.stdout.write(`changed=${changed}\n`)
}

main()
