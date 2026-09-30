// РестоГид — сайт и мини-приложение. Тексты, города и рестораны — в data/*.json.
// Карта — MapLibre по данным OpenStreetMap, файл карты города лежит в map/.

(function () {
  'use strict';

  var maplibregl = window.maplibregl;
  var root = document.documentElement;
  var state = { config: null, texts: null, places: [], city: null, map: null, selected: null };

  // Цвета карты — из orders/gid/design.md. Карта — тихий фон: почти без контуров,
  // парки чуть темнее земли, яркое на ней только наши рестораны.
  var MAP_COLORS = {
    light: {
      land: '#EAE3D6', park: '#DFDFCC', scrub: '#E4E1D1', water: '#C6D5D2', building: '#E2D9CA',
      minor: '#F7F2EA', major: '#FFFFFF', rail: '#D3C9B9',
      label: '#6E6256', labelMinor: '#85786B', halo: '#EAE3D6'
    },
    dark: {
      land: '#29211D', park: '#2E2C24', scrub: '#2C2821', water: '#22302F', building: '#30271F',
      minor: '#3A3029', major: '#4A3E34', rail: '#3E332B',
      label: '#B0A294', labelMinor: '#8E8073', halo: '#29211D'
    }
  };

  // Слои карты, которых не показываем: чужие заведения, значки, названия районов и городов,
  // номера домов, служебная застройка — всё, что делает карту похожей на навигатор.
  var HIDDEN_LAYERS = /^(pois|roads_shields|roads_oneway|places_|address_label|earth_label|boundaries|roads_runway|roads_taxiway|landuse_(hospital|industrial|school|beach|zoo|aerodrome|runway|pedestrian|pier)|roads_pier)/;

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
    $('.theme-toggle').setAttribute('aria-label', state.texts[theme === 'dark' ? 'theme_to_light' : 'theme_to_dark']);
    if (state.map) state.map.setStyle(mapStyle(theme));
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
    if (state.map) {
      state.map.setStyle(mapStyle(currentTheme()));
      state.map.setMaxBounds(city.bounds);
      state.map.flyTo({ center: city.center, zoom: city.zoom });
    }
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

  function flavor(theme) {
    var c = MAP_COLORS[theme];
    var f = Object.assign({}, window.basemaps.namedFlavor(theme));
    Object.keys(f).forEach(function (key) {
      if (typeof f[key] !== 'string') return;
      // Обводки дорог — в цвет земли: без них карта спокойнее.
      if (/casing/.test(key)) f[key] = c.land;
      else if (/^(tunnel|bridges)_/.test(key) || /^(minor|other|link)/.test(key)) f[key] = /major|highway/.test(key) ? c.major : c.minor;
    });
    Object.assign(f, {
      background: c.land, earth: c.land,
      park_a: c.park, park_b: c.park, wood_a: c.park, wood_b: c.park, scrub_a: c.scrub, scrub_b: c.scrub,
      glacier: c.land, water: c.water, buildings: c.building, railway: c.rail,
      major: c.major, highway: c.major, link: c.minor, minor_b: c.minor,
      roads_label_minor: c.labelMinor, roads_label_minor_halo: c.halo,
      roads_label_major: c.label, roads_label_major_halo: c.halo,
      landcover: {
        grassland: c.scrub, barren: c.land, urban_area: c.land, farmland: c.land,
        glacier: c.land, scrub: c.scrub, forest: c.park
      }
    });
    return f;
  }

  function mapStyle(theme) {
    var layers = window.basemaps.layers('city', flavor(theme), { lang: 'ru' })
      .filter(function (l) { return !HIDDEN_LAYERS.test(l.id); })
      .map(function (l) {
        if (l.type !== 'symbol') return l;
        l.layout = Object.assign({}, l.layout, {
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12.5],
          'text-letter-spacing': 0.04
        });
        delete l.layout['icon-image'];
        l.paint = Object.assign({}, l.paint, { 'text-halo-width': 1.5, 'text-halo-blur': 0.5 });
        return l;
      });
    return {
      version: 8,
      glyphs: new URL('map/fonts/', location.href).href + '{fontstack}/{range}.pbf',
      sources: {
        city: {
          type: 'vector',
          url: 'pmtiles://' + new URL(state.city.map, location.href).href,
          attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>'
        }
      },
      layers: layers
    };
  }

  function pinElement(place) {
    var wrap = document.createElement('div');
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin';
    pin.dataset.id = place.id;
    pin.setAttribute('aria-pressed', 'false');
    pin.innerHTML = '<span class="pin__dot" aria-hidden="true"></span><span class="pin__label"></span>';
    pin.querySelector('.pin__dot').textContent = place.name.charAt(0);
    pin.querySelector('.pin__label').textContent = place.name;
    pin.addEventListener('click', function (e) { e.stopPropagation(); openSheet(place); });
    wrap.appendChild(pin);
    return wrap;
  }

  function initMap() {
    var protocol = new window.pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    state.map = new maplibregl.Map({
      container: 'map',
      style: mapStyle(currentTheme()),
      center: state.city.center,
      zoom: state.city.zoom,
      minZoom: 10,
      maxZoom: 18,
      maxBounds: state.city.bounds,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false
    });
    state.map.touchZoomRotate.disableRotation();
    state.map.on('click', closeSheet);
    state.map.on('error', function (e) { console.error(e && e.error ? e.error : e); });
    state.places.forEach(function (place) {
      // Точка ресторана — центр кружка, подпись висит под ним.
      new maplibregl.Marker({ element: pinElement(place), anchor: 'top', offset: [0, -19] })
        .setLngLat(place.coords)
        .addTo(state.map);
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
      initMap();
    })
    .catch(function (err) {
      console.error(err);
      $('.map-error').hidden = false;
    });
})();
