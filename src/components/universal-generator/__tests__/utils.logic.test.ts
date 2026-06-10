import { describe, it, expect } from "vitest";

import type { VariableGroup } from "../types";
import {
  extractAiBlocks,
  replaceAiBlock,
  extractVariableGroups,
  syncVariableGroupsFromTemplate,
  serializeVariableGroupsIntoTemplate,
  computeCombinations,
  interpolatePrompt,
  computePromptCombinations,
  getCombinationCount,
} from "../utils";

// ============================================================
// extractVariableGroups
// ============================================================
describe("extractVariableGroups", () => {
  it("returns empty array for empty string", () => {
    expect(extractVariableGroups("")).toEqual([]);
  });

  it("returns empty array for string with no variables", () => {
    expect(extractVariableGroups("A beautiful landscape")).toEqual([]);
  });

  it("extracts a single variable", () => {
    expect(extractVariableGroups("{{cat}}")).toEqual([{ id: "var_0", values: ["cat"] }]);
  });

  it("extracts multiple values in one group", () => {
    expect(extractVariableGroups("{{cat, dog, bird}}")).toEqual([
      { id: "var_0", values: ["cat", "dog", "bird"] },
    ]);
  });

  it("extracts multiple groups", () => {
    expect(extractVariableGroups("A {{cat, dog}} in {{forest, beach}}")).toEqual([
      { id: "var_0", values: ["cat", "dog"] },
      { id: "var_1", values: ["forest", "beach"] },
    ]);
  });

  it("trims whitespace around values", () => {
    expect(extractVariableGroups("{{  cat ,  dog  }}")).toEqual([
      { id: "var_0", values: ["cat", "dog"] },
    ]);
  });

  it("keeps empty groups so the editor can round-trip them", () => {
    const result = extractVariableGroups("before {{}} after");
    expect(result).toEqual([{ id: "var_0", values: [] }]);
  });

  it("handles whitespace-only group", () => {
    // The group is extracted but values are empty after filtering whitespace
    const result = extractVariableGroups("{{ ,  }}");
    expect(result).toEqual([{ id: "var_0", values: [] }]);
  });

  it("handles adjacent variables", () => {
    expect(extractVariableGroups("{{a}}{{b}}{{c}}")).toEqual([
      { id: "var_0", values: ["a"] },
      { id: "var_1", values: ["b"] },
      { id: "var_2", values: ["c"] },
    ]);
  });

  it("handles special characters in values", () => {
    expect(extractVariableGroups("{{hello world, foo-bar, a.b.c}}")).toEqual([
      { id: "var_0", values: ["hello world", "foo-bar", "a.b.c"] },
    ]);
  });

  it("handles Chinese characters", () => {
    expect(extractVariableGroups("一只{{猫, 狗}}在{{森林, 海滩}}")).toEqual([
      { id: "var_0", values: ["猫", "狗"] },
      { id: "var_1", values: ["森林", "海滩"] },
    ]);
  });

  it("treats Chinese commas as variable separators", () => {
    expect(extractVariableGroups("一只{{猫，狗, 鸟}}在{{森林， 海滩}}")).toEqual([
      { id: "var_0", values: ["猫", "狗", "鸟"] },
      { id: "var_1", values: ["森林", "海滩"] },
    ]);
  });

  it("treats Chinese punctuation as variable separators", () => {
    expect(extractVariableGroups("cos{{小火苗、水蓝蓝、草之精灵，呱呱}}")).toEqual([
      { id: "var_0", values: ["小火苗", "水蓝蓝", "草之精灵", "呱呱"] },
    ]);
  });

  it("handles template with text before and after variables", () => {
    expect(extractVariableGroups("A {{red, blue}} car in {{day, night}} time")).toEqual([
      { id: "var_0", values: ["red", "blue"] },
      { id: "var_1", values: ["day", "night"] },
    ]);
  });

  it("increments group IDs sequentially", () => {
    const result = extractVariableGroups("{{a, b}} and {{c, d}} and {{e, f}}");
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("var_0");
    expect(result[1].id).toBe("var_1");
    expect(result[2].id).toBe("var_2");
  });

  it("handles single value group", () => {
    expect(extractVariableGroups("{{solo}}")).toEqual([{ id: "var_0", values: ["solo"] }]);
  });

  it("handles template with only variables and no surrounding text", () => {
    expect(extractVariableGroups("{{a, b}}")).toEqual([{ id: "var_0", values: ["a", "b"] }]);
  });
});

describe("variable group template sync", () => {
  it("preserves group ids but refreshes values from prompt edits", () => {
    const result = syncVariableGroupsFromTemplate("A {{lion, tiger}} in {{city}}", [
      { id: "custom-a", values: ["cat", "dog"] },
      { id: "custom-b", values: ["forest", "beach"] },
    ]);

    expect(result).toEqual([
      { id: "custom-a", values: ["lion", "tiger"] },
      { id: "custom-b", values: ["city"] },
    ]);
  });

  it("serializes edited variable values back into the prompt", () => {
    const result = serializeVariableGroupsIntoTemplate("A {{cat, dog}} in {{forest, beach}}", [
      { id: "var_0", values: ["lion", "tiger"] },
      { id: "var_1", values: ["city"] },
    ]);

    expect(result).toBe("A {{lion, tiger}} in {{city}}");
  });
});

// ============================================================
// computeCombinations
// ============================================================
describe("computeCombinations", () => {
  it("returns empty array for empty groups", () => {
    expect(computeCombinations([])).toEqual([]);
  });

  it("returns empty array when all groups have empty values", () => {
    expect(computeCombinations([{ id: "v0", values: [] }])).toEqual([]);
  });

  it("returns combinations for single group", () => {
    const groups: VariableGroup[] = [{ id: "var_0", values: ["a", "b", "c"] }];
    expect(computeCombinations(groups)).toEqual([{ var_0: "a" }, { var_0: "b" }, { var_0: "c" }]);
  });

  it("computes Cartesian product of two groups", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["cat", "dog"] },
      { id: "var_1", values: ["forest", "beach"] },
    ];
    expect(computeCombinations(groups)).toEqual([
      { var_0: "cat", var_1: "forest" },
      { var_0: "cat", var_1: "beach" },
      { var_0: "dog", var_1: "forest" },
      { var_0: "dog", var_1: "beach" },
    ]);
  });

  it("computes product with uneven group sizes", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["a"] },
      { id: "var_1", values: ["1", "2", "3"] },
    ];
    expect(computeCombinations(groups)).toEqual([
      { var_0: "a", var_1: "1" },
      { var_0: "a", var_1: "2" },
      { var_0: "a", var_1: "3" },
    ]);
  });

  it("computes product of three groups", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["red", "blue"] },
      { id: "var_1", values: ["car", "bike"] },
      { id: "var_2", values: ["day", "night"] },
    ];
    const result = computeCombinations(groups);
    expect(result).toHaveLength(2 * 2 * 2); // 8
  });

  it("returns empty array when any group has no filled values", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["a"] },
      { id: "var_1", values: [] },
      { id: "var_2", values: ["b"] },
    ];
    expect(computeCombinations(groups)).toEqual([]);
  });

  it("ignores blank values inside otherwise filled groups", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["a", ""] },
      { id: "var_1", values: ["x"] },
    ];
    expect(computeCombinations(groups)).toEqual([{ var_0: "a", var_1: "x" }]);
  });
});

// ============================================================
// interpolatePrompt
// ============================================================
describe("interpolatePrompt", () => {
  it("replaces a single variable", () => {
    expect(interpolatePrompt("{{cat}}", { var_0: "cat" })).toBe("cat");
  });

  it("replaces in order for multiple variables", () => {
    expect(
      interpolatePrompt("A {{cat}} in {{forest}}", {
        var_0: "dog",
        var_1: "beach",
      }),
    ).toBe("A dog in beach");
  });

  it("keeps placeholder when variable value is missing", () => {
    const result = interpolatePrompt("A {{cat}} in {{forest}}", { var_0: "dog" });
    // Second replacement keeps the {{forest}} placeholder unchanged
    expect(result).toBe("A dog in {{forest}}");
  });

  it("ignores extra keys in variables map", () => {
    expect(interpolatePrompt("{{a}}", { var_0: "hello", var_1: "world" })).toBe("hello");
  });

  it("returns template unchanged when no variables match", () => {
    expect(interpolatePrompt("hello world", {})).toBe("hello world");
  });
});

// ============================================================
// computePromptCombinations
// ============================================================
describe("computePromptCombinations", () => {
  it("returns empty array for empty template", () => {
    expect(computePromptCombinations("", [])).toEqual([]);
  });

  it("returns no combinations when the template has an empty variable group", () => {
    expect(computePromptCombinations("A {{}} portrait", [{ id: "var_0", values: [] }])).toEqual([]);
  });

  it("returns combinations with interpolated prompts", () => {
    const groups: VariableGroup[] = [{ id: "var_0", values: ["cat", "dog"] }];
    const result = computePromptCombinations("A {{cat}} picture", groups);
    expect(result).toEqual([
      { variables: { var_0: "cat" }, prompt: "A cat picture" },
      { variables: { var_0: "dog" }, prompt: "A dog picture" },
    ]);
  });

  it("handles multi-group combination prompts", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["red", "blue"] },
      { id: "var_1", values: ["car"] },
    ];
    const result = computePromptCombinations("{{red}} {{car}}", groups);
    expect(result).toHaveLength(2);
    expect(result[0].prompt).toBe("red car");
    expect(result[1].prompt).toBe("blue car");
  });
});

// ============================================================
// getCombinationCount
// ============================================================
describe("getCombinationCount", () => {
  it("returns 0 for empty groups", () => {
    expect(getCombinationCount([])).toBe(0);
  });

  it("returns 0 when all groups have empty values", () => {
    expect(getCombinationCount([{ id: "v0", values: [] }])).toBe(0);
  });

  it("returns count for single group", () => {
    expect(getCombinationCount([{ id: "var_0", values: ["a", "b", "c"] }])).toBe(3);
  });

  it("returns product of group sizes", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["a", "b"] },
      { id: "var_1", values: ["1", "2", "3"] },
    ];
    expect(getCombinationCount(groups)).toBe(6);
  });

  it("returns 0 when any group has no filled values", () => {
    const groups: VariableGroup[] = [
      { id: "var_0", values: ["a", "b"] },
      { id: "var_1", values: [] },
    ];
    expect(getCombinationCount(groups)).toBe(0);
  });
});

// ============================================================
// extractAiBlocks
// ============================================================
describe("extractAiBlocks", () => {
  it("returns empty array for empty string", () => {
    expect(extractAiBlocks("")).toEqual([]);
  });

  it("returns empty array for string with no ai blocks", () => {
    expect(extractAiBlocks("A beautiful landscape")).toEqual([]);
  });

  it("extracts a single ai block", () => {
    expect(extractAiBlocks("{*three colors*}")).toEqual([
      { raw: "{*three colors*}", description: "three colors" },
    ]);
  });

  it("extracts ai blocks with full-width braces", () => {
    expect(extractAiBlocks("｛*three colors*｝")).toEqual([
      { raw: "｛*three colors*｝", description: "three colors" },
    ]);
  });

  it("extracts multiple ai blocks", () => {
    expect(extractAiBlocks("{*a*} and {*b c*}")).toEqual([
      { raw: "{*a*}", description: "a" },
      { raw: "{*b c*}", description: "b c" },
    ]);
  });

  it("extracts mixed half-width and full-width ai blocks", () => {
    expect(extractAiBlocks("{*a*} and ｛*b c*｝")).toEqual([
      { raw: "{*a*}", description: "a" },
      { raw: "｛*b c*｝", description: "b c" },
    ]);
  });

  it("extracts ai blocks mixed with text", () => {
    const result = extractAiBlocks("A {*three colors*} watch on {*white*} background");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ raw: "{*three colors*}", description: "three colors" });
    expect(result[1]).toEqual({ raw: "{*white*}", description: "white" });
  });

  it("skips whitespace-only description", () => {
    expect(extractAiBlocks("{*  *}")).toEqual([]);
  });

  it("skips unclosed block", () => {
    expect(extractAiBlocks("{*unclosed")).toEqual([]);
  });

  it("trims whitespace in description", () => {
    expect(extractAiBlocks("{*  hello world  *}")).toEqual([
      { raw: "{*  hello world  *}", description: "hello world" },
    ]);
  });

  it("works alongside standard variable groups", () => {
    const template = "{*three colors*} {{cat, dog}}";
    const aiBlocks = extractAiBlocks(template);
    const varGroups = extractVariableGroups(template);
    expect(aiBlocks).toEqual([{ raw: "{*three colors*}", description: "three colors" }]);
    expect(varGroups).toEqual([{ id: "var_0", values: ["cat", "dog"] }]);
  });

  it("handles Chinese descriptions", () => {
    expect(extractAiBlocks("{*三种颜色*}")).toEqual([
      { raw: "{*三种颜色*}", description: "三种颜色" },
    ]);
  });

  it("handles Chinese descriptions with full-width braces", () => {
    expect(extractAiBlocks("｛*三种颜色*｝")).toEqual([
      { raw: "｛*三种颜色*｝", description: "三种颜色" },
    ]);
  });
});

// ============================================================
// replaceAiBlock
// ============================================================
describe("replaceAiBlock", () => {
  it("replaces an ai block with variable syntax", () => {
    expect(replaceAiBlock("A {*x*} here", "{*x*}", ["a", "b"])).toBe("A {{a, b}} here");
  });

  it("replaces with single value", () => {
    expect(replaceAiBlock("{*x*}", "{*x*}", ["only"])).toBe("{{only}}");
  });

  it("replaces with multiple values", () => {
    expect(replaceAiBlock("{*x*}", "{*x*}", ["red", "yellow", "blue"])).toBe(
      "{{red, yellow, blue}}",
    );
  });

  it("replaces middle block in multi-block template", () => {
    expect(
      replaceAiBlock("A {*colors*} watch in {{leather, steel}}", "{*colors*}", ["red", "blue"]),
    ).toBe("A {{red, blue}} watch in {{leather, steel}}");
  });

  it("replaces full-width ai blocks with variable syntax", () => {
    expect(replaceAiBlock("A ｛*colors*｝ watch", "｛*colors*｝", ["red", "blue"])).toBe(
      "A {{red, blue}} watch",
    );
  });
});
