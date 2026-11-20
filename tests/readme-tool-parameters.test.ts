import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The README is the human-facing contract for the recovery tools: the schema descriptions reach the model at runtime,
 * but a person deciding what to type reads this file. Three `browse_history` parameters (`sequence`, `direction`,
 * `stride`) and the search filter `failed` were described by behaviour and never named, so a reader could not use the
 * directions the tool's own summary advertises. This check names every schema parameter, so a parameter added to a
 * schema cannot ship undocumented while the prose around it keeps growing.
 *
 * A parameter counts as documented when the README uses its name as a backticked token, on its own (`stride`) or with
 * a value (`load: true`) — the section's own convention. Prose that paraphrases the parameter does not count, because
 * that is exactly what hid the gap.
 */
const repo = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(repo, relative), "utf8");

function schemaParameters(source: string): Array<{ name: string; keys: string[] }> {
	const schemas: Array<{ name: string; keys: string[] }> = [];
	for (const match of source.matchAll(/const (\w+Parameters) = strictObject\(\{/g)) {
		const open = (match.index ?? 0) + match[0].length - 1;
		let depth = 0;
		let end = open;
		for (let index = open; index < source.length; index += 1) {
			if (source[index] === "{") depth += 1;
			else if (source[index] === "}") {
				depth -= 1;
				if (depth === 0) { end = index; break; }
			}
		}
		// Top-level properties are the single-tab lines; nested property objects are deeper.
		const keys = [...source.slice(open, end).matchAll(/^\t(\w+):/gm)].map((key) => key[1]);
		assert.ok(keys.length > 0, `${match[1]} exposes no parameters, which the README cannot document`);
		schemas.push({ name: match[1], keys });
	}
	return schemas;
}

test("every tool parameter is named in the README", () => {
	const readme = read("README.md");
	const schemas = schemaParameters(read("src/tools.ts"));
	assert.equal(schemas.length, 4, "the four history tools must each declare a parameter schema");
	for (const schema of schemas) {
		const undocumented = schema.keys.filter(
			(key) => !new RegExp("`" + key + "(?=`|:| )").test(readme),
		);
		assert.deepEqual(
			undocumented,
			[],
			`${schema.name} ships parameters the README never names: ${undocumented.join(", ")}`,
		);
	}
});

test("the README names each tool the code registers", () => {
	const readme = read("README.md");
	const tools = [...read("src/tools.ts").matchAll(/name: "(\w+)"/g)].map((match) => match[1]).sort();
	assert.deepEqual(tools, ["browse_history", "load_history", "read_context_output", "search_history"]);
	for (const tool of tools) {
		assert.ok(readme.includes("`" + tool + "`"), `${tool} must be named in the README`);
	}
});
