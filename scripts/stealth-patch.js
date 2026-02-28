// Stealth patch — fixes detection vectors not covered by stealth.min.js
(() => {
  // 1. Fix navigator.webdriver: should be false, not absent.
  //    Real Chrome has this property on the prototype returning false.
  //    Deleting it entirely is detectable via ('webdriver' in navigator).
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => false,
    configurable: true,
    enumerable: true,
  });

  // 2. Fix CDP MouseEvent screenX/screenY bug.
  //    When clicks are dispatched via CDP Input.dispatchMouseEvent, screenX/screenY
  //    incorrectly equal clientX/clientY (relative to iframe). Real clicks have
  //    screenX/screenY relative to the physical screen (values in the hundreds).
  //    Cloudflare Turnstile exploits this for 100% precise bot detection.
  //    Reference: https://github.com/nicehash/nicehashquickmine
  const screenX = Math.floor(Math.random() * 401) + 800; // 800-1200
  const screenY = Math.floor(Math.random() * 201) + 400; // 400-600
  Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
  Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
  Object.defineProperty(PointerEvent.prototype, 'screenX', { value: screenX });
  Object.defineProperty(PointerEvent.prototype, 'screenY', { value: screenY });
})();
