import type { RequestEvidence } from "../../eval/recall/codex-payload.ts";

export function evidenceFixture(overrides: Partial<RequestEvidence> = {}): RequestEvidence {
	return {
		requestId: "r0", promptId: "probe-A-id", arm: "paging", purpose: "conversation",
		complete: true, blocks: [], opaque: { count: 0, hashes: [] }, ...overrides,
	};
}
