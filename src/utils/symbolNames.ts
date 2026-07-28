const sourceFilePattern = /(?:^|[\\/])[^\\/]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp)(?::\d+)?$/iu;

export function shortSymbolName(displayName: string): string {
  const trimmed = displayName.trim();
  const operatorIndex = trimmed.lastIndexOf("operator");
  if (operatorIndex >= 0) {
    const operatorName = trimmed.slice(operatorIndex);
    if (operatorName.startsWith("operator()")) {
      return "operator()";
    }
    if (operatorName.startsWith("operator[]")) {
      return "operator[]";
    }
    const parameters = operatorName.indexOf("(");
    return (parameters < 0 ? operatorName : operatorName.slice(0, parameters))
      .replace(/\s+(?:const|volatile|noexcept)\s*$/u, "")
      .trim();
  }

  const beforeParameters = trimmed.includes("(")
    ? trimmed.slice(0, trimmed.indexOf("(")).trim()
    : trimmed;
  const scopedName = beforeParameters.split("::").at(-1)?.trim() ?? beforeParameters;
  const tokens = scopedName.split(/\s+/u);
  return tokens.at(-1) ?? scopedName;
}

export function symbolNameMatches(displayName: string, lookupName: string): boolean {
  return displayName === lookupName || shortSymbolName(displayName) === lookupName;
}

export function fullCallableName(name: string, detail?: string): string {
  const cleanName = name.trim();
  const cleanDetail = detail?.trim();
  if (cleanDetail === undefined || cleanDetail.length === 0 || sourceFilePattern.test(cleanDetail)) {
    return cleanName;
  }
  if (cleanDetail.includes(cleanName)) {
    return cleanDetail;
  }
  if (cleanDetail.startsWith("(")) {
    return `${cleanName}${cleanDetail}`;
  }
  return `${cleanName} — ${cleanDetail}`;
}

export function mostDetailedSymbolName(
  ...candidates: ReadonlyArray<string | undefined>
): string {
  const available = candidates
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  return available.sort((left, right) => {
    const structuralScore = (value: string): number =>
      value.length +
      (value.includes("::") ? 40 : 0) +
      (value.includes("(") ? 25 : 0);
    return structuralScore(right) - structuralScore(left);
  })[0] ?? "";
}
