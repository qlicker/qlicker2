import '@testing-library/jest-dom';

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollBy', {
    value: () => {},
    writable: true,
    configurable: true,
  });
}
