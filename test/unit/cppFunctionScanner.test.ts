import { describe, expect, it } from "vitest";
import {
  findContainingCppFunction,
  scanCppFunctionDefinitions
} from "../../src/utils/cppFunctionScanner";

const linuxStaInfoSample = `
static int __must_check __sta_info_destroy_part1(struct sta_info *sta)
{
  return sta ? 0 : -1;
}

int __must_check __sta_info_destroy(struct sta_info *sta)
{
  int err = __sta_info_destroy_part1(sta);
  return err;
}

int __sta_info_flush(struct ieee80211_sub_if_data *sdata, bool vlans)
{
  if (!WARN_ON(__sta_info_destroy_part1(sta)))
    list_add(&sta->free_list, &free_list);
  return 0;
}
`;

describe("C/C++ function scanner", () => {
  it("recognizes the first function after preprocessor includes", () => {
    const source = `
#include <linux/kernel.h>
#include "local.h"

static void ieee80211_send_addba_request(void)
{
  return;
}
`;

    expect(scanCppFunctionDefinitions(source).map((definition) => definition.name)).toEqual([
      "ieee80211_send_addba_request"
    ]);
  });

  it("recognizes Linux kernel function definitions with attributes", () => {
    const definitions = scanCppFunctionDefinitions(linuxStaInfoSample);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "__sta_info_destroy_part1",
      "__sta_info_destroy",
      "__sta_info_flush"
    ]);
  });

  it("maps direct and macro-nested calls to their containing callers", () => {
    const definitions = scanCppFunctionDefinitions(linuxStaInfoSample);
    const directCall = linuxStaInfoSample.lastIndexOf(
      "__sta_info_destroy_part1",
      linuxStaInfoSample.indexOf("__sta_info_flush")
    );
    const macroCall = linuxStaInfoSample.lastIndexOf("__sta_info_destroy_part1");

    expect(findContainingCppFunction(definitions, directCall)?.name).toBe(
      "__sta_info_destroy"
    );
    expect(findContainingCppFunction(definitions, macroCall)?.name).toBe(
      "__sta_info_flush"
    );
  });
});
