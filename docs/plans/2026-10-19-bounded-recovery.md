# Bounded Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound text recovery replies while preserving exact part reads and explicit native image attachments.

**Architecture:** A pure part module projects and selects public content, with image-safe text serialization. A small reply module owns serialized byte limits. A load module reserves deferred handles before packing content; the existing tools and page reader use these modules without changing stored history.

**Tech Stack:** TypeScript, Node.js built-in tests, existing Pi extension interfaces and TypeBox schemas. No dependency changes.

**Spec:** `docs/specs/2026-10-19-bounded-recovery-design.md`

## Global Constraints

- Complete text tool results: at most 16,384 serialized UTF-8 bytes, including `content` and `details`.
- Inline content parts: at most 4,096 serialized UTF-8 bytes.
- Keep four public tool names, current selector compatibility, three loaded items, and 2,000 requested page code units.
- Preserve raw history and private/paging exclusions; keep original assistant indices.
- Native images require explicit metadata handles, one attachment per call, and no base64 in text or `details`.
- No original-file export, resizing, cropping, query excerpts, new settings, dependencies, or provider calls.
- Sole writer in `.worktrees/fix-bounded-recovery`; do not merge, push, publish, or change `main`.

## Review Focus

- Escaped Unicode can exceed a character-based budget; test complete serialized reply bytes and cursor reconstruction.
- A huge first item can starve a later small item; test mixed requested sizes in requested order.
- Large metadata or hundreds of blocks can overflow the part list; test reference fallback and continuation through every part.
- Image data can leak through aggregate reads or details; test both routes and explicit image attachment recovery.
- New part selection can bypass exclusions or traverse prototypes; test omitted slots, paging results, invalid pointers, and own-property traversal.

## File structure

- Create `src/recovery-parts.ts`: public item lookup, stable part selection/descriptions, image-safe JSON.
- Create `src/recovery-response.ts`: text reply serialization and byte accounting.
- Create `src/recovery-loads.ts`: bounded reference and item packing, paged manifests.
- Modify `src/output-pages.ts`: compatible selectors, public part reads, byte-aware exact pages.
- Modify `src/navigator.ts`: skip native image bytes in search text and reference previews.
- Modify `src/tools.ts`: schema additions, bounded reply wiring, explicit image attachment branch.
- Create focused tests for parts and bounded recovery; update the obsolete unbounded-load expectation in `tests/tools.test.ts`.
- Update recovery guidance in `README.md` and `docs/architecture.md`.

### Task 1: Public parts and image-safe serialization

**Files:** Create `src/recovery-parts.ts` and `tests/recovery-parts.test.ts`.

**Interfaces:** Produce `publicHistoryItem(items, historyId)`, `historyParts(item)`, `selectHistoryPart(item, pointer)`, and `serializeRecoveryPart(item, pointer)`. All consume or return public recovery items; `historyParts` returns values with their stable pointers internally and bounded descriptions externally. Image descriptions contain `{ historyId, part, mode: "image" }` handles.

- [x] Write failing tests: user string selection; exact tool arguments; original assistant indices; image-safe serialization with an attachment handle; escaped pointer keys; prototype and hidden-block rejection; unchanged raw history.
- [x] Run `node --test --experimental-strip-types tests/recovery-parts.test.ts`. Expected: new behavior fails because the module is missing.
- [x] Implement the narrow pure module behind those functions. Filter first, select second. Never clone image data into text metadata.
- [x] Run the same command. Expected: all part tests pass.

### Task 2: Bounded tool replies and native attachments

**Files:** Create `src/recovery-response.ts`, `src/recovery-loads.ts`, and `tests/bounded-recovery.test.ts`; modify `src/output-pages.ts`, `src/tools.ts`, `src/navigator.ts`, and `tests/tools.test.ts`.

**Interfaces:** Consume Task 1's public item and part functions. Produce `recoveryResponse(payload)`, `fitsRecoveryResponse(payload)`, `boundedHistoryReply(items, references?)`, and `historyPartsPage(item, offset, limit)`; constants are 16,384 and 4,096 bytes. Preserve `readContextOutput(items, input): ContextOutputPage`, extending `input` with `part` and using the shared final reply measurement to fit text pages. `tools.ts` handles parts and native image modes separately.

- [x] Write failing tool-level tests using the real navigator and registered tools. Assert `Buffer.byteLength(JSON.stringify(reply), "utf8") <= 16_384` for huge text, Unicode/escaping, large arguments/details, multiple items, and large reference metadata.
- [x] Test exact recovery through returned user/argument handles; pagination through many part descriptions; explicit user and tool-result image attachments; no image data in text/details/legacy reads; rejection of image requests for hidden/paging blocks and non-images.
- [x] Replace the old test that expects unlimited exact loads with explicit deferred-reference and retrieval assertions. Keep existing small-item and selector behavior tests.
- [x] Run `node --test --experimental-strip-types tests/bounded-recovery.test.ts tests/tools.test.ts tests/output-pages.test.ts tests/public-history.test.ts tests/recovery-exclusion.test.ts`. Expected: new bounds, selectors, and image behavior fail on the old tools.
- [x] Implement full-result byte accounting, reserve references and deferred handles, pack full small items only when they fit, and fill part descriptions within the remaining budget. Return manifest continuations whenever descriptions do not fit.
- [x] Extend page selection without changing text-only legacy output. Shrink pages by serialized reply bytes and preserve surrogate pairs and exact cursors.
- [x] Add the explicit one-image branch with bounded metadata and native image content, never copying image data into details.
- [x] Run the focused command and `npm run typecheck`. Expected: all pass.

### Task 3: Documentation and completion evidence

**Files:** Modify `README.md`, `docs/architecture.md`, and `scripts/smoke-packed-artifact.mjs`; update this plan's execution ledger.

**Interfaces:** Document only the implemented tool inputs, deferred-item shape, text/image distinction, and continuations.

- [x] Update recovery examples and remove claims that every load returns a full atomic item. Explain that only text recovery uses the 16 KiB cap and images require explicit attachment reads.
- [x] Run `npm run check`. Expected: typecheck, complete suite, and packed-artifact smoke check pass. Keep raw test output outside conversation and report counts and failures only.
- [x] Run `git diff --check` and review the full diff against the spec and Review Focus. Expected: no whitespace errors, no unbounded text/details, all handles usable, no storage mutation or private/paging bypass.
- [x] Record outcomes and any remaining limitations in the ledger and todo. Do not claim an independent review without an authorized reviewer launch.
- [x] Commit the verified work on the feature branch after loading the commit skill; leave integration to the user.

## Execution record

- Focused baseline: TypeScript check and existing recovery tests passed before implementation.
- Task 1: seven public-part tests passed. Red runs caught missing part support, application-owned null handling, and direct image-field reads.
- Task 2: the first tool-level red run had 13 failures, including unbounded replies and missing user read routes. The focused suite then passed 77 tests. Follow-up red runs caught a part-list handle that restarted at zero and an application-owned `type` field that blocked continuation. Both regressions now pass.
- Final `npm run check`: 539 tests passed, zero failed, TypeScript passed, and the packed artifact registered all four history tools in a temporary Home directory. Full output: `/tmp/bounded-recovery-final-check.log`.
- The first full check exposed the smoke script's explicit package file list. Added the three new modules, ran `node --check scripts/smoke-packed-artifact.mjs`, and repeated the package check and complete check successfully. No new test asserts static file-list values or documentation text.
- Reviewed changed routes, byte accounting, cursors, public filters, image handling, raw-history preservation, and the complete staged file list. No independent reviewer was launched because delegation was not authorized.
- No provider calls, dependency updates, original-file export, resizing, cropping, push, publication, or integration into `main` occurred. The work remains on `fix/bounded-recovery` for the user's integration choice.
