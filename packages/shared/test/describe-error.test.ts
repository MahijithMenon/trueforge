import { describe, expect, it } from 'vitest';
import { describeError } from '../src/postgres.ts';

/**
 * Health output is what an operator reads when something is broken at 3am.
 * `database: unreachable: ` - which is what an empty driver message produced -
 * is worse than useless, so the fallbacks are tested.
 */
describe('describeError', () => {
  it('prefers the message when there is one', () => {
    expect(describeError(new Error('connection terminated'))).toBe('connection terminated');
  });

  it('falls back to an errno code when the message is empty', () => {
    const error = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toBe('ECONNREFUSED');
  });

  it('unwraps an AggregateError with no message of its own', () => {
    const aggregate = new AggregateError(
      [new Error('ipv6 failed'), new Error('ipv4 failed')],
      '',
    );
    expect(describeError(aggregate)).toBe('ipv6 failed; ipv4 failed');
  });

  it('falls back to the error name when nothing else is present', () => {
    const bare = new Error('');
    bare.name = 'WeirdDriverError';
    expect(describeError(bare)).toBe('WeirdDriverError');
  });

  it('handles thrown strings and non-errors without throwing', () => {
    expect(describeError('plain string failure')).toBe('plain string failure');
    expect(describeError(undefined)).toBe('Unknown error');
    expect(describeError({ nope: true })).toBe('Unknown error');
    expect(describeError('')).toBe('Unknown error');
  });

  it('never returns an empty string, whatever it is given', () => {
    for (const value of [new Error(''), '', null, undefined, 0, {}, []]) {
      expect(describeError(value).length).toBeGreaterThan(0);
    }
  });
});
