# Attachments

Last verified: 2026-09-13

## Overview

Attachments add structured context to a turn without presenting it as ordinary user prose. The system supports mentioned files and directories, images, large-PDF references, diagnostics, plan state, skill and agent listings, background-task notifications, relevant memories, and conditional rules.

## How it works

For `@`-mentioned files, the host creates synthetic FileRead tool-use and tool-result messages. Text uses the normal read formatter; images become multimodal message parts. Directories are represented as a synthetic listing. Large PDFs can be represented by metadata that instructs the model to read explicit page ranges.

Host-generated attachments such as diagnostics, plan state, task notifications, and memory are normalized through the system-reminder path. Collection is fault-isolated: a failing attachment producer logs a warning while other attachment types continue.

Chat images use claim-check storage. Bytes are written under the session upload directory, while transcripts retain `/sessions/<id>/uploads/<file>` references. Before a provider call, those references are hydrated back into bytes.

## API

`POST /sessions/:id/uploads` accepts multipart field `file`, repeated for up to five images. Each image may be PNG, JPEG, GIF, or WebP and may not exceed 10 MiB. The response is:

```json
{
  "session_id": "<id>",
  "urls": ["/sessions/<id>/uploads/<generated-name>.png"]
}
```

Inbound chat image arrays may contain base64 data URLs or upload URLs belonging to the same session. File mention behavior is derived from the turn input and current `cwd`; it has no separate settings block.

## Failure modes and security notes

- Empty uploads, unsupported MIME types, oversized files, and more than five images return errors.
- Existing upload references are rejected if they belong to another session or the backing file is missing.
- Generated filenames and download parsing use strict allowlists, and resolved paths must remain under the session upload directory.
- MIME selection uses the multipart type when it is an image and otherwise falls back to the original filename extension; this is type validation, not malware scanning.
- A file attachment can be truncated at the read limit; the model is instructed to use FileRead for additional content.

## Source map

- `src/utils/attachments/types.ts` — attachment variants.
- `src/utils/attachments.ts` — collection, isolation, and message creation.
- `src/utils/attachments/attachment-to-messages.ts` — model-message projection.
- `src/utils/attachments/generate-file-attachment.ts` — mentioned-file generation.
- `src/utils/chat-uploads.ts` — image claim-check storage and hydration.
- `src/server/routes/chat-uploads.ts` — multipart upload endpoint.
- `src/services/compact/post-compact-attachments.ts` — post-compaction restoration.
