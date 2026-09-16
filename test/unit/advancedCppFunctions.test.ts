import { describe, expect, it } from "vitest";
import { scanCallIndexFile } from "../../src/utils/callIndexScanner";
import { scanCppFunctionDefinitions } from "../../src/utils/cppFunctionScanner";

describe("advanced C++ function indexing", () => {
  it("recognizes namespace functions, templates, and template-id calls", () => {
    const source = `
namespace codec {
int decode(int value)
{
  return value;
}
}

template <typename T>
int invoke(T value)
{
  return codec::decode(static_cast<int>(value));
}

int dispatch()
{
  return invoke<Wrapper<long>>(1);
}
`;
    const indexed = scanCallIndexFile(source);

    expect(indexed.definitions.map((definition) => definition.name)).toEqual([
      "decode",
      "invoke",
      "dispatch"
    ]);
    expect(
      indexed.definitions.find((definition) => definition.name === "decode")
    ).toMatchObject({ memberOwner: "codec" });
    expect(
      indexed.calls.find(
        (call) => call.callee === "decode" && call.callerName === "invoke"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "codec" }
    });
    expect(
      indexed.calls.find(
        (call) => call.callee === "invoke" && call.callerName === "dispatch"
      )
    ).toMatchObject({ kind: "callable" });
  });

  it("recognizes cv-qualified, noexcept, and trailing-return member definitions", () => {
    const source = `
class Worker {
public:
  int read() const noexcept(true);
  auto size() const -> int;
  int update() volatile &;
  static int start();
};

int Worker::read() const noexcept(true)
{
  return 1;
}

auto Worker::size() const -> int
{
  return read();
}

int Worker::update() volatile &
{
  return 2;
}

int Worker::start()
{
  return 0;
}
`;
    const indexed = scanCallIndexFile(source);

    expect(indexed.definitions.map((definition) => definition.name)).toEqual([
      "read",
      "size",
      "update",
      "start",
      "Worker"
    ]);
    expect(
      indexed.definitions
        .filter((definition) => definition.kind === "function")
        .map((definition) => [definition.name, definition.memberOwner])
    ).toEqual([
      ["read", "Worker"],
      ["size", "Worker"],
      ["update", "Worker"],
      ["start", "Worker"]
    ]);
    expect(
      indexed.calls.find(
        (call) => call.callee === "read" && call.callerName === "size"
      )
    ).toMatchObject({
      kind: "callable",
      implicitMemberOwner: "Worker"
    });
  });

  it("keeps constructors and destructors as distinct function definitions", () => {
    const source = `
class Widget {
public:
  Widget();
  ~Widget();
};

Widget::Widget()
{
  initialize();
}

Widget::~Widget()
{
  release();
}
`;
    const definitions = scanCppFunctionDefinitions(source);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "Widget",
      "~Widget"
    ]);
    expect(
      definitions.map((definition) =>
        source.slice(definition.selectionStart, definition.selectionEnd)
      )
    ).toEqual(["Widget", "~Widget"]);
  });

  it("attributes calls inside a lambda to the containing named function", () => {
    const source = `
void target()
{
}

void schedule()
{
  auto callback = []() {
    target();
  };
  callback();
}
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find(
        (call) => call.callee === "target" && call.callerName === "schedule"
      )
    ).toMatchObject({ kind: "callable" });
    expect(indexed.definitions.map((definition) => definition.name)).toEqual([
      "target",
      "schedule"
    ]);
  });

  it("indexes a capturing lambda as a local declaration and resolves its calls to it", () => {
    const source = `
class ApManager {
  void handle_virtual_bss_request(int cmdu_rx);
  void send_cmdu(int cmdu_tx);
};

void ApManager::handle_virtual_bss_request(int cmdu_rx)
{
  auto send_virtual_bss_response = [this](int radio_uid, bool success)
  {
    send_cmdu(cmdu_tx);
  };
  send_virtual_bss_response(1, true);
  send_virtual_bss_response(2, false);
}
`;
    const indexed = scanCallIndexFile(source);

    const declaration = indexed.declarations.find(
      (candidate) => candidate.name === "send_virtual_bss_response"
    );
    expect(declaration).toMatchObject({
      scope: { kind: "local" }
    });
    expect(indexed.declarations.find((candidate) => candidate.name === "this"))
      .toBeUndefined();
    expect(declaration?.offset).toBe(
      source.indexOf("send_virtual_bss_response")
    );
    for (const call of indexed.calls.filter(
      (call) => call.callee === "send_virtual_bss_response"
    )) {
      expect(call.scope).toMatchObject({
        kind: "local",
        declarationOffset: declaration?.offset
      });
    }
  });

  it("indexes qualified member-function addresses as callable references", () => {
    const source = `
class Worker {
public:
  static void run();
};

void Worker::run()
{
}

void register_worker()
{
  auto callback = &Worker::run;
  consume(callback);
}
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find(
        (call) => call.callee === "run" && call.callerName === "register_worker"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "Worker" }
    });
  });

  it("preserves an arbitrarily named auto receiver for virtual base-type recovery", () => {
    const source = `
class TaskPool {
public:
  bool dispatch();
private:
  TaskMap m_task_pool;
};

bool TaskPool::dispatch()
{
  for (auto &task_element : m_task_pool) {
    auto &selected_handler = task_element.second;
    if (selected_handler->handle_cmdu()) {
      return true;
    }
  }
  return false;
}
`;
    const indexed = scanCallIndexFile(source);

    expect(
      indexed.calls.find(
        (call) => call.callee === "handle_cmdu" && call.callerName === "dispatch"
      )
    ).toMatchObject({
      kind: "callable",
      scope: { kind: "member", owner: "selected_handler" }
    });
  });

  it.todo("distinguishes overloaded functions by parameter signature");
  it.todo("indexes overloaded operator definitions and operator call expressions");
  it.todo("resolves calls through std::function and std::bind wrappers");
  it.todo("resolves pointer-to-member invocation with .* and ->*");
  it.todo("resolves pointee methods through common smart-pointer declarations");
  it.todo("recognizes constructors with member-initializer lists and function-try blocks");
});
