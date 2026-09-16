# pi-notify

A pi extension that runs shell commands when pi **finishes** or **asks you something**, so you can wire your own notifier (`notify_send`, `mpv`, `ntfy`, a terminal bell) and walk away from the machine.

Observer-only with respect to events: it never blocks a tool call, never returns a block decision, never mutates event input, and never invents placeholders or environment variables for your commands. Its one effect beyond running your commands is a tracking marker it exports into the pi process, so subagent sessions can tell they are not the main agent (see [Subagents](#subagents)).

## What the two hooks mean

| Hook | Fires when | Subscribed event |
| --- | --- | --- |
| `on_agent_finish` | pi has **actually settled** — idle, nothing queued, no auto-retry or auto-compact still pending. Never the intermediate `agent_end`. | `agent_settled`, and only while `ctx.isIdle()` is true |
| `on_ask_user` | pi is **waiting on you** — once per native prompt (`select`, `confirm`, `input`, `editor`, `custom`), and at call-start for every tool call whose exact name is in `extra_ask_user_tool`. | `ui_prompt_start` (the host's coalesced outer waiting span, so nested/overlapping prompts notify once) and `tool_call` |

`on_agent_finish` still fires in non-interactive mode; the ask paths are inert there (see [Non-interactive mode](#non-interactive-mode)).

## Config

Read once, on the first session identified as the main agent (see [Subagents](#subagents)), from `~/.pi/pi-notify.json` (`$HOME`, or `%USERPROFILE%` on Windows, joined with `.pi/pi-notify.json`). Never written, never watched, never hot-reloaded. A missing file means all three arrays are empty and pi-notify is a silent no-op.

Three arrays, all optional, strings only:

### `on_agent_finish` and `on_ask_user` — shell command lists

Each entry is one shell string, run through `sh -c`, in array order, fire-and-forget:

- Inherits your environment and cwd unchanged, so `notify_send`, `mpv` and `ntfy` resolve from the same `PATH` pi already had.
- Real shell strings: pipes, `$(...)`, `>>`, quoting and `&&` all work as written.
- **No interpolation**: no `{title}` / `{message}` / `{toolName}` placeholders. The only variable pi-notify adds is its own `PI_NOTIFY_MAIN_AGENT_PID` marker, which is already in the host environment before your commands run.
- stdout/stderr are ignored; no timeout, no kill, no wait, no reaping. A slow or hung notifier can never stall pi.
- Duplicate entries run once per slot. Blank or whitespace-only entries are skipped silently.
- A spawn-level failure (missing `sh`, `EACCES`, bad cwd) warns with the command and the error; a non-zero exit or signal from your notifier is never observed.

### `extra_ask_user_tool` — tool names

Exact tool identifiers, matched as **exact, case-sensitive, whole-string set membership**: `ask_user_question` matches; `Ask_User_Question` and `ask-user-question` do not. Duplicate entries do not multiply fires. The ask notification fires at call-start, before the tool executes, one notification per ask.

### Overlap

A coincident ask and finish fire **both** hooks, ask first: each event enqueues its commands when observed, and one global FIFO spawns them in that order. Neither hook suppresses the other.

## Example config

Copy-paste into `~/.pi/pi-notify.json`:

```json
{
  "on_agent_finish": ["notify_send 'pi finished'", "mpv ~/alert.mp3"],
  "on_ask_user": ["notify_send 'pi needs your answer'", "ntfy publish pi 'input needed'"],
  "extra_ask_user_tool": ["ask_user_question"]
}
```

Any field you leave out defaults to `[]`, so you can configure only the hook you care about today.

## Fail-loud config contract

A present-but-invalid config throws when the first main-agent session starts, naming the file and the reason; pi continues without pi-notify. It never half-works, and there is no warn-and-default fallback or coercion. After that one failure pi-notify stays inert instead of re-throwing on every event, and subagent sessions never read the file at all, so a broken config is silent there. Rejected:

- invalid JSON (a trailing comma is reported as such);
- a top-level value that is not an object (array root, scalar root);
- a present field that is not an array (`"on_agent_finish": "notify_send"` is caught, not coerced);
- an array entry that is not a string;
- an unknown top-level key — `on_agent_finishh` fails loudly instead of silently never firing.

## Non-interactive mode

In `--print` / `--mode json` (`ctx.hasUI === false`):

- `on_agent_finish` **still fires**, because `agent_settled` still happens.
- The ask paths are **inert**: native prompts do not occur, and an ask tool such as rpiv's `ask_user_question` is stripped from the active tool list when there is no UI, so no `tool_call` occurs.

This is expected degradation, not a bug. pi-notify never polls or works around it.

## Subagents

pi-notify notifies only from the **main agent**: a session you launch, fork, clone, resume or reload. A **subagent** is a session an agent creates to work on its behalf — in the same process or in a child process — and pi-notify stays fully inert in one. Two signals decide:

- **Process ancestry.** At load, pi-notify exports `PI_NOTIFY_MAIN_AGENT_PID` holding its own pid. A pi process spawned from that session inherits a marker naming a foreign, *live* pid and stays inert before reading the config or subscribing. A marker naming this process means the process already claimed a main agent — `/new`, `/resume`, `/fork` and `/reload` re-invoke the extension in the same process. A marker naming a **dead** pid means the intermediary that set it (a tmux server, a daemon) is gone, so the process claims the main agent again and overwrites the marker. Liveness is `process.kill(pid, 0)`: `ESRCH` means gone; any other error, including an unsupported probe on Windows or Bun, means the session stays inert.
- **Session lifecycle.** In-process Subagents share the marker's pid, so the session a claiming process is first bound to is the main agent, a later `session_start` with reason `reload` / `new` / `resume` / `fork` is one too, and any later `startup` is a Subagent. A `session_start` never observed means the session is treated as the main agent, as does any session the gate cannot classify.

Detection is best-effort and fail-loud: a session that nothing identifies as a subagent notifies. There is no config key or override flag to re-enable notifications inside a subagent — the marker is the only switch, and it is an implementation detail rather than a stable API. To un-silence one nested process, unset it for that command:

```sh
env -u PI_NOTIFY_MAIN_AGENT_PID pi -p 'work I want a bell for'
```

Known limits: a pid recycled by an unrelated process can keep a stale marker looking alive and silence a session; a subagent that outlives its main agent starts notifying. `docs/adr/0001-subagent-detection.md` records the trade-offs.

## Load it

- Quick test: `pi -e /path/to/pi-notify/src/index.ts`
- Auto-discovery: place it under `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local, once the project is trusted).

## Development

- `npm test` — the fast suite (fake-host seam: config validation, event mapping, runner semantics).
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test:smoke` — the opt-in real-pi gate. It boots genuine pi (`--mode json`) with pi-notify loaded via `-e`, a temp `HOME` and a temp `~/.pi/pi-notify.json`, runs a trivial prompt, and asserts the `on_agent_finish` marker file was written by a real `agent_settled` event. It also asserts that the exported `PI_NOTIFY_MAIN_AGENT_PID` reaches a command pi spawns and equals pi's pid, and that a second run inheriting a live marker still reaches `agent_settled` while writing no marker file. It is slow and depends on your host, model and credentials, so it is excluded from `npm test`.

  Overridable via environment: `PI_NOTIFY_SMOKE_PI_BIN` (default `pi`), `PI_NOTIFY_SMOKE_PROVIDER` / `PI_NOTIFY_SMOKE_MODEL` (default: your pi defaults), `PI_NOTIFY_SMOKE_TIMEOUT_MS` (default 240000). It never reads or writes your real `~/.pi/pi-notify.json`.
