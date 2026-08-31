import { describe, it, expect } from 'vitest';
import { seedBuiltin } from '../jsExecutor';

describe('seedBuiltin', () => {
  it('seeds an empty slot and updates its own value on re-seed', () => {
    const scope: Record<string, any> = {};
    const owned: Record<string, any> = {};
    seedBuiltin(scope, owned, 'width', 860);
    expect(scope.width).toBe(860);
    // window resized → re-measured before the next run
    seedBuiltin(scope, owned, 'width', 640);
    expect(scope.width).toBe(640);
  });

  it('backs off once user code assigned its own value', () => {
    const scope: Record<string, any> = {};
    const owned: Record<string, any> = {};
    seedBuiltin(scope, owned, 'width', 860);
    scope.width = 5; // a cell ran `const width = 5`
    seedBuiltin(scope, owned, 'width', 900);
    expect(scope.width).toBe(5);
  });

  it('reclaims the slot after a scope reset', () => {
    const scope: Record<string, any> = {};
    const owned: Record<string, any> = {};
    seedBuiltin(scope, owned, 'width', 860);
    scope.width = 5;
    delete scope.width; // resetScope() clears all keys
    seedBuiltin(scope, owned, 'width', 900);
    expect(scope.width).toBe(900);
  });
});
