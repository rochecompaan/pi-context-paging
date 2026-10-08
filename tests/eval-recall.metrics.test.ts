import assert from "node:assert/strict";
import test from "node:test";
import { sameOwner, type SessionOwner } from "../eval/recall/metrics.ts";
import { ownerFixture } from "./fixtures/eval-recall.ts";

test("legacy and malformed owners cannot join request or recovery evidence", () => {
	for (const invalid of [{ arm: "paging" }, { ...ownerFixture(), runId: "" }, { ...ownerFixture(), stage: "C" },
		{ ...ownerFixture(), checkpointId: "checkpoint", forkId: null }]) {
		const value = invalid as SessionOwner;
		assert.equal(sameOwner(value, value), false);
	}
	const own = ownerFixture("paging", { checkpointId: "checkpoint", forkId: "fork" });
	assert.equal(sameOwner(own, structuredClone(own)), true);
	for (const key of ["runId", "stage", "seed", "arm", "sessionId", "checkpointId", "forkId"] as const) {
		const foreign = { ...own, [key]: key === "stage" ? "B" : key === "arm" ? "baseline" : `other-${key}` } as SessionOwner;
		assert.equal(sameOwner(own, foreign), false, key);
	}
});
