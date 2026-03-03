(function () {
  'use strict';

  var AVAILABLE = ['en', 'hillbilly', 'es'];
  var DEFAULT_LANG = 'en';
  var STORAGE_KEY = 'holler-lang';

  var locales = {};
  var currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
  var changeCallbacks = [];

  function resolve(obj, key) {
    var parts = key.split('.');
    var val = obj;
    for (var i = 0; i < parts.length; i++) {
      if (val == null) return undefined;
      val = val[parts[i]];
    }
    return val;
  }

  function t(key, params) {
    var val = resolve(locales[currentLang], key);
    if (val == null) val = resolve(locales[DEFAULT_LANG], key);
    if (val == null) return key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        val = val.split('{' + k + '}').join(String(params[k]));
      });
    }
    return val;
  }

  function setLang(code) {
    if (AVAILABLE.indexOf(code) === -1) return;
    currentLang = code;
    localStorage.setItem(STORAGE_KEY, code);
    changeCallbacks.forEach(function (cb) { cb(code); });
  }

  function getLang() { return currentLang; }

  function getAvailable() {
    return AVAILABLE.map(function (code) {
      var meta = locales[code] && locales[code].meta;
      return meta || { code: code, name: code, flag: '' };
    });
  }

  function onChange(cb) { changeCallbacks.push(cb); }

  function loadAll() {
    return Promise.all(AVAILABLE.map(function (code) {
      return fetch('/admin/locales/' + code + '.json')
        .then(function (r) { return r.json(); })
        .then(function (data) { locales[code] = data; })
        .catch(function () {});
    }));
  }

  window.i18n = {
    t: t,
    setLang: setLang,
    getLang: getLang,
    getAvailable: getAvailable,
    onChange: onChange,
    loadAll: loadAll,
  };
})();
