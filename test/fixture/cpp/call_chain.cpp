#include "call_chain.hpp"

int global_total = 0;
static int file_total = 0;

void Counter::increment() {
  value += 1;
  global_total += value;
}

int local_scope_one() {
  int scoped_value = 1;
  scoped_value += 1;
  return scoped_value;
}

int local_scope_two() {
  int scoped_value = 2;
  return scoped_value;
}

void update_members(Counter& counter, AlternateCounter& alternate) {
  counter.value += 1;
  alternate.value += 1;
}

int leaf(int input) {
  int local_total = APPLY_TWICE(input);
  global_total += local_total;
  return local_total;
}

int middle(int input) {
  const int first = leaf(input);
  const int second = leaf(input + 1);
  return first + second;
}

int entry(int input) {
  file_total += middle(input);
  return file_total;
}

int recursive_a(int input) {
  return input <= 0 ? 0 : recursive_b(input - 1);
}

int recursive_b(int input) {
  return input <= 0 ? 0 : recursive_a(input - 1);
}

// leaf(input) is not a reference.
const char* ignored_text = "middle(input) is not a reference";
const char* ignored_raw = R"cpp(entry(input) is not a reference)cpp";

void callback_impl(int value) {
  global_total += value;
}

CallbackOps callback_event_ops = {
  .complete = callback_impl,
};

void dispatch_callback(CallbackContext *context) {
  context->event_ops->complete(1);
}

void consume_payload(Payload *payload) {
  global_total += payload->value;
}
