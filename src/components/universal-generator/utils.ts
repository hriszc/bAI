import type { VariableGroup, PromptCombination, AiBlock } from "./types";

export function extractAiBlocks(template: string): AiBlock[] {
  const regex = /(?:\{\*(.+?)\*\}|｛\*(.+?)\*｝)/g;
  const blocks: AiBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const raw = match[0];
    const description = (match[1] ?? match[2] ?? "").trim();
    if (description) {
      blocks.push({ raw, description });
    }
  }
  return blocks;
}

export function replaceAiBlock(template: string, raw: string, values: string[]): string {
  return template.replace(raw, `{{${values.join(", ")}}}`);
}

function splitVariableValues(raw: string): string[] {
  return raw
    .replace(/[，、；;|\n\r]+/g, ",")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function extractVariableGroups(template: string): VariableGroup[] {
  const regex = /\{\{(.*?)\}\}/g;
  const groups: VariableGroup[] = [];
  let idx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const raw = match[1].trim();
    const values = splitVariableValues(raw);
    groups.push({ id: `var_${idx++}`, values });
  }
  return groups;
}

export function syncVariableGroupsFromTemplate(
  template: string,
  previousGroups: VariableGroup[],
): VariableGroup[] {
  const extracted = extractVariableGroups(template);
  return extracted.map((group, idx) => ({
    id: previousGroups[idx]?.id ?? `var_${idx}`,
    values: group.values,
  }));
}

export function serializeVariableGroupsIntoTemplate(
  template: string,
  groups: VariableGroup[],
): string {
  let groupIdx = 0;
  return template.replace(/\{\{.*?\}\}/g, (placeholder) => {
    const group = groups[groupIdx++];
    if (!group) return placeholder;

    const values = group.values.map((value) => value.trim()).filter(Boolean);
    return `{{${values.join(", ")}}}`;
  });
}

export function computeCombinations(groups: VariableGroup[]): Record<string, string>[] {
  const valueGroups = groups.map((g) => g.values.map((v) => v.trim()).filter(Boolean));
  if (valueGroups.length === 0 || valueGroups.some((values) => values.length === 0)) return [];

  let combinations: Record<string, string>[] = valueGroups[0].map((v) => ({
    [`var_0`]: v,
  }));

  for (let i = 1; i < valueGroups.length; i++) {
    const newCombos: Record<string, string>[] = [];
    for (const combo of combinations) {
      for (const value of valueGroups[i]) {
        newCombos.push({ ...combo, [`var_${i}`]: value });
      }
    }
    combinations = newCombos;
  }

  return combinations;
}

export function interpolatePrompt(template: string, variables: Record<string, string>): string {
  const groups = extractVariableGroups(template);
  let result = template;
  groups.forEach((group, idx) => {
    const value = variables[`var_${idx}`];
    if (value) {
      result = result.replace(/\{\{.*?\}\}/, value);
    }
  });
  return result;
}

export function computePromptCombinations(
  template: string,
  groups: VariableGroup[],
): PromptCombination[] {
  const combinations = computeCombinations(groups);
  if (combinations.length === 0) {
    if (groups.length === 0 && template.trim()) {
      return [{ variables: {}, prompt: template.trim() }];
    }
    return [];
  }
  return combinations.map((vars) => ({
    variables: vars,
    prompt: interpolatePrompt(template, vars),
  }));
}

export function getCombinationCount(groups: VariableGroup[]): number {
  if (groups.length === 0) return 0;
  return groups.reduce((acc, g) => {
    if (acc === 0) return 0;
    const filledCount = g.values.filter((value) => value.trim()).length;
    return filledCount === 0 ? 0 : acc * filledCount;
  }, 1);
}
