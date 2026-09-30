// РестоГид — сайт и мини-приложение. Тексты, города и рестораны — в data/*.json.
// Карта — MapLibre по данным OpenStreetMap, файл карты города лежит в map/.

(function () {
  'use strict';

  var maplibregl = window.maplibregl;
  var root = document.documentElement;
  var state = { config: null, texts: null, places: [], city: null, map: null, selected: null, place: null, pushed: false,
    cart: {}, order: { table: null, time: null }, orderPushed: false };

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
        var qty = document.createElement('div');
        qty.className = 'qty';
        qty.dataset.name = item.name;
        row.querySelector('.dish__price').appendChild(qty);
        list.appendChild(row);
      });
      menu.appendChild(block);
    });
  }

  // Корзина: у каждого ресторана своя, живёт в браузере и переживает перезагрузку.

  function loadCart() {
    try { return JSON.parse(localStorage.getItem('cart')) || {}; } catch (e) { return {}; }
  }

  function saveCart() {
    try { localStorage.setItem('cart', JSON.stringify(state.cart)); } catch (e) {}
  }

  function cartOf(place) {
    if (!state.cart[place.id]) state.cart[place.id] = {};
    return state.cart[place.id];
  }

  function cartLines(place) {
    var cart = cartOf(place);
    var lines = [];
    place.menu.forEach(function (section) {
      section.items.forEach(function (item) {
        if (cart[item.name]) lines.push({ item: item, qty: cart[item.name] });
      });
    });
    return lines;
  }

  function cartTotals(place) {
    return cartLines(place).reduce(function (acc, line) {
      acc.count += line.qty;
      acc.sum += line.qty * line.item.price;
      return acc;
    }, { count: 0, sum: 0 });
  }

  function plural(n, forms) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }

  function setQty(place, name, qty) {
    var cart = cartOf(place);
    if (qty > 0) cart[name] = qty; else delete cart[name];
    saveCart();
    refreshCart(place);
  }

  // Кнопка «+» у блюда, а когда блюдо в заказе — «− 2 +».
  function renderQty(el, place) {
    var t = state.texts;
    var name = el.dataset.name;
    var qty = cartOf(place)[name] || 0;
    el.innerHTML = '';
    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'qty__btn qty__btn--plus';
    plus.setAttribute('aria-label', fmt(t.add, { name: name }));
    plus.textContent = '+';
    plus.addEventListener('click', function () { setQty(place, name, qty + 1); });
    if (qty > 0) {
      var minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'qty__btn';
      minus.setAttribute('aria-label', fmt(t.remove, { name: name }));
      minus.textContent = '−';
      minus.addEventListener('click', function () { setQty(place, name, qty - 1); });
      var count = document.createElement('span');
      count.className = 'qty__count';
      count.textContent = qty;
      el.append(minus, count, plus);
      el.classList.add('qty--active');
    } else {
      el.appendChild(plus);
      el.classList.remove('qty--active');
    }
  }

  function refreshCart(place) {
    var t = state.texts;
    document.querySelectorAll('.qty').forEach(function (el) { renderQty(el, place); });
    var totals = cartTotals(place);
    var bar = $('.cartbar');
    bar.hidden = totals.count === 0;
    $('.place').classList.toggle('place--with-cart', totals.count > 0);
    $('.cartbar__sum').textContent = fmt(t.order_bar_sum, {
      count: totals.count, dishes: plural(totals.count, t.dishes), sum: price(totals.sum)
    });
    if (!$('.order').hidden) renderOrderLines(place);
  }

  // Экран заказа: блюда, столик на схеме зала, время прихода.

  function renderOrder(place) {
    $('.order__place').textContent = place.name;
    state.order = { table: null, time: null };
    renderHall(place);
    renderTimes();
    renderOrderLines(place);
  }

  function renderOrderLines(place) {
    var box = $('.order-lines');
    var lines = cartLines(place);
    box.innerHTML = '';
    box.hidden = lines.length === 0;
    $('.order__empty').hidden = lines.length > 0;
    lines.forEach(function (line) {
      var row = document.createElement('div');
      row.className = 'order-line';
      row.innerHTML = '<div class="order-line__text"><span class="order-line__name"></span><span class="order-line__sum"></span></div>';
      row.querySelector('.order-line__name').textContent = line.item.name;
      row.querySelector('.order-line__sum').textContent = price(line.item.price * line.qty);
      var qty = document.createElement('div');
      qty.className = 'qty';
      qty.dataset.name = line.item.name;
      row.appendChild(qty);
      box.appendChild(row);
      renderQty(qty, place);
    });
    $('.order__sum').textContent = price(cartTotals(place).sum);
    updateSend(place);
  }

  function tableText(key, table) {
    var t = state.texts;
    return fmt(t[key], { id: table.id, seats: table.seats, seatsWord: plural(table.seats, t.seats), zone: table.zone });
  }

  function renderHall(place) {
    var t = state.texts;
    var hall = $('.hall');
    hall.innerHTML = '';
    hall.style.aspectRatio = String(1 / place.hall.ratio);
    place.hall.zones.forEach(function (z) {
      var zone = document.createElement('div');
      zone.className = 'hall__zone hall__zone--' + z.kind + (z.y === 0 ? ' hall__zone--top' : '');
      zone.style.cssText = 'left:' + z.x + '%;top:' + z.y + '%;width:' + z.w + '%;height:' + z.h + '%';
      var label = document.createElement('span');
      label.textContent = z.name;
      zone.appendChild(label);
      hall.appendChild(zone);
    });
    place.hall.tables.forEach(function (tb) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hall__table hall__table--' + tb.shape;
      btn.style.left = tb.x + '%';
      btn.style.top = tb.y + '%';
      btn.style.width = tb.w + '%';
      if (tb.shape === 'rect') btn.style.height = tb.h + '%';
      btn.innerHTML = '<span class="hall__num"></span><span class="hall__seats"></span>';
      btn.querySelector('.hall__num').textContent = tb.id;
      btn.querySelector('.hall__seats').textContent = tb.seats;
      var label = tableText('order_table_label', tb);
      if (tb.busy) {
        btn.disabled = true;
        btn.classList.add('hall__table--busy');
        label += ', ' + t.order_busy;
      }
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function () {
        state.order.table = tb;
        hall.querySelectorAll('.hall__table').forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        $('.hall__status').textContent = tableText('order_table_chosen', tb);
        updateSend(place);
      });
      hall.appendChild(btn);
    });
    $('.hall__status').textContent = t.order_table_hint;
  }

  function renderTimes() {
    var t = state.texts;
    var box = $('.times');
    box.innerHTML = '';
    t.order_times.forEach(function (min) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', 'false');
      chip.textContent = fmt(t.order_time_option, { min: min });
      chip.addEventListener('click', function () {
        state.order.time = min;
        box.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-checked', String(c === chip)); });
        updateSend(currentPlace());
      });
      box.appendChild(chip);
    });
  }

  function updateSend(place) {
    var t = state.texts;
    var btn = $('.send');
    var totals = cartTotals(place);
    var need = totals.count === 0 ? t.send_need_dishes
      : !state.order.table ? t.send_need_table
      : !state.order.time ? t.send_need_time : null;
    btn.disabled = !!need;
    btn.textContent = need || fmt(t.send, { sum: price(totals.sum) });
  }

  function sendOrder() {
    // Из Телеграма заказ уйдёт боту — это следующий шаг. На обычном сайте
    // объясняем, что заказы идут через Телеграм, и даём ссылку на бота.
    var bot = state.config.bot;
    var link = $('.tg__open');
    link.hidden = !bot;
    if (bot) link.href = 'https://t.me/' + bot;
    $('.tg__soon').hidden = !!bot;
    $('.tg').hidden = false;
    (bot ? link : $('.tg__close')).focus();
  }

  function currentPlace() {
    return state.places.find(function (p) { return p.id === state.place; });
  }

  // Адреса: #<ресторан> — меню, #<ресторан>/order — заказ.
  function showRoute() {
    var parts = decodeURIComponent(location.hash.slice(1)).split('/');
    var place = state.places.find(function (p) { return p.id === parts[0]; });
    var page = $('.place');
    var order = $('.order');
    if (place) {
      if (state.place !== place.id) {
        state.place = place.id;
        renderPlace(place);
        $('.place__scroll').scrollTop = 0;
      }
      page.hidden = false;
      refreshCart(place);
      var wantOrder = parts[1] === 'order';
      if (wantOrder && order.hidden) {
        renderOrder(place);
        $('.order__scroll').scrollTop = 0;
      }
      order.hidden = !wantOrder;
      document.title = place.name + ' — ' + state.texts.brand;
      (wantOrder ? $('.order__back') : $('.place__back')).focus({ preventScroll: true });
    } else {
      state.place = null;
      page.hidden = true;
      order.hidden = true;
      document.title = state.texts.page_title;
    }
  }

  function openOrder() {
    state.orderPushed = true;
    location.hash = encodeURIComponent(state.place) + '/order';
  }

  function closeOrder() {
    if (state.orderPushed) {
      state.orderPushed = false;
      history.back();
    } else {
      history.replaceState(null, '', '#' + encodeURIComponent(state.place));
      showRoute();
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
    $('.cartbar__button').addEventListener('click', openOrder);
    $('.order__back').addEventListener('click', closeOrder);
    $('.send').addEventListener('click', sendOrder);
    $('.tg__close').addEventListener('click', function () { $('.tg').hidden = true; $('.send').focus(); });
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
      if (!$('.tg').hidden) { $('.tg').hidden = true; return; }
      if (!$('.order').hidden) closeOrder();
      else if (state.place) closePlace();
      else closeSheet();
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
      state.cart = loadCart();
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
