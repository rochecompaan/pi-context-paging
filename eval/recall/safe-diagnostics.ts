const codes = new Set(`
threshold overflow manual retry
attempt-active operation-active stream-active no-response-headers no-model-delta no-text-delta
non-monotonic-clock missing-operation-start missing-phase-boundary no-phase-observations same-phase-active-subtotal preparation-phase-boundary-missing
provider-usage-omitted provider-field-omitted provider-observation-incomplete invalid-provider-field conflicting-provider-observations foreign-provider-observation
cache-components-exceed-total-input native-codex-omitted-write-default-for-input-only missing-input-components reasoning-exceeds-output sdk-usage-mismatch
missing-total-operands unsafe-token-total missing-cache-fraction-operands zero-input
incomplete-aggregate incomplete-paired-operands non-comparable-executions non-finite-aggregate no-observations missing-execution-usage native-calculateCost
missing-applicable-components missing-applicable-usage missing-catalog-prices missing-or-invalid-catalog-price missing-priced-usage missing-request-wide-tier-input
missing-token-components missing-sdk-usage missing-request-join missing-observation missing-usage missing-field
native-optional-field-default-only unsupported-provider-mapping invalid-catalog-tiers invalid-sdk-usage
complete-applicable-components catalog-zero-cache-write-charge no-attributable-billing-source non-finite-cost-subtotal
pricing-evidence-changed pricing-metadata-changed conflicting-attempt-record conflicting-observation conflicting-sdk-usage
fork-abort-failed fork-artifact-write-failed fork-cleanup-failed fork-dispose-failed fork-ownership-failed fork-prompt-failed
fork-resource-cleanup-failed fork-restoration-failed fork-scoring-failed fork-setup-failed fork-timing-write-failed paging-replay-fidelity-failed
probe-answer-ambiguous probe-answer-visible probe-initial-payload-missing probe-owner-mismatch probe-payload-incomplete probe-sibling-content
probe-source-provenance-missing probe-source-visible baseline-source-visible
baseline-compacted-before-stage-A baseline-compacted-during-stage-A baseline-source-still-resident baseline-native-boundary-not-ready
candidate-evidence-incomplete insufficient-qualified-known-probes missing-trace-evidence no-successful-baseline-compaction paging-targets-not-excluded stage-not-completed
http-fetch-aborted http-fetch-failed native-stream-unsettled invalid-sse-json stream-aborted stream-buffer-limit stream-canceled stream-incomplete stream-reader-error
stream-without-terminal response-without-body provider-response-failed provider-response-incomplete request-owner-mismatch
stage-group-error resource-cleanup-error pair-error abort-error snapshot-error dispose-error extension-error prompt-error assistant-error assistant-aborted
compaction-error unjoined-recovery-result artifact-error source-error max-user-prompts max-requests-per-prompt max-requests-per-arm max-pair-minutes
native-history-match native-history-unchanged native-projection-unchanged target-idle target-fresh private-tape-present settings-match
checkpoint-history-match checkpoint-projection-match resident-configuration-match restoration-complete
`.trim().split(/\s+/));
/** Only harness-owned diagnostics may cross the host artifact boundary. */
export function safeDiagnostic(value: unknown): string | null {
	if (value === null) return null;
	return typeof value === "string" && (codes.has(value) || /^(?:(?:handler-present|handler-output-match|tool-present)-\d+|partial-\d+-of-\d+-components)$/.test(value))
		? value : "unclassified-diagnostic";
}
export function ownedDiagnostic(value: unknown): boolean { return typeof value === "string" && safeDiagnostic(value) === value; }
