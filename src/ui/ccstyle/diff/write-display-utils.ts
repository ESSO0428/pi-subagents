export function splitWriteContentLines(content: string): string[] {
	if (!content) {
		return [];
	}

	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}
