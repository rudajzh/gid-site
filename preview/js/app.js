// РестоГид — сайт и мини-приложение. Тексты, города и рестораны — в data/*.json.
(function () {
  'use strict';

  var root = document.documentElement;
  var state = { config: null, texts: null, places: [], city: null, map: null, scheme: null, selected: null };

  // Цвета карты для каждой темы — из orders/gid/design.md.
  var MAP_COLORS = {
    dark: { land: '#312823', building: '#3A2F29', park: '#37402F', water: '#34403D', road: '#41362E', label: '#BBAEA2', halo: '#2B231F' },
    light: { land: '#EEE7DB', building: '#E6DDCF', park: '#DDE4D1', water: '#CCDBD7', road: '#FFFFFF', label: '#6B5F54', halo: '#F4EFE7' }
  };

  function $(sel) { return document.querySelector(sel); }

  function fmt(template, vars) {
    return template.replace(/\{(\w+)\}/g, function (_, key) { return vars[key] != null ? vars[key] : ''; });
  }

  function loadJSON(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('не загрузился файл данных');
      return r.json();
    });
  }

  // Тема

  function currentTheme() { return root.dataset.theme === 'light' ? 'light' : 'dark'; }

  function applyTheme(theme, remember) {
    root.dataset.theme = theme;
    if (remember) { try { localStorage.setItem('theme', theme); } catch (e) {} }
    $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#2B231F' : '#F4EFE7');
    var toggle = $('.theme-toggle');
    toggle.setAttribute('aria-label', state.texts[theme === 'dark' ? 'theme_to_light' : 'theme_to_dark']);
    if (state.map) {
      state.map.update({ theme: theme });
      state.scheme.update({ customization: mapStyle(theme) });
    }
  }

  // Города

  function renderCities() {
    var t = state.texts;
    var button = $('.city__button');
    var menu = $('.city__menu');
    $('.city__name').textContent = state.city.name;
    button.setAttribute('aria-label', t.city_label + ': ' + state.city.name);
    menu.innerHTML = '';
    state.config.cities.forEach(function (city) {
      var li = document.createElement('li');
      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'city__option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(city.id === state.city.id));
      option.textContent = city.name;
      if (!city.active) {
        option.disabled = true;
        var soon = document.createElement('span');
        soon.className = 'city__soon';
        soon.textContent = t.city_soon;
        option.appendChild(soon);
      }
      option.addEventListener('click', function () { selectCity(city.id); });
      li.appendChild(option);
      menu.appendChild(li);
    });
  }

  function toggleCityMenu(open) {
    var menu = $('.city__menu');
    var show = open != null ? open : menu.hidden;
    menu.hidden = !show;
    $('.city__button').setAttribute('aria-expanded', String(show));
  }

  function selectCity(id) {
    var city = state.config.cities.find(function (c) { return c.id === id && c.active; });
    toggleCityMenu(false);
    if (!city || city.id === state.city.id) return;
    state.city = city;
    renderCities();
    closeSheet();
    if (state.map) state.map.update({ location: { center: city.center, zoom: city.zoom, duration: 400 } });
  }

  // Шторка ресторана

  function openSheet(place) {
    var t = state.texts;
    state.selected = place.id;
    $('.sheet__name').textContent = place.name;
    $('.sheet__check-sum').textContent = fmt(t.avg_check, { sum: new Intl.NumberFormat('ru-RU').format(place.avgCheck) });
    $('.sheet__cuisine').textContent = place.cuisine;
    var date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(place.checkedAt + 'T12:00:00'));
    $('.sheet__checked span').textContent = fmt(t.checked, { date: date });
    $('.sheet__hours').textContent = fmt(t.hours, { area: place.area, open: place.open, close: place.close });
    $('.sheet__fictional').hidden = !place.fictional;
    $('.sheet').hidden = false;
    markPins();
  }

  function closeSheet() {
    state.selected = null;
    $('.sheet').hidden = true;
    markPins();
  }

  function markPins() {
    document.querySelectorAll('.pin').forEach(function (pin) {
      pin.setAttribute('aria-pressed', String(pin.dataset.id === state.selected));
    });
  }

  // Карта

  function mapStyle(theme) {
    var c = MAP_COLORS[theme];
    return [
      { tags: { any: ['poi'] }, stylers: [{ visibility: 'off' }] },
      { tags: { any: ['landscape', 'admin'] }, elements: 'geometry', stylers: [{ color: c.land }] },
      { tags: { any: ['building'] }, elements: 'geometry', stylers: [{ color: c.building }] },
      { tags: { any: ['park', 'vegetation'] }, elements: 'geometry', stylers: [{ color: c.park }] },
      { tags: { any: ['water'] }, elements: 'geometry', stylers: [{ color: c.water }] },
      { tags: { any: ['road'] }, elements: 'geometry', stylers: [{ color: c.road }] },
      { elements: 'label.text.fill', stylers: [{ color: c.label }] },
      { elements: 'label.text.outline', stylers: [{ color: c.halo }] }
    ];
  }

  function pinElement(place) {
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin';
    pin.dataset.id = place.id;
    pin.setAttribute('aria-pressed', 'false');
    pin.innerHTML =
      '<span class="pin__dot"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v8a2 2 0 0 0 2 2v8"/><path d="M11 3v6"/><path d="M3 3v6a4 4 0 0 0 4 4"/><path d="M17 21V3c2.5 1 4 4 4 7h-4"/></svg></span>' +
      '<span class="pin__label"></span>';
    pin.querySelector('.pin__label').textContent = place.name;
    pin.addEventListener('click', function (e) { e.stopPropagation(); openSheet(place); });
    return pin;
  }

  function loadYandex(key) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://api-maps.yandex.ru/v3/?apikey=' + encodeURIComponent(key) + '&lang=ru_RU';
      s.onload = function () { window.ymaps3.ready.then(resolve, reject); };
      s.onerror = function () { reject(new Error('карта не загрузилась')); };
      document.head.appendChild(s);
    });
  }

  function initMap() {
    return loadYandex(state.config.yandexMapsKey).then(function () {
      var y = window.ymaps3;
      var theme = currentTheme();
      state.map = new y.YMap($('#map'), {
        location: { center: state.city.center, zoom: state.city.zoom },
        theme: theme,
        showScaleInCopyrights: false
      });
      state.scheme = new y.YMapDefaultSchemeLayer({ customization: mapStyle(theme) });
      state.map.addChild(state.scheme);
      state.map.addChild(new y.YMapDefaultFeaturesLayer());
      state.map.addChild(new y.YMapListener({ onClick: function (obj) { if (!obj) closeSheet(); } }));
      state.places.forEach(function (place) {
        state.map.addChild(new y.YMapMarker({ coordinates: place.coords }, pinElement(place)));
      });
    });
  }

  // Запуск

  function bindUI() {
    $('.theme-toggle').addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
    $('.city__button').addEventListener('click', function (e) { e.stopPropagation(); toggleCityMenu(); });
    $('.sheet__close').addEventListener('click', closeSheet);
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.city')) toggleCityMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { toggleCityMenu(false); closeSheet(); }
    });
  }

  function fillTexts() {
    var t = state.texts;
    document.title = t.page_title;
    $('meta[name="description"]').setAttribute('content', t.page_description);
    document.querySelectorAll('[data-text]').forEach(function (el) { el.textContent = t[el.dataset.text]; });
    $('.sheet__close').setAttribute('aria-label', t.close);
    $('.env-badge').hidden = window.GID_ENV !== 'preview';
  }

  Promise.all([loadJSON('data/config.json'), loadJSON('data/texts.json'), loadJSON('data/places.json')])
    .then(function (data) {
      state.config = data[0];
      state.texts = data[1];
      state.city = state.config.cities.find(function (c) { return c.id === state.config.defaultCity; });
      state.places = data[2].filter(function (p) { return p.city === state.city.id; });
      fillTexts();
      applyTheme(currentTheme(), false);
      renderCities();
      bindUI();
      return initMap();
    })
    .catch(function (err) {
      console.error(err);
      $('.map-error').hidden = false;
    });
})();
