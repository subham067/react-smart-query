/**
 * __mocks__/react-native-mmkv.ts
 *
 * Jest mock for react-native-mmkv.
 * Tests run in Node — there is no native MMKV binary.
 * This mock provides the same API backed by a plain Map.
 *
 * Referenced in package.json jest.moduleNameMapper.
 */

export class MMKV {
  private store = new Map<string, string>();

  getString(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clearAll(): void {
    this.store.clear();
  }

  getAllKeys(): string[] {
    return Array.from(this.store.keys());
  }
}
