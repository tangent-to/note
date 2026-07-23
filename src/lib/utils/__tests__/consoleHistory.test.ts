import { describe, it, expect } from 'vitest';
import { navigateHistory } from '../consoleHistory';

describe('navigateHistory', () => {
  const H = ['a', 'b', 'c']; // oldest -> newest

  it('does nothing on empty history', () => {
    expect(navigateHistory([], null, 'prev')).toEqual({ index: null, value: null });
    expect(navigateHistory([], null, 'next')).toEqual({ index: null, value: null });
  });

  it('prev from a live line recalls the newest entry', () => {
    expect(navigateHistory(H, null, 'prev')).toEqual({ index: 2, value: 'c' });
  });

  it('prev walks toward older entries and clamps at the oldest', () => {
    expect(navigateHistory(H, 2, 'prev')).toEqual({ index: 1, value: 'b' });
    expect(navigateHistory(H, 1, 'prev')).toEqual({ index: 0, value: 'a' });
    expect(navigateHistory(H, 0, 'prev')).toEqual({ index: 0, value: 'a' }); // clamp
  });

  it('next walks toward newer entries', () => {
    expect(navigateHistory(H, 0, 'next')).toEqual({ index: 1, value: 'b' });
    expect(navigateHistory(H, 1, 'next')).toEqual({ index: 2, value: 'c' });
  });

  it('next past the newest returns to a fresh live line', () => {
    expect(navigateHistory(H, 2, 'next')).toEqual({ index: null, value: '' });
  });

  it('next while already live is a no-op (falls through)', () => {
    expect(navigateHistory(H, null, 'next')).toEqual({ index: null, value: null });
  });
});
