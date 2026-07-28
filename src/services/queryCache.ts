export class QueryCache {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public set<T>(key: string, value: T): T {
    this.values.set(key, value);
    return value;
  }

  public getOrCreate<T>(key: string, factory: () => T): T {
    const existing = this.get<T>(key);
    if (existing !== undefined) {
      return existing;
    }
    return this.set(key, factory());
  }

  public deleteByPrefix(prefix: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }
  }

  public clear(): void {
    this.values.clear();
  }
}
