# Smart Memory – SillyTavern Extension

Intelligent memory system with per-message summarization, structured tagging, and retrieval-augmented context injection for RP scenarios.

## Features

- **Per-message summarization** via a secondary API (OpenAI-compatible)
- **Structured tagging** – keywords, emotions, RP categories (promise, daily, event, relationship, secret, preference, lore)
- **Importance scoring** – 1-10 scale, automatically assigned by the summarizer
- **Time-based decay** – memories fade over time unless pinned or accessed (configurable)
- **Keyword-based retrieval** with fuzzy matching (Fuse.js)
- **Automatic context injection** – relevant memories are injected before each generation
- **Save slots** – branch and manage multiple memory timelines (IF lines)
- **Import/Export** – back up or share memory sets as JSON

## Installation

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste this repository's URL and click Install

Or manually:
1. Copy the `smart-memory` folder into `SillyTavern/public/scripts/extensions/third-party/`
2. Restart SillyTavern

## Setup

1. Open the **Extensions** panel (stacked cubes icon)
2. Find **Smart Memory** and expand it
3. Enter your secondary API URL, key, and model name
4. Click **Test Connection** to verify
5. Enable auto-summarization and start chatting

## Architecture

```
smart-memory/
├── manifest.json      # Plugin metadata
├── index.js           # Main entry, events, interceptor
├── api.js             # Secondary API communication
├── summarizer.js      # Summarization + tag generation
├── memory-entry.js    # Data model with decay/importance
├── memory-store.js    # Storage engine with save slots
├── retriever.js       # Retrieval engine (keyword/fuse/vector)
├── settings.html      # Settings panel UI
└── style.css          # Styles
```

## Future Roadmap

- [ ] Vector embedding retrieval (cosine similarity)
- [ ] Hybrid retrieval (keyword + vector)
- [ ] Emotion-based memory filtering
- [ ] Category-based memory filtering
- [ ] Memory consolidation (merge similar memories)
- [ ] Visual memory timeline

## License

AGPLv3
