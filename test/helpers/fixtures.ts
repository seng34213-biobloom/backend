import { randomUUID } from 'node:crypto';

export function fixtureNamespace(suite: string): string {
  return `${suite}-${randomUUID().replace(/-/g, '')}`;
}

export function fixtureEmail(namespace: string, name: string): string {
  return `${name}.${namespace}@example.com`;
}
