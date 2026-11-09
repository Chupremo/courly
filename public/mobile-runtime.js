(() => {
  const isNative = Boolean(window.Capacitor?.isNativePlatform?.());
  if (!isNative) return;

  document.documentElement.classList.add('courtly-native-app');
  window.COURTLY_NATIVE_APP = true;
  window.COURTLY_PUBLIC_ORIGIN = 'https://www.courtlyph.com';

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(window.COURTLY_PUBLIC_ORIGIN + input, init);
    }
    if (input instanceof Request) {
      const url = new URL(input.url, window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
        const rewritten = new Request(window.COURTLY_PUBLIC_ORIGIN + url.pathname + url.search, input);
        return nativeFetch(rewritten, init);
      }
    }
    return nativeFetch(input, init);
  };
})();
