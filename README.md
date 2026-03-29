# pi-session-summary

A pi extension that shows a one-line LLM-generated session summary below the editor.

## Features

- **Trigger**: `agent_end` event, debounced (default: every 120 seconds)
- **Model**: Configurable, defaults to `anthropic/claude-haiku-4-5` with `maxTokens: 300`
- **Note**: `openai-codex` does NOT work for standalone calls (requires workspace context)
- **Hybrid display**: Shows `[compaction summary | last LLM summary] + N new turns since` between updates
- **Incremental updates**: Asks LLM to update previous summary only if material progress occurred
- **Full re-summarize**: Every ~10k tokens of new conversation, re-summarizes from scratch
- **Compact input**: Includes user+assistant text, skips tool I/O (shows only `[tool call: edit]` / `[tool result: 423 bytes]`)
- **Persistence**: Saves summary on shutdown, restores on session start/switch
- **Non-blocking**: LLM call runs asynchronously in background

## Install

```bash
pi install /path/to/pi-session-summary
```

Or add to `settings.json`:

```json
{
  "packages": ["/path/to/pi-session-summary"]
}
```

## Configuration

Edit the constants at the top of `index.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `SUMMARY_PROVIDER` | `"anthropic"` | Model provider |
| `SUMMARY_MODEL_ID` | `"claude-haiku-4-5"` | Model ID |
| `DEBOUNCE_SECONDS` | `120` | Min seconds between LLM calls |
| `MAX_TOKENS` | `300` | Max tokens for LLM response |
| `RESUMMARIZE_TOKEN_THRESHOLD` | `10000` | Token threshold for full re-summarize |
