// Override the default locale for Intl formatting in tests to avoid OS locale failures (e.g. German)
const originalDateTimeFormat = Intl.DateTimeFormat;
const originalNumberFormat = Intl.NumberFormat;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Intl.DateTimeFormat = class extends originalDateTimeFormat {
  constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    super(locales || "en-US", options);
  }
} as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Intl.NumberFormat = class extends originalNumberFormat {
  constructor(locales?: string | string[], options?: Intl.NumberFormatOptions) {
    super(locales || "en-US", options);
  }
} as any;

// Also patch toLocaleString on Date and Number to default to 'en-US'
const originalDateToLocaleString = Date.prototype.toLocaleString;
Date.prototype.toLocaleString = function (locales?: string | string[] | any, options?: Intl.DateTimeFormatOptions) {
  return originalDateToLocaleString.call(this, locales || "en-US", options);
};

const originalDateToLocaleDateString = Date.prototype.toLocaleDateString;
Date.prototype.toLocaleDateString = function (locales?: string | string[] | any, options?: Intl.DateTimeFormatOptions) {
  return originalDateToLocaleDateString.call(this, locales || "en-US", options);
};

const originalDateToLocaleTimeString = Date.prototype.toLocaleTimeString;
Date.prototype.toLocaleTimeString = function (locales?: string | string[] | any, options?: Intl.DateTimeFormatOptions) {
  return originalDateToLocaleTimeString.call(this, locales || "en-US", options);
};

const originalNumberToLocaleString = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (locales?: string | string[] | any, options?: Intl.NumberFormatOptions) {
  return originalNumberToLocaleString.call(this, locales || "en-US", options);
};
