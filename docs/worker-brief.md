# Worker brief — how the coder profile hands work to OpenCode

Hermes orchestrates. The `coder` profile plans and verifies. **OpenCode implements.**
The coder profile must not write implementation files itself; it delegates them.

## Invocation (Windows — this exact form, no variations)

```bash
cd "C:/Users/rishu/WebstormProjects/Ultimate_frre_ai" && env -u PWD \
  "/c/Users/rishu/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe" \
  run '<BRIEF>' --format json --model opencode/deepseek-v4.1-flash-free \
  > artifacts/opencode-<task>.jsonl 2>&1
echo "OPENCODE_EXIT=$?"
```

Non-negotiable parts, each of which has already cost a failed run:

| Part | Why |
|---|---|
| `env -u PWD` | git-bash exports `PWD=/c/Users/...`; the native binary cannot `chdir` there and fails with *"Failed to change directory"*. This is not an auth error |
| direct `.exe` path | the npm shim re-execs with the MSYS `PWD` still set, so `env -u PWD` on the shim does nothing |
| `cd "C:/..."` native path | never pass a `/c/...` workdir to the native binary |
| `--model opencode/deepseek-v4.1-flash-free` | the free tier provided by OpenCode itself |
| redirect to `artifacts/` | gitignored; keeps the JSONL for evidence |

**Never `--auto`.** It blanket-approves every permission — the opposite of a scoped run.
Permissions come from the repo's `opencode.json` (broad allow, specific deny last;
OpenCode v2 is last-match-wins).

## The brief skeleton

```
Objective: <one sentence>
Repo: C:/Users/rishu/WebstormProjects/Ultimate_frre_ai
Read first: AGENTS.md, docs/api.md, docs/block-0N-plan.md
Files allowed: <explicit list>
Files forbidden: .env, docs/, PROJECT.md, AGENTS.md, package-lock.json
Constraints: <invariants from AGENTS.md that this task could break>
Acceptance: npm run verify exits 0 AND <the block's name-pattern test>
Do not commit, push, or deploy.
```

Keep it short and point at files on disk rather than pasting long specs — the agent reads them.

## Verification — the coder profile's remaining job

OpenCode's own summary is a claim, never evidence. After every run:

1. `git status --porcelain` — every changed file must be inside *files allowed*.
2. Read the JSONL and count `write`/`edit` tool calls; confirm none hit a forbidden path.
3. Run `npm run verify` and the block's name-pattern test **yourself**; record real exit codes.
4. Check the pre-existing test count did not drop — a deleted or skipped test is a failed run.
5. Report `SUCCESS` only when 1-4 all pass. Otherwise report `FAILED` naming the failing check.

## Known-good reference

A run that worked: `opencode run '<brief>' --format json` producted 29 events
(14 `read`, 2 `shell`, 0 writes) before being killed mid-read — proving the invocation
form is correct and that OpenCode front-loads reading, which is normal and not a hang.

## Before delegating a change to a shared interface

Run `codegraph impact <symbol>` first and put the affected-symbol count in the OpenCode
brief. `ProviderAdapter` currently touches ~92 symbols; a change that leaks beyond one adapter
file means the interface is wrong, not the task. Use `codegraph callers <symbol>` to confirm
what actually consumes a module rather than grepping for a name.
