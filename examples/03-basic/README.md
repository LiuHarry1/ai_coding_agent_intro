# 03-basic — 02-basic + Bash Subagent + Explore (placeholder)

**02-basic** plus:

- **Bash subagent**: Main agent has `run_bash_task`, not a direct `bash` tool. Shell runs in an isolated Bash subagent; main agent gets a short result or a path to `.agent-cache/` for long output.
- **Explore subagent**: Placeholder for future (see `subagents/explore.js`).

No truncate/summary — plain 02-basic loop + session + subagents.

## Structure

```
03-basic/
  agent.js           # Same loop as 02-basic; tools include run_bash_task
  prompts.js
  server.js          # Session + createTools(cwd, { runBashSubagent })
  session.js
  tools.js
  tools/
    index.js         # read_file, write_file, edit_file, run_bash_task
    read_file.js, write_file.js, edit_file.js, bash.js, utils.js
  subagents/
    bash.js          # runBashSubagent(task, cwd, sendSSE)
    explore.js       # Placeholder
```

## Run

```bash
node start.js 03-basic
```
