const defaultExcludedDirectories = [
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",
  "**/node_modules/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
  "**/.cache/**",
  "**/vendor/**",
  "**/third_party/**"
];

export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

export function buildExtensionGlob(extensions: readonly string[]): string {
  const normalized = [...new Set(extensions.map(normalizeExtension).filter(Boolean))];
  if (normalized.length === 0) {
    return "**/*";
  }
  const suffixes = normalized.map((extension) => extension.slice(1));
  return suffixes.length === 1 ? `**/*.${suffixes[0]}` : `**/*.{${suffixes.join(",")}}`;
}

export function buildExcludeGlob(...configured: ReadonlyArray<Record<string, boolean> | undefined>): string {
  const patterns = new Set(defaultExcludedDirectories);
  for (const values of configured) {
    for (const [pattern, enabled] of Object.entries(values ?? {})) {
      if (enabled) {
        patterns.add(pattern);
      }
    }
  }
  return `{${[...patterns].join(",")}}`;
}
