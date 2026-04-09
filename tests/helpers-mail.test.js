describe('normalizeSmtpPassword', () => {
  let normalizeSmtpPassword;
  let logSpy;

  beforeEach(() => {
    jest.resetModules();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    ({ normalizeSmtpPassword } = require('../lib/helpers'));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test('strips whitespace from Gmail app passwords', () => {
    expect(normalizeSmtpPassword({
      host: 'smtp.gmail.com',
      user: 'mapscrapper7@gmail.com',
      pass: 'abcd efgh ijkl mnop',
    })).toBe('abcdefghijklmnop');
  });

  test('leaves non-Gmail SMTP passwords unchanged', () => {
    expect(normalizeSmtpPassword({
      host: 'smtp.example.com',
      user: 'ops@example.com',
      pass: 'abc def',
    })).toBe('abc def');
  });
});