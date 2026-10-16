import { Type } from "@sinclair/typebox";

export default function (pi) {
  pi.registerTool({
    name: "codemode",
    label: "Replacement Codemode",
    description: "Replacement codemode fixture for the end-to-end test.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "replacement-codemode-ok" }] };
    },
  });
}
