/** Structural narrowing helpers for untrusted SessionEvent payloads. */

export function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = data?.[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}
