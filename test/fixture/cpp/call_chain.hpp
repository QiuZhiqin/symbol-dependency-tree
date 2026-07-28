#pragma once

#define APPLY_TWICE(value) ((value) + (value))
#define PROJECT_NAME "symbol-reference-tree"

struct Counter {
  int value;
  void increment();
};

extern int global_total;

int leaf(int input);
int middle(int input);
int entry(int input);
int recursive_a(int input);
int recursive_b(int input);
