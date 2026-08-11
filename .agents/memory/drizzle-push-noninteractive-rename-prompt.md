---
name: drizzle-kit push needs a real TTY for rename prompts
description: drizzle-kit push/push --force hangs or errors "Interactive prompts require a TTY" when a schema change both drops and adds a table/column in the same push; how to get past it non-interactively.
---

Running `drizzle-kit push` (even with `--force`) from a non-interactive shell fails with
`Error: Interactive prompts require a TTY terminal` whenever the schema diff is ambiguous
about a rename (e.g. one table dropped and a differently-named table added in the same
schema edit, or a column renamed). `--force` only auto-approves *data-loss* confirmations,
not this rename-resolution prompt -- there is no CLI flag to skip it.

**Why:** drizzle-kit renders the rename-resolution UI with an Ink-based prompt that requires
`process.stdin.isTTY`/`process.stdout.isTTY`, which ShellExec's non-interactive shell doesn't
provide. Plain `<<<` heredoc piping doesn't work either since the prompt needs a real pty, not
just piped stdin.

**How to apply:** wrap the command in a Python `pty.fork()` script (see
`.agents/memory/` git history or recreate: fork a pty, `os.execvp` the drizzle-kit command,
then poll the pty fd with `select` and print/relay output). This gives the process a real
TTY so the prompt renders and can be answered by writing bytes (e.g. `\r` for the default
"create new table" choice) to the fd. Plain `script -qc "..." /dev/null <<< "..."` was tried
first and just hung/timed out -- the pty-fork approach is what actually works.
