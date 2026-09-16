const directiveNamePattern = (name: string): RegExp =>
  new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${name}\\b`, "mu");

/**
 * Locates the offset of a macro name inside its `#define` directive.
 *
 * The symbol scanner masks preprocessor directives, so macro definitions
 * never appear in the indexed definitions or declarations. This lookup
 * runs against the raw source text instead and returns the offset of the
 * macro name within the first matching `#define` line.
 */
export function findMacroDefinitionOffset(
  source: string,
  name: string
): number | undefined {
  if (name.length === 0) {
    return undefined;
  }
  const match = directiveNamePattern(name).exec(source);
  if (match === null) {
    return undefined;
  }
  return (match.index ?? 0) + match[0].lastIndexOf(name);
}
