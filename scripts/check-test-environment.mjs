#!/usr/bin/env node
// Fails fast, with a reason, when the temporary filesystem has no room for what the test suite writes.
//
// Why this exists — measured twice in this repository's own work:
// - tests/eval-recall.output-location.test.ts reported 15 failures while `df` showed /tmp at 80 % (6.1 GiB free on a
//   31 GiB tmpfs). Nothing in that output mentions space: the cases are about output-path containment, so the report
//   reads as a product regression in the rig's path validation. The same file, with no code change, is 5 pass / 0 fail
//   once the directory was pruned to 70 % (9.5 GiB free).
// - The host-compat gate dies inside the host's extension loader with `Unknown system error -122` (a write failure)
//   under the same pressure: the host transpiles extensions when it loads them, and the gate installs a whole Pi
//   release into a temporary workspace (one host workspace measured 571 MB).
// Both cleared by freeing space. The suite's own report is silent about the cause, so this names the condition before
// a dozen tests start dying for a reason the report does not state.
//
// Scope, stated honestly: free bytes is what this can measure. The 15-failure run above happened at 6.1 GiB free, so
// on that tmpfs the real limit was a quota, not free space, and no free-bytes floor sees a quota, an inode ceiling, or
// a per-user limit. The floor below therefore catches the ordinary full-filesystem case without blocking developers
// whose filesystem has room; the value of this script is the message — symptom mapped to cause — as much as the gate.
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";

const MINIMUM_FREE_BYTES = 1024 ** 3;
const target = process.env.TMPDIR || tmpdir();

let stats;
try {
	stats = statfsSync(target);
} catch {
	process.exit(0); // Cannot measure the filesystem: do not block the suite on a guess.
}

const freeBytes = stats.bsize * stats.bavail;
if (freeBytes >= MINIMUM_FREE_BYTES) process.exit(0);

const mib = Math.max(0, Math.round(freeBytes / 1024 ** 2));
console.error(`The temporary filesystem at ${target} has ${mib} MiB free; the test suite needs at least ${Math.round(MINIMUM_FREE_BYTES / 1024 ** 3)} GiB of room.`);
console.error("The suite writes fixture git checkouts here, and `npm run check:package` / `npm run check:host` unpack a packed"
	+ " artifact and a whole Pi release under this directory (one host workspace measured 571 MB).");
console.error("When it is full the failures do not look like space: eval-recall.output-location.test.ts reports failing"
	+ " output-path cases, and `npm run check:host` reports `Unknown system error -122` from the host's extension loader.");
console.error("Free space, or point TMPDIR at a filesystem with room (`npm run check:host -- --dir <path>` places the host"
	+ " workspace specifically). Quotas, inode limits and per-user tmpfs caps are not visible to this check.");
process.exit(1);
