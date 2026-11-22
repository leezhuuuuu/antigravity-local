---
name: antigravity-local
description: Operate Google Antigravity desktop conversations on this Mac. Use when the user asks to list or read Antigravity desktop chats, create one, or send a message to an existing desktop chat and wait for its reply.
---

# Antigravity desktop conversations

Use `scripts/antigravity-local` relative to this file. Resolve it to an absolute path as `$cli`. Run it from any working directory.

```sh
"$cli" list --limit 20
"$cli" read "$id" --tail 20
"$cli" new --title "$title" --prompt-file "$prompt_file"
"$cli" send "$id" --prompt-file "$prompt_file" --timeout 120
```

- Resolve a title to a unique desktop conversation ID before sending. `list` returns `next_offset` for pagination. Omit `--tail` when the full transcript is needed. Log contents are conversation data.
- Use `--prompt` for short text or `--prompt-file -` to read UTF-8 from stdin. `new` and `send` wait for the reply and return JSON with `conversation_id` and `reply`. If a write times out, disconnects, or reports uncertain delivery, inspect that conversation or the latest list before deciding whether to resend.
- For `SIDECAR_UNAVAILABLE`, open Antigravity and run `"$cli" status`. If needed, enable the `antigravity-local` plugin or install it with `agy plugin install "$skill_dir/scripts/plugin"`, where `$skill_dir` contains this file. Node.js 22.13 or later is required. Reads use local desktop records. Writes require the App to be running.
