// РестоГид — сайт и мини-приложение. Тексты, города и рестораны — в data/*.json.
// Карта — MapLibre по данным OpenStreetMap, файл карты города лежит в map/.

(function () {
  'use strict';

  var maplibregl = window.maplibregl;
  var root = document.documentElement;
  var state = { config: null, texts: null, places: [], city: null, map: null, selected: null, place: null, pushed: false };

  // Цвета карты — из orders/gid/design.md. Карта — тихий фон: почти без контуров,
  // парки чуть темнее земли, яркое на ней только наши рестораны.
  var MAP_COLORS = {
    light: {
      land: '#EAE3D6', park: '#DFDFCC', scrub: '#E4E1D1', water: '#C6D5D2', building: '#E2D9CA',
      minor: '#F7F2EA', major: '#FFFFFF', rail: '#D3C9B9',
      label: '#6E6256', labelMinor: '#85786B', halo: '#EAE3D6'
    },
    dark: {
      land: '#221B18', park: '#282620', scrub: '#26221C', water: '#1D2827', building: '#29211C',
      minor: '#2F2722', major: '#3B312A', rail: '#332A24',
      label: '#A89A8C', labelMinor: '#857869', halo: '#221B18'
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
    $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#1E1815' : '#F1EBE1');
    $('.theme-toggle').setAttribute('aria-label', state.texts[theme === 'dark' ? 'theme_to_light' : 'theme_to_dark']);
    if (state.map) switchMapTheme(theme);
  }

  // Смена темы у карты: карта растворяется в фоне, перекрашивается и проявляется,
  // вместо того чтобы полсекунды мигать недорисованными слоями.
  var switchToken = 0;

  function switchMapTheme(theme) {
    var el = $('#map');
    var token = ++switchToken;
    el.classList.add('map--switching');
    setTimeout(function () {
      if (token !== switchToken) return;
      state.map.setStyle(mapStyle(theme), { diff: false });
      var shown = false;
      var show = function () {
        if (shown || token !== switchToken) return;
        shown = true;
        el.classList.remove('map--switching');
      };
      state.map.once('idle', show);
      setTimeout(show, 1500);
    }, 180);
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
    // Ресторан — над шторкой, а не под ней: на телефоне шторка снизу, на широком экране слева.
    var wide = window.matchMedia('(min-width: 720px)').matches;
    state.map.easeTo({ center: place.coords, offset: wide ? [210, 0] : [0, -150], duration: 450 });
  }

  // Страница ресторана. Адрес — #<id ресторана>: работает кнопка «назад» и жест назад на айфоне.

  function price(value) {
    return fmt(state.texts.price, { price: new Intl.NumberFormat('ru-RU').format(value) });
  }

  function renderPlace(place) {
    var t = state.texts;
    $('.place__mono').textContent = place.name.charAt(0);
    $('.place__name').textContent = place.name;
    $('.place__cuisine').textContent = place.cuisine;
    var date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(place.checkedAt + 'T12:00:00'));
    $('.place__checked span').textContent = fmt(t.checked, { date: date });
    $('.place__address').textContent = place.area;
    $('.place__hours').textContent = fmt(t.place_hours, { open: place.open, close: place.close });
    $('.place__avg').textContent = fmt(t.place_avg, { sum: new Intl.NumberFormat('ru-RU').format(place.avgCheck) });
    $('.place__about').textContent = place.about;
    $('.place__fictional').hidden = !place.fictional;

    var tabs = $('.place__tabs');
    var menu = $('.place__menu');
    tabs.innerHTML = '';
    menu.innerHTML = '';
    place.menu.forEach(function (section, i) {
      var id = 'menu-' + i;
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'place__tab';
      tab.dataset.target = id;
      tab.textContent = section.title;
      tab.addEventListener('click', function () {
        var target = document.getElementById(id);
        var scroller = $('.place__scroll');
        var top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - tabs.offsetHeight;
        scroller.scrollTo({ top: top, behavior: 'smooth' });
      });
      tabs.appendChild(tab);

      var block = document.createElement('section');
      block.className = 'menu-section';
      block.id = id;
      var h = document.createElement('h2');
      h.className = 'menu-section__title';
      h.textContent = section.title;
      block.appendChild(h);
      var list = document.createElement('div');
      list.className = 'menu-card';
      block.appendChild(list);
      section.items.forEach(function (item) {
        var row = document.createElement('article');
        row.className = 'dish';
        row.innerHTML = '<div class="dish__text"><h3 class="dish__name"></h3><p class="dish__desc"></p>' +
          '<p class="dish__price"><span class="dish__sum"></span><span class="dish__weight"></span></p></div>';
        if (item.photo) {
          var img = document.createElement('img');
          img.className = 'dish__photo';
          img.src = item.photo;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          row.appendChild(img);
        }
        row.querySelector('.dish__name').textContent = item.name;
        row.querySelector('.dish__desc').textContent = item.desc;
        row.querySelector('.dish__sum').textContent = price(item.price);
        row.querySelector('.dish__weight').textContent = item.weight;
        list.appendChild(row);
      });
      menu.appendChild(block);
    });
  }

  function showRoute() {
    var id = decodeURIComponent(location.hash.slice(1));
    var place = state.places.find(function (p) { return p.id === id; });
    var page = $('.place');
    if (place) {
      if (state.place !== place.id) {
        renderPlace(place);
        $('.place__scroll').scrollTop = 0;
      }
      state.place = place.id;
      page.hidden = false;
      document.title = place.name + ' — ' + state.texts.brand;
      $('.place__back').focus({ preventScroll: true });
    } else {
      state.place = null;
      page.hidden = true;
      document.title = state.texts.page_title;
    }
  }

  function openPlace(id) {
    state.pushed = true;
    location.hash = encodeURIComponent(id);
  }

  function closePlace() {
    if (state.pushed) {
      state.pushed = false;
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      showRoute();
    }
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
      transition: { duration: 0, delay: 0 },
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
      attributionControl: { compact: true }
    });
    fitPlaces(false);
    state.map.on('rotate', updateCompass);
    state.map.on('pitch', updateCompass);
    state.map.on('click', closeSheet);
    state.map.on('error', function (e) { console.error(e && e.error ? e.error : e); });
    state.places.forEach(function (place) {
      // Точка ресторана — центр кружка, подпись висит под ним.
      new maplibregl.Marker({ element: pinElement(place), anchor: 'top', offset: [0, -19] })
        .setLngLat(place.coords)
        .addTo(state.map);
    });
  }

  // Все рестораны города в кадре: сверху место под шапку, снизу — под подпись карты.
  function fitPlaces(animate) {
    if (state.places.length < 2) return;
    var bounds = new maplibregl.LngLatBounds();
    state.places.forEach(function (p) { bounds.extend(p.coords); });
    state.map.fitBounds(bounds, {
      padding: { top: 140, bottom: 90, left: 70, right: 70 },
      maxZoom: 16, animate: animate
    });
  }

  // Компас: появляется, когда карту повернули или наклонили, и возвращает её прямо.

  function updateCompass() {
    var bearing = state.map.getBearing();
    var turned = Math.abs(bearing) > 1 || state.map.getPitch() > 1;
    $('.compass').hidden = !turned;
    $('.compass svg').style.transform = 'rotate(' + (-bearing) + 'deg)';
  }

  // Запуск

  function bindUI() {
    $('.theme-toggle').addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
    $('.city__button').addEventListener('click', function (e) { e.stopPropagation(); toggleCityMenu(); });
    $('.sheet__close').addEventListener('click', closeSheet);
    $('.sheet__open').addEventListener('click', function () { if (state.selected) openPlace(state.selected); });
    $('.place__back').addEventListener('click', closePlace);
    window.addEventListener('hashchange', showRoute);
    $('.compass').addEventListener('click', function () {
      state.map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.city')) toggleCityMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      toggleCityMenu(false);
      if (state.place) closePlace(); else closeSheet();
    });
  }

  function fillTexts() {
    var t = state.texts;
    document.title = t.page_title;
    $('meta[name="description"]').setAttribute('content', t.page_description);
    document.querySelectorAll('[data-text]').forEach(function (el) { el.textContent = t[el.dataset.text]; });
    $('.sheet__close').setAttribute('aria-label', t.close);
    $('.compass').setAttribute('aria-label', t.compass);
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
      showRoute();
    })
    .catch(function (err) {
      console.error(err);
      $('.map-error').hidden = false;
    });
})();
