import { describe, it, expect } from 'vitest';
import { duplicateDefinitionsByCell } from '../notebook';
import type { Notebook } from '../../types/notebook';

const notebook = (cells: any[]): Notebook =>
  ({ id: 'nb', name: 'T', cells, createdAt: 0, updatedAt: 0 }) as Notebook;

describe('duplicateDefinitionsByCell', () => {
  it('lists the conflicting names under every cell that defines them', () => {
    const map = duplicateDefinitionsByCell(notebook([
      { id: 'a', type: 'code', content: 'let x = 1;\nconst y = 2;' },
      { id: 'b', type: 'code', content: 'let x = 2;' },
      { id: 'c', type: 'code', content: 'const y = 3;\nconst q = 4;' },
    ]));
    expect(map.get('a')).toEqual(['x', 'y']); // sorted, both conflicts
    expect(map.get('b')).toEqual(['x']);
    expect(map.get('c')).toEqual(['y']);      // `q` is unique
  });

  it('is empty for a notebook with no collisions, or no notebook', () => {
    expect(duplicateDefinitionsByCell(notebook([
      { id: 'a', type: 'code', content: 'const x = 1;' },
      { id: 'b', type: 'code', content: 'const y = x;' },
    ])).size).toBe(0);
    expect(duplicateDefinitionsByCell(null).size).toBe(0);
  });
});
