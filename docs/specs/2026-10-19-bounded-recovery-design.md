# Bounded recovery replies

## Approved scope

Text recovery replies have a hard limit of 16 KiB (16,384 UTF-8 bytes) for the complete serialized tool result. This includes `content`, `details`, metadata, escaping, and continuation fields. An inline content part has a limit of 4 KiB (4,096 serialized UTF-8 bytes). Small public history items can keep their existing shape when they fit both limits.

Large items return short part descriptions and read handles instead of their full bodies. Every deferred item has a working part-list route. A large item must not prevent smaller requested items from returning. Raw history remains unchanged.

Images appear as metadata in text recovery. The model can use a metadata handle to request one native Pi image attachment. The image is not serialized as ordinary text or copied into `details`. The 16 KiB text budget applies to the image response's text and metadata, not its native attachment. At most one image is returned per explicit request; normal provider image limits still apply. This fix does not add original-file export, resizing, cropping, or an image store.

Query-focused excerpts, a database, new user settings, dependency changes, and changes to context selection are outside this fix.

## Public tool contract

Keep the four existing tool names and existing read selectors.

- `load_history` keeps requested item order. A small item is unchanged. A deferred item contains `id`, `kind`, `deferred: true`, a bounded `parts` list, `totalParts`, `nextPartOffset`, and a `readParts` handle. If a small item cannot fit the shared reply budget, it also becomes deferred.
- `search_history(load:true)` keeps every search reference and the existing three-item maximum. `unloadedHistoryIds` still identifies matches beyond those three. Within the three requested items, `deferred` marks content not loaded in full. Oversized reference metadata can become a minimal `{ historyId, detailsDeferred: true }` reference; its ID remains loadable.
- `search_history` and `browse_history` obey the same complete reply budget. Oversized reference metadata is explicitly deferred rather than causing an unbounded reply or dropping IDs.
- Extend `read_context_output` with `part` (a JSON Pointer into the public recovery item) and `mode` (`text`, `parts`, or `image`; default `text`). Existing `source: assistant|toolResult`, `contentIndex`, and `toolCallId` selectors continue to work. `part` and legacy selectors cannot be combined.
- `mode: parts` lists public parts for one history item, with part-index `offset` and `nextOffset`. It accepts no content selector. The list itself is byte-bounded and can require repeated reads.
- `mode: text` returns an exact serialized public part range. Keep the existing maximum requested page size of 2,000 UTF-16 code units. A page may be shorter to fit the byte budget. Offsets always address the same serialized public representation, and `nextOffset` advances by the actual returned length. Do not split surrogate pairs.
- `mode: image` requires a `part` handle selecting a public image block. It returns one native image content block plus bounded metadata. Text is never accepted as an image, and image mode rejects text-page offsets and limits.

A part description includes its JSON Pointer, type, byte size, short preview where useful, and exact `read_context_output` arguments. List message content blocks individually; expose model-turn metadata and tool-result details as separate parts when present. Assistant indices retain null slots. User strings have a direct part. JSON Pointer traversal accepts only own properties of the public projection, with correct `~0` and `~1` decoding.

## Safety and fidelity

Apply `recoveryHistoryItem` before listing, selecting, or returning any part. Thinking, provider signatures, paging calls and results, and paging-only turns remain unavailable. Handles cannot bypass these exclusions.

Known image blocks become metadata in text serialization, including legacy aggregate tool-result reads. Their handles retrieve native attachments. Text-only parts retain their existing exact JSON serialization. Image-containing containers use an explicitly image-safe representation rather than embedding base64; the stored original never changes.

The final reply builder measures UTF-8 bytes after JSON serialization and rejects an oversized reply before returning it. `details` contains only the bounded public payload. Reserve room for all item IDs and continuation handles before adding inline content or part descriptions.

## Verification

Regression tests must prove full-result byte bounds for large text, escaped text, Unicode, large arguments and details, multiple requested items, large metadata, and many parts. Follow returned handles and cursors to recover exact user text and tool arguments. Reconstruct paged text without gaps or duplicates. Prove images are absent from text and details, yet available through explicit native attachments for user and tool-result images. Recheck private and paging exclusions on the new routes and verify raw history is unchanged.

Run focused recovery tests, TypeScript checking, the complete existing test suite, and the packed-artifact smoke check. Documentation uses direct review and package verification, not tests of prose.
