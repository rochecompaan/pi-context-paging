# Consistent paging-tool exclusion

## Approved scope

The user approved excluding all four paging tools' calls and results from recovery output, preserving ordinary work in mixed turns, and making notices follow the same policy.

The four tools are `search_history`, `browse_history`, `load_history`, and `read_context_output`.

## Behavior

- Keep raw session storage and raw history items unchanged.
- Omit paging calls and their results from public recovery views. Check both stored call names and result names.
- Preserve ordinary calls/results and public assistant text in mixed turns.
- Omit turns containing only paging activity, including their accompanying assistant text.
- Preserve original assistant content indices with null slots for omitted blocks.
- Recompute mixed-turn tool, file, and failure metadata from the retained content. Preserve interrupted/restore failure status.
- Apply the same policy to search, browse, load, exact output reads, and navigation-cache visibility.
- Advertise history IDs and tool-result handles only when the recovery tools accept them.
- Keep raw eviction boundaries independent of recovery references. FIFO selection and frozen-notice reuse remain unchanged.
- If an unread oversized paging result requires emergency replacement, use a short explanation without an unreadable output handle. Preserve the live tool-call/result pairing.

## Implementation choices

Extend the existing recovery-content module with shared eligibility rules. Keep raw projection and cut lookup separate from public recovery. Derive notices from excluded eligible items; do not scan unrelated history or serialize large payloads to decide eligibility.

## Verification

Use failing behavior tests before production changes. Cover every paging tool, mixed turns, mismatched call/result names, original content indices, raw immutability, notice resolution and stability, emergency replacement, and live navigation refresh. Run the full project check, including type checking, tests, and packed-artifact verification.

## Deferred work

- `TODO-de471bd8`: bounded load responses and image handling. This needs a separate response-contract decision.
- `TODO-9a86a587`: structured nested-execution provenance for `codemode`. No blanket wrapper exclusion or script regex classification.

No dependency changes, release, publication, merge, or live-session mutation is part of this fix.
