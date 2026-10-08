import { createHash, randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionEvent } from "./pi-journal.ts";
import type { PagingReplayTape, RestorationEvidence } from "./paging-replay.ts";
import { copyPrivate } from "./paging-replay-input.ts";
import type { SessionOwner } from "./metrics.ts";

export type PrivateCheckpoint = Readonly<{ id: string }>;
export type CheckpointEvidence = {
	checkpointId: string;
	sourceSessionId: string;
	sourceLeafId: string | null;
	configurationFingerprint: string;
	inheritedPromptCount: number;
};
export type CheckpointRestoration = Omit<RestorationEvidence, "method"> & {
	method: RestorationEvidence["method"] | "baseline-native-history-v1";
};
export type CheckpointData = {
	owner: SessionOwner;
	entries: SessionEntry[];
	leafId: string | null;
	projection: ReturnType<AgentSession["sessionManager"]["buildSessionProjection"]>;
	configuration: { metadataFingerprint: string; model: AgentSession["model"]; cwd: string; thinkingLevel: string; systemPrompt: string;
		tools: { name: string; description: string; parameters: unknown }[]; autoCompactionEnabled: boolean };
	promptCount: number;
	provenance: [string, string][];
	compactions: CompactionEvent[];
	tape: PagingReplayTape | null;
};
type FrozenCheckpoint = { data: CheckpointData; digest: string; evidence: CheckpointEvidence };
const checkpoints = new WeakMap<PrivateCheckpoint, FrozenCheckpoint>();
const digest = (data: CheckpointData) => {
	const { tape: _tape, ...native } = data;
	return createHash("sha256").update(serialize(native)).digest("hex");
};
function resolve(checkpoint: PrivateCheckpoint): FrozenCheckpoint {
	const frozen = checkpoints.get(checkpoint);
	if (!frozen || digest(frozen.data) !== frozen.digest) throw new Error("Private checkpoint missing or mutated");
	return frozen;
}

/** Called only at the native adapter boundary after source eligibility checks. */
export function freezeCheckpoint(data: CheckpointData): PrivateCheckpoint {
	const { tape, ...native } = data;
	const copied = { ...copyPrivate(native), tape };
	const checkpoint = Object.freeze({ id: randomUUID(), toJSON() { throw new Error("Private checkpoint must not be serialized"); } });
	const configurationFingerprint = createHash("sha256").update(serialize(copied.configuration)).digest("hex");
	const evidence = { checkpointId: checkpoint.id, sourceSessionId: copied.owner.sessionId, sourceLeafId: copied.leafId,
		configurationFingerprint, inheritedPromptCount: copied.promptCount };
	checkpoints.set(checkpoint, { data: copied, digest: digest(copied), evidence });
	return checkpoint;
}

/** Fresh private native values for each fork; no report projection participates. */
export function restoreCheckpointData(checkpoint: PrivateCheckpoint): CheckpointData {
	const { data } = resolve(checkpoint);
	const { tape, ...native } = data;
	return { ...copyPrivate(native), tape };
}
export function checkpointDigest(checkpoint: PrivateCheckpoint): string { return resolve(checkpoint).digest; }
export function checkpointEvidence(checkpoint: PrivateCheckpoint): CheckpointEvidence { return copyPrivate(resolve(checkpoint).evidence); }
