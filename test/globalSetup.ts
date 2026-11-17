import type { GlobalSetupContext } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Starts a single-node MongoDB replica set for the test run, so checkout code runs with
 * real multi-document transactions. The binary is downloaded and cached on first use;
 * set MONGOMS_SYSTEM_BINARY=/usr/bin/mongod to reuse a locally installed mongod instead.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  provide('mongoUri', rs.getUri());
  return async () => {
    await rs.stop();
  };
}
