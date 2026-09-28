import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function toolsetProbe(pi: ExtensionAPI): void {
  pi.registerCommand("write-toolset-probe", {
    description: "Write registered and active tools for package verification",
    handler: async () => {
      const output = process.env.PI_TOOLSET_PROBE_OUTPUT;
      if (!output) throw new Error("PI_TOOLSET_PROBE_OUTPUT is required");

      writeFileSync(
        output,
        JSON.stringify({
          all: pi.getAllTools().map((tool) => tool.name).sort(),
          active: pi.getActiveTools().sort(),
        }),
      );
    },
  });
}
