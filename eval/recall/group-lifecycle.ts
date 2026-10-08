import type { ArmFactoryOptions } from "./fork.ts";
import type { ArmSnapshot, Clock, EvalArm } from "./pi-arm.ts";
import type { SessionOwner } from "./metrics.ts";
import type { RequestGuard } from "./request-guard.ts";
import { operationOwner, type TaskRecorder } from "./task-metrics.ts";

export type GroupError = { code: string; arm?: SessionOwner["arm"]; promptId?: string | null };

/** A deadline stops dispatch, but the lifetime remains open until late setup/work settles. */
export function createGroupLifecycle(options: {
	clock: Clock; deadlineMs: number; guard: RequestGuard; recorder: TaskRecorder; errors: GroupError[];
	createArm(options: ArmFactoryOptions): Promise<EvalArm>; cleanupSession(owner: SessionOwner): Promise<void>;
}) {
	const instances = new Map<string, { owner: SessionOwner; arm: EvalArm }>(), owners = new Map<string, SessionOwner>();
	const actions = new Set<Promise<unknown>>(), cleaned = new Set<string>();
	let closed = false, expire!: () => void, cleanupComplete = true;
	const expired = new Promise<never>((_, reject) => { expire = () => reject(new Error("Stage deadline")); });
	// The rejection also has an observer when no model action is currently awaited.
	expired.catch(() => {});
	function track<T>(pending: Promise<T>): Promise<T> {
		actions.add(pending); pending.then(() => actions.delete(pending), () => actions.delete(pending)); return pending;
	}
	function abortAll() {
		for (const { arm } of instances.values()) track(arm.abort().catch(() => { options.errors.push({ code: "abort-error" }); cleanupComplete = false; }));
	}
	const timer = options.clock.setTimeout(() => { closed = true; options.guard.stop("max-pair-minutes"); expire(); abortAll(); }, options.deadlineMs);
	async function cleanup(owner: SessionOwner): Promise<void> {
		instances.delete(owner.sessionId);
		if (cleaned.has(owner.sessionId)) return;
		cleaned.add(owner.sessionId);
		try { await options.cleanupSession(owner); }
		catch (error) { cleanupComplete = false; options.errors.push({ code: "resource-cleanup-error", arm: owner.arm }); throw error; }
	}
	return {
		wait: <T>(pending: Promise<T>): Promise<T> => Promise.race([track(pending), expired]),
		async create(input: ArmFactoryOptions): Promise<EvalArm> {
			options.guard.check(); owners.set(input.owner.sessionId, input.owner);
			return track(options.createArm(input).then(async arm => {
				instances.set(input.owner.sessionId, { owner: input.owner, arm });
				if (closed) { try { await arm.abort(); } catch { options.errors.push({ code: "abort-error", arm: input.arm }); } }
				return arm;
			}));
		},
		cleanup,
		async finish(sourceOwners: readonly SessionOwner[], snapshot: (owner: SessionOwner, value: ArmSnapshot) => void) {
			closed = true; options.clock.clearTimeout(timer); abortAll();
			while (actions.size) await Promise.allSettled([...actions]);
			for (const owner of owners.values()) {
				if (cleaned.has(owner.sessionId)) continue;
				const phase = options.recorder.begin("cleanup", operationOwner(owner));
				let failed = false;
				const instance = instances.get(owner.sessionId)?.arm;
				try { await instance?.abort(); } catch { failed = true; options.errors.push({ code: "abort-error", arm: owner.arm }); }
				if (instance && sourceOwners.some(source => source.sessionId === owner.sessionId)) {
					try { snapshot(owner, instance.snapshot()); } catch { failed = true; options.errors.push({ code: "snapshot-error", arm: owner.arm }); }
				}
				try { instance?.dispose(); } catch { failed = true; options.errors.push({ code: "dispose-error", arm: owner.arm }); }
				try { await cleanup(owner); } catch { failed = true; }
				options.recorder.end(phase, failed ? "failed" : "succeeded"); cleanupComplete &&= !failed;
			}
			return { complete: cleanupComplete };
		},
	};
}
