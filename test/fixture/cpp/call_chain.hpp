#pragma once

#define APPLY_TWICE(value) ((value) + (value))
#define PROJECT_NAME "symbol-reference-tree"
#define GNU_PACKED __attribute__((packed))

struct GNU_PACKED Counter {
  int value;
  void increment();
};

struct AlternateCounter {
  int value;
};

extern int global_total;

int local_scope_one();
int local_scope_two();
void update_members(Counter& counter, AlternateCounter& alternate);
int leaf(int input);
int middle(int input);
int entry(int input);
int recursive_a(int input);
int recursive_b(int input);
