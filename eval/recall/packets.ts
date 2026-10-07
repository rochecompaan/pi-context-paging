import { createHash } from "node:crypto";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

function incidentRecord(seed: string, packet: number, record: number): string {
	const digest = createHash("sha256").update(JSON.stringify([seed, packet, record])).digest("hex");
	const region = ["north", "south", "east", "west"][record % 4];
	const limit = 20 + Number.parseInt(digest.slice(0, 4), 16) % 180;
	const workers = 2 + Number.parseInt(digest.slice(4, 8), 16) % 14;
	const depth = limit + Number.parseInt(digest.slice(8, 12), 16) % 100;
	const delay = 10 + Number.parseInt(digest.slice(12, 16), 16) % 100;
	const scope = `Drift-${digest.slice(0, 16)}`;
	const time = new Date(Date.UTC(2026, 0, 1, packet, record)).toISOString();
	return `\n## Incident record ${packet}.${record}: ${scope}
Deployment context: regional queue ${region}, build queue-${digest.slice(16, 28)}.
The ${region} canary accepted ${limit} pending jobs before this sample; the control reached ${depth}.

Settings before deployment:
region=${region}; worker_count=${workers}; max_pending=0; admission_policy=unbounded
Settings after deployment:
region=${region}; worker_count=${workers}; max_pending=${limit}; admission_policy=reject_before_enqueue
Both deployments have the same worker count, storage pool, retry policy, and ingress route.

Source excerpt from service/queue-${record}.ts:
function admit${record}(request, queue, settings) {
  const pending = queue.pendingCount();
  if (settings.max_pending > 0 && pending >= settings.max_pending) {
    metrics.increment("admission_rejected", { region: "${region}" });
    return { accepted: false, retryAfterMs: ${delay} };
  }
  queue.push({ request, enqueuedAt: clock.now() });
  metrics.record("accepted_queue_depth", queue.pendingCount());
  return { accepted: true, retryAfterMs: 0 };
}
At ${scope}, ${depth - limit} offered jobs are beyond the admission limit; each rejection schedules a ${delay} ms retry.
The ${workers} workers consume admitted jobs independently of that retry delay.

Incident timeline (clock synchronized within the region):
${time} control pending=${depth} active=${workers} accepted=true
${time} canary pending=${depth} active=${workers} accepted=false retryAfterMs=${delay}
${time} storage connection count unchanged; worker completions continue normally
${time} ingress retry count rises while canary accepted queue depth stops growing
${time} client latency includes retry delay before admission and service time after admission

Operator observations for ${scope}:
Both arms keep ${workers} active workers, but the canary limit is ${limit} jobs and the observed offered backlog is ${depth}.
The next sample should distinguish the ${depth - limit} excess offers from accepted work in region ${region}.
The ${delay} ms retry interval can move arrival timestamps without changing worker service time.
Check whether record ${packet}.${record} supports storage pressure or an admission-policy explanation.
`;
}

export function renderWorkPacket(seed: string, index: number): { text: string; estimatedTokens: number } {
	const task = [
		"Compare the causal explanations for admission rejection and storage saturation. Cite three records and identify a missing measurement.",
		"Explain the configuration difference between canary and control. Cite three records and separate queue depth from offered load.",
		"Update the incident timeline. Cite three records and explain how retries affect the interpretation of latency.",
	][index % 3];
	let text = `Incident investigation work packet ${index}.\n${task}\nGive a concise analysis of this packet; do not repeat unrelated earlier checkpoint values.\n\nCommon method: compare a bounded canary queue with an unbounded control. Rejected work retries before storage access; queue-depth graphs omit it. Worker count, storage pool, and ingress route stay equal within each record. Clock timestamps are synchronized within each region.\n`;
	let estimatedTokens = estimateTokens({ role: "user", content: text, timestamp: 0 });
	for (let record = 0; estimatedTokens < 8_000; record++) {
		text += incidentRecord(seed, index, record);
		estimatedTokens = estimateTokens({ role: "user", content: text, timestamp: 0 });
	}
	if (estimatedTokens > 12_000) throw new Error("Work packet exceeds the estimated token range");
	return { text, estimatedTokens };
}
