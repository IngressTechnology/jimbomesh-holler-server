/* JimboMesh Holler Server — Swagger UI brand script
 * Injects footer and removes SmartBear branding.
 * Loaded after SwaggerUIBundle initialises. */

(function () {
  function injectFooter() {
    var swagger = document.querySelector('.swagger-ui');
    if (!swagger) return false;
    var wrapper = swagger.querySelector('.wrapper');
    if (!wrapper) return false;
    if (document.querySelector('.jimbomesh-footer')) return true;

    var footer = document.createElement('div');
    footer.className = 'jimbomesh-footer';
    footer.innerHTML =
      'Made with \uD83E\uDD43 by <a href="https://jimbomesh.ai" target="_blank" rel="noopener">Ingress Technology</a>' +
      ' &mdash; <a href="https://jimbomesh.ai" target="_blank" rel="noopener">jimbomesh.ai</a>';
    swagger.appendChild(footer);
    return true;
  }

  /* Swagger UI renders async — poll until the wrapper appears, then inject. */
  var attempts = 0;
  var timer = setInterval(function () {
    if (injectFooter() || ++attempts > 50) clearInterval(timer);
  }, 100);
})();
