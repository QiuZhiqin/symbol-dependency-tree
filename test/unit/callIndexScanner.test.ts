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

  it("does not treat macro comparisons in conditions as local declarations", () => {
    const source = `
#define VS_SUB_TYPE_TOPO_DETECTION 0
#define VENDOR_SPECIFIC 4

int parse_cmdu_message(unsigned char vendor_mtype, unsigned short mtype)
{
  if (vendor_mtype == VS_SUB_TYPE_TOPO_DETECTION) {
    consume(vendor_mtype);
  }
  if (mtype != VENDOR_SPECIFIC ||
      vendor_mtype != VS_SUB_TYPE_TOPO_DETECTION)
    return -1;
  return 0;
}
`;
    const indexed = scanCallIndexFile(source);
    const references = indexed.calls.filter(
      (call) => call.callee === "VS_SUB_TYPE_TOPO_DETECTION"
    );

    expect(references).toHaveLength(2);
    expect(
      references.map((reference) => ({
        caller: reference.callerName,
        kind: reference.kind,
        scope: reference.scope
      }))
    ).toEqual([
      {
        caller: "parse_cmdu_message",
        kind: "symbol",
        scope: undefined
      },
      {
        caller: "parse_cmdu_message",
        kind: "symbol",
        scope: undefined
      }
    ]);
    expect(
      indexed.declarations.some(
        (declaration) => declaration.name === "VS_SUB_TYPE_TOPO_DETECTION"
      )
    ).toBe(false);
  });

  it("binds same-named local variables to their declaring function and block", () => {
    const source = `
int first(void)
{
  int a = 1;
  a += 1;
  {
    int a = 2;
    a += 1;
  }
  return a;
}

int second(void)
{
  int a = 3;
  return a;
}
`;
    const indexed = scanCallIndexFile(source);
    const references = indexed.calls.filter((call) => call.callee === "a");
    const localKeys = references.map((reference) =>
      reference.scope?.kind === "local"
        ? `${reference.scope.functionSelectionStart}:${reference.scope.declarationOffset}`
        : undefined
    );

    expect(new Set(localKeys).size).toBe(3);
    expect(localKeys[0]).toBe(localKeys[1]);
    expect(localKeys[2]).toBe(localKeys[3]);
    expect(localKeys[4]).toBe(localKeys[0]);
    expect(localKeys[5]).toBe(localKeys[6]);
    expect(localKeys.every((key) => key !== undefined)).toBe(true);
  });

  it("binds equal member names to the receiver type", () => {
    const source = `
struct B {
  int a;
  void touch();
};

struct C {
  int a;
};

void B::touch()
{
  a += 1;
}

void update(B *b, C& c)
{
  b->a += 1;
  c.a += 1;
}
`;
    const indexed = scanCallIndexFile(source);
    const members = indexed.declarations
      .filter((declaration) => declaration.name === "a")
      .map((declaration) =>
        declaration.scope.kind === "member"
          ? declaration.scope.owner
          : undefined
      );
    const references = indexed.calls
      .filter((call) => call.callee === "a")
      .map((call) => ({
        owner:
          call.scope?.kind === "member"
            ? call.scope.owner
            : call.implicitMemberOwner,
        caller: call.callerName
      }));

    expect(members).toEqual(["B", "C"]);
    expect(references).toEqual([
      { owner: "B", caller: "touch" },
      { owner: "B", caller: "update" },
      { owner: "C", caller: "update" }
    ]);
  });

  it("ignores a packing macro placed before a structure tag", () => {
    const source = `
struct GNU_PACKED add_vbss_entry_msg {
  unsigned char stamac[6];
};

struct __attribute__((packed)) attributed_msg {
  unsigned char address[6];
};

class API_EXPORT exported_msg {
  unsigned char address2[6];
};

void zr_hdo_rm_add_sta_event_to_daemon(struct add_vbss_entry_msg *msg)
{
  consume(msg->stamac);
}
`;
    const indexed = scanCallIndexFile(source);
    const declaration = indexed.declarations.find(
      (candidate) => candidate.name === "stamac"
    );
    const reference = indexed.calls.find(
      (candidate) =>
        candidate.callee === "stamac" &&
        candidate.callerName === "zr_hdo_rm_add_sta_event_to_daemon"
    );

    expect(declaration?.scope).toEqual({
      kind: "member",
      owner: "add_vbss_entry_msg"
    });
    expect(reference?.scope).toEqual({
      kind: "member",
      owner: "add_vbss_entry_msg"
    });
    expect(
      indexed.declarations.find(
        (candidate) => candidate.name === "address"
      )?.scope
    ).toEqual({
      kind: "member",
      owner: "attributed_msg"
    });
    expect(
      indexed.declarations.find(
        (candidate) => candidate.name === "address2"
      )?.scope
    ).toEqual({
      kind: "member",
      owner: "exported_msg"
    });
  });

  it("indexes callback-table initialization and chained member calls", () => {
    const source = `
struct roam_event_ops {
  void (*drv_zr_sta_steer_complete)(void *ctx);
};

struct roam_app {
  const struct roam_event_ops *event_ops;
};

void zero_roam_sta_steer_event(void *ctx)
{
}

struct roam_event_ops event_ops = {
  .drv_zr_sta_steer_complete = zero_roam_sta_steer_event,
};

void dispatch(struct roam_app *ctx)
{
  ctx->event_ops->drv_zr_sta_steer_complete(ctx);
}
`;
    const indexed = scanCallIndexFile(source);
    const initializer = indexed.definitions.find(
      (definition) => definition.name === "event_ops"
    );
    const callbackReferences = indexed.calls.filter(
      (call) => call.callee === "drv_zr_sta_steer_complete"
    );

    expect(initializer?.kind).toBe("initializer");
    expect(
      indexed.declarations.find(
        (declaration) =>
          declaration.scope.kind === "member" &&
          declaration.scope.owner === "roam_app" &&
          declaration.name === "event_ops"
      )?.typeName
    ).toBe("roam_event_ops");
    expect(
      indexed.calls.find(
        (call) => call.callee === "zero_roam_sta_steer_event"
      )
    ).toMatchObject({
      kind: "callable",
      callerName: "event_ops"
    });
    expect(callbackReferences).toHaveLength(2);
    expect(
      callbackReferences.find((reference) => reference.callerName === "event_ops")
    ).toMatchObject({
      kind: "symbol",
      scope: { kind: "member", owner: "roam_event_ops" },
      callerName: "event_ops"
    });
    expect(
      callbackReferences.find((reference) => reference.callerName === "dispatch")
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "event_ops" },
      memberOwnerPath: {
        rootOwner: "roam_app",
        members: ["event_ops"]
      },
      callerName: "dispatch"
    });
  });

  it("resolves members reached through a typed global initializer", () => {
    const source = `
typedef struct {
  int (*get_sta_entry)(const char *mac);
} vbss_operations_t;

static vbss_operations_t g_vbss_ops = {0};

static const vbss_operations_t vbss_7916_ops = {
  .get_sta_entry = vbss_7916_get_sta_entry,
};

int vbss_if_get_sta_entry(const char *mac)
{
  return g_vbss_ops.get_sta_entry(mac);
}

void handle_vbss_security_request(const char *mac)
{
  vbss_if_get_sta_entry(mac);
}
`;
    const indexed = scanCallIndexFile(source);
    const memberReferences = indexed.calls.filter(
      (call) => call.callee === "get_sta_entry"
    );

    expect(memberReferences).toHaveLength(2);
    expect(memberReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: { kind: "member", owner: "vbss_operations_t" },
          callerName: "vbss_7916_ops"
        }),
        expect.objectContaining({
          kind: "callable",
          scope: { kind: "member", owner: "vbss_operations_t" },
          callerName: "vbss_if_get_sta_entry"
        })
      ])
    );
    expect(
      indexed.calls.find(
        (call) =>
          call.callee === "vbss_if_get_sta_entry" &&
          call.callerName === "handle_vbss_security_request"
      )
    ).toMatchObject({ kind: "callable", scope: undefined });
  });

  it("resolves members through uninitialized, pointer, and extern global objects", () => {
    const source = `
struct transport_ops {
  void (*send_packet)(void);
};

static struct transport_ops active_transport;
extern struct transport_ops *external_transport;

void dispatch_local(void)
{
  active_transport.send_packet();
}

void dispatch_external(void)
{
  external_transport->send_packet();
}
`;
    const indexed = scanCallIndexFile(source);

    expect(indexed.objectTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "active_transport",
          typeName: "transport_ops"
        }),
        expect.objectContaining({
          name: "external_transport",
          typeName: "transport_ops"
        })
      ])
    );
    expect(
      indexed.calls
        .filter((call) => call.callee === "send_packet")
        .map((call) => ({ callerName: call.callerName, scope: call.scope }))
    ).toEqual([
      {
        callerName: "dispatch_local",
        scope: { kind: "member", owner: "transport_ops" }
      },
      {
        callerName: "dispatch_external",
        scope: { kind: "member", owner: "transport_ops" }
      }
    ]);
  });

  it("indexes inheritance, virtual overrides, and base-typed dispatch calls", () => {
    const source = `
class Task {
public:
  virtual bool handle_message(int value) = 0;
};

class ClientTask : public Task {
public:
  bool handle_message(int value) override;
};

bool ClientTask::handle_message(int value)
{
  return value != 0;
}

void dispatch(Task *task)
{
  task->handle_message(1);
}
`;
    const indexed = scanCallIndexFile(source);

    expect(indexed.inheritances).toContainEqual({
      derived: "ClientTask",
      base: "Task"
    });
    expect(indexed.virtualMembers).toEqual(
      expect.arrayContaining([
        { owner: "Task", name: "handle_message" },
        { owner: "ClientTask", name: "handle_message" }
      ])
    );
    expect(
      indexed.calls.find(
        (call) => call.callee === "handle_message" && call.callerName === "dispatch"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "Task" }
    });
  });

  it("resolves calls through an unqualified typed data member", () => {
    const source = `
class TaskPool {
public:
  void handle_message();
};

class Controller {
public:
  void receive();
private:
  TaskPool m_pool;
};

void Controller::receive()
{
  m_pool.handle_message();
}
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find(
        (call) => call.callee === "handle_message" && call.callerName === "receive"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "TaskPool" }
    });
  });

  it("preserves an unqualified member path when its type is declared in another file", () => {
    const source = `
void Controller::receive()
{
  m_pool.handle_message();
}
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find(
        (call) => call.callee === "handle_message" && call.callerName === "receive"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "m_pool" },
      memberOwnerPath: { rootOwner: "Controller", members: ["m_pool"] }
    });
  });

  it("indexes callbacks in positional command-table initializers as callable", () => {
    const source = `
int Show_ReptTable_Proc(void *adapter, char *argument)
{
  return 0;
}

struct PRIVATE_SHOW_PROC {
  const char *name;
  int (*set_proc)(void *adapter, char *argument);
};

struct PRIVATE_SHOW_PROC RTMP_PRIVATE_AP_SHOW_SUPPORT_PROC[] = {
#ifdef MAC_REPEATER_SUPPORT
  { "rept_table", Show_ReptTable_Proc },
#endif
};
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find((call) => call.callee === "Show_ReptTable_Proc")
    ).toMatchObject({
      kind: "callable",
      callerName: "RTMP_PRIVATE_AP_SHOW_SUPPORT_PROC"
    });
  });

  it("indexes a type contained by another type and used by a function", () => {
    const source = `
struct A {
  int value;
};

struct B {
  struct A child;
};

void C(struct A *arg)
{
  struct A local;
  consume(arg);
}
`;
    const indexed = scanCallIndexFile(source);
    const typeDefinitions = indexed.definitions
      .filter((definition) => definition.kind === "type")
      .map((definition) => definition.name);
    const references = indexed.calls
      .filter((call) => call.callee === "A")
      .map((call) => call.callerName);

    expect(typeDefinitions).toEqual(["A", "B"]);
    expect(references).toEqual(["C", "C", "B"]);
  });
});
