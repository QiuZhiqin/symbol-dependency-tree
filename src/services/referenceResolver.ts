import * as vscode from "vscode";
import type {
  ReferenceQueryResult,
  TargetSymbol
} from "../model/symbolTypes";
import { PersistentCallIndex } from "./persistentCallIndex";
import { QueryCache } from "./queryCache";

export class ReferenceResolver {
  public constructor(
    private readonly persistentIndex: PersistentCallIndex,
    private readonly cache: QueryCache
  ) {}

  public async resolve(
    target: TargetSymbol,
    token: vscode.CancellationToken
  ): Promise<ReferenceQueryResult> {
    const cacheKey = `index:${target.id}`;
    const cached = this.cache.get<ReferenceQueryResult>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const indexed = await this.persistentIndex.query(target, token);
    const result: ReferenceQueryResult = {
      scopes: indexed.scopes
    };
    return this.cache.set(cacheKey, result);
  }
}
