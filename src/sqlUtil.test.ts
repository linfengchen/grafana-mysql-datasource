import { isValidIdentifier, quoteLiteral } from './sqlUtil';

describe('isValidIdentifier', () => {
  test.each([
    { value: 'and', expected: false }, // Reserved keyword
    { value: '1name', expected: false }, // Starts with value
    { value: 'my-sql', expected: false }, // Contains not permitted character
    { value: '$id', expected: false }, // $ sign shouldn't be the first character
    { value: 'my sql', expected: false }, // Whitespace is not permitted
    { value: 'mysql ', expected: false }, // Whitespace is not permitted at the end
    { value: ' mysql', expected: false }, // Whitespace is not permitted
    { value: 'id$', expected: true },
    { value: 'myIdentifier', expected: true },
    { value: 'table_name', expected: true },
  ])('should return $expected when value is $value', ({ value, expected }) => {
    expect(isValidIdentifier(value)).toBe(expected);
  });
});

describe('quoteLiteral', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteLiteral('one-api')).toBe("'one-api'");
  });

  it('doubles single quotes', () => {
    expect(quoteLiteral("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'");
  });

  // MySQL honours backslash escapes unless NO_BACKSLASH_ESCAPES is set, so a value
  // ending in a backslash would otherwise consume the closing quote and let the
  // rest of the statement run as SQL.
  it('doubles a trailing backslash so it cannot escape the closing quote', () => {
    expect(quoteLiteral('C:\\')).toBe("'C:\\\\'");
  });

  it('doubles backslashes before doubling quotes', () => {
    expect(quoteLiteral("a\\'")).toBe("'a\\\\'''");
  });

  it('leaves the literal terminated for values mixing both escape characters', () => {
    for (const value of ['\\', "\\'", "'\\", 'a\\\\b', "it's"]) {
      const body = quoteLiteral(value).slice(1, -1);
      expect(body.replace(/\\\\/g, '').replace(/''/g, '')).not.toMatch(/['\\]/);
    }
  });
});
