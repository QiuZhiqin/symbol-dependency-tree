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

    const generation = this.cache.currentGeneration;
    const indexed = await this.persistentIndex.query(target, token);
    const result: ReferenceQueryResult = {
      scopes: indexed.scopes,
      definition: indexed.targetDefinition
    };
    if (this.cache.currentGeneration === generation && !token.isCancellationRequested) {
      this.cache.set(cacheKey, result);
    }
    return result;
  }
}
