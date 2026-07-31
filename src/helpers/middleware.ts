export function formDataToObject(formData: FormData): Record<string, any> {
	return Object.fromEntries(
		Array.from(formData.entries()).map(([key, value]) => {
			if (typeof value === "string") {
				try {
					return [key, JSON.parse(value)];
				} catch {}
			}
			return [key, value];
		}),
	);
}
