namespace advanced {

int qualified_target(int value)
{
  return value;
}

}

template <typename T>
int invoke_value(T value)
{
  return advanced::qualified_target(static_cast<int>(value));
}

class AdvancedWorker {
public:
  int read() const noexcept;
};

int AdvancedWorker::read() const noexcept
{
  return advanced::qualified_target(2);
}

int call_template()
{
  return invoke_value<long>(3);
}

class Task {
public:
  virtual bool handle_cmdu();
};

bool Task::handle_cmdu()
{
  return false;
}

class VbssTask : public Task {
public:
  bool handle_cmdu() override;
};

bool VbssTask::handle_cmdu()
{
  return true;
}

struct TaskElement {
  Task *second;
};

bool dispatch_task(TaskElement &task_element)
{
  auto &selected_handler = task_element.second;
  return selected_handler->handle_cmdu();
}
