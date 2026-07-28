import { describe, expect, it } from "vitest";
import { scanCallIndexFile } from "../../src/utils/callIndexScanner";

const linuxStaInfoSample = `
static int __must_check __sta_info_destroy_part1(struct sta_info *sta)
{
  return 0;
}

int __must_check __sta_info_destroy(struct sta_info *sta)
{
  int err = __sta_info_destroy_part1(sta);
  return err;
}

int __sta_info_flush(struct ieee80211_sub_if_data *sdata, bool vlans)
{
  if (!WARN_ON(__sta_info_destroy_part1(sta)))
    return 1;
  return 0;
}

static void ieee80211_iface_work(struct work_struct *work)
{
}

int ieee80211_add_virtual_monitor(struct ieee80211_sub_if_data *sdata)
{
  INIT_WORK(&sdata->work, ieee80211_iface_work);
  return 0;
}

int ieee80211_process_action(struct ieee80211_mgmt *mgmt)
{
  switch (mgmt->u.action.u.addba_req.action_code) {
  case WLAN_ACTION_ADDBA_REQ:
    return ACTION_RESULT_OK;
  default:
    return 0;
  }
}
`;

describe("persistent call-index scanner", () => {
  it("stores exact direct and macro-nested call sites", () => {
    const indexed = scanCallIndexFile(linuxStaInfoSample);
    const calls = indexed.calls.filter(
      (call) => call.callee === "__sta_info_destroy_part1"
    );

    expect(calls.map((call) => call.callerName)).toEqual([
      "__sta_info_destroy",
      "__sta_info_flush"
    ]);
    expect(
      calls.map((call) => linuxStaInfoSample.slice(call.offset, call.offset + call.callee.length))
    ).toEqual(["__sta_info_destroy_part1", "__sta_info_destroy_part1"]);
  });

  it("marks the kernel target definition as file-local", () => {
    const indexed = scanCallIndexFile(linuxStaInfoSample);
    const target = indexed.definitions.find(
      (definition) => definition.name === "__sta_info_destroy_part1"
    );

    expect(target?.isStatic).toBe(true);
  });

  it("indexes a function passed as a bare callback argument", () => {
    const indexed = scanCallIndexFile(linuxStaInfoSample);
    const callback = indexed.calls.find(
      (call) => call.callee === "ieee80211_iface_work"
    );

    expect(callback?.callerName).toBe("ieee80211_add_virtual_monitor");
    expect(
      linuxStaInfoSample.slice(
        callback?.offset,
        callback === undefined ? undefined : callback.offset + callback.callee.length
      )
    ).toBe("ieee80211_iface_work");
    expect(callback?.kind).toBe("callable");
  });

  it("indexes enum values and object-like macros as exact symbol references", () => {
    const indexed = scanCallIndexFile(linuxStaInfoSample);
    const references = indexed.calls.filter(
      (call) =>
        call.callee === "WLAN_ACTION_ADDBA_REQ" ||
        call.callee === "ACTION_RESULT_OK"
    );

    expect(
      references.map((reference) => ({
        name: reference.callee,
        caller: reference.callerName,
        kind: reference.kind,
        text: linuxStaInfoSample.slice(
          reference.offset,
          reference.offset + reference.callee.length
        )
      }))
    ).toEqual([
      {
        name: "WLAN_ACTION_ADDBA_REQ",
        caller: "ieee80211_process_action",
        kind: "symbol",
        text: "WLAN_ACTION_ADDBA_REQ"
      },
      {
        name: "ACTION_RESULT_OK",
        caller: "ieee80211_process_action",
        kind: "symbol",
        text: "ACTION_RESULT_OK"
      }
    ]);
  });
});
