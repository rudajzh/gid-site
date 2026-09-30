// РестоГид — сайт и мини-приложение. Тексты, города и рестораны — в data/*.json.
// Карта — MapLibre по данным OpenStreetMap, файл карты города лежит в map/.

(function () {
  'use strict';

  var maplibregl = window.maplibregl;
  var root = document.documentElement;
  var state = { config: null, texts: null, places: [], city: null, map: null, selected: null, place: null, pushed: false,
    cart: {}, book: null, bookDays: [], orderPushed: false };

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

  // Бронь: день → гости → время → столик на плане зала → блюда по желанию.
  // Занятость столов в макете придуманная, но для одного дня и времени всегда одинаковая.

  var SVG = 'http://www.w3.org/2000/svg';

  function minutes(hhmm) { var p = hhmm.split(':'); return +p[0] * 60 + +p[1]; }
  function hhmm(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function bookDays(place) {
    var out = [];
    var base = new Date();
    base.setHours(0, 0, 0, 0);
    for (var i = 0; i < place.booking.days; i++) {
      var d = new Date(base);
      d.setDate(base.getDate() + i);
      out.push(d);
    }
    return out;
  }

  function dayKey(d) { return d.toISOString().slice(0, 10); }

  function isBusy(place, day, slot, table) {
    var peak = slot >= minutes('18:30') && slot <= minutes('21:00');
    return hash(place.id + dayKey(day) + slot + table.id) % 100 < (peak ? 55 : 25);
  }

  function slotsFor(place, dayIndex) {
    var b = place.booking;
    var list = [];
    var earliest = -1;
    if (dayIndex === 0) {
      var now = new Date();
      earliest = now.getHours() * 60 + now.getMinutes() + b.leadMinutes;
    }
    for (var m = minutes(b.from); m <= minutes(b.to); m += b.step) {
      if (m < earliest) continue;
      list.push(m);
    }
    return list;
  }

  function tableFree(place, table) {
    var bk = state.book;
    if (bk.slot == null) return true;
    return !isBusy(place, state.bookDays[bk.day], bk.slot, table);
  }

  function slotOpen(place, dayIndex, slot) {
    return place.plan.tables.some(function (tb) {
      return tb.seats >= state.book.guests && !isBusy(place, state.bookDays[dayIndex], slot, tb);
    });
  }

  function renderBooking(place) {
    $('.order__place').textContent = place.name;
    state.bookDays = bookDays(place);
    state.book = { day: 0, guests: Math.min(2, place.booking.maxGuests), slot: null, table: null };
    // Если сегодня уже нечего бронировать — сразу завтра.
    if (!slotsFor(place, 0).some(function (m) { return slotOpen(place, 0, m); })) state.book.day = 1;
    renderDays(place);
    renderGuests(place);
    renderSlots(place);
    renderPlan(place);
    renderOrderLines(place);
  }

  function renderDays(place) {
    var t = state.texts;
    var box = $('.days');
    box.innerHTML = '';
    state.bookDays.forEach(function (d, i) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--day';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(i === state.book.day));
      var top = i === 0 ? t.book_today : i === 1 ? t.book_tomorrow
        : new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(d);
      chip.innerHTML = '<span class="chip__top"></span><span class="chip__bottom"></span>';
      chip.querySelector('.chip__top').textContent = top;
      chip.querySelector('.chip__bottom').textContent = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d).replace('.', '');
      chip.addEventListener('click', function () {
        state.book.day = i;
        state.book.slot = null;
        state.book.table = null;
        box.querySelectorAll('.chip').forEach(function (c, j) { c.setAttribute('aria-checked', String(j === i)); });
        renderSlots(place);
        renderPlan(place);
      });
      box.appendChild(chip);
    });
  }

  function renderGuests(place) {
    var t = state.texts;
    var n = state.book.guests;
    $('.guests__count').textContent = n + ' ' + plural(n, t.guests);
    $('.guests__less').disabled = n <= 1;
    $('.guests__more').disabled = n >= place.booking.maxGuests;
  }

  function changeGuests(delta) {
    var place = currentPlace();
    var n = Math.max(1, Math.min(place.booking.maxGuests, state.book.guests + delta));
    state.book.guests = n;
    if (state.book.table && state.book.table.seats < n) state.book.table = null;
    if (state.book.slot != null && !slotOpen(place, state.book.day, state.book.slot)) {
      state.book.slot = null;
      state.book.table = null;
    }
    renderGuests(place);
    renderSlots(place);
    renderPlan(place);
  }

  function renderSlots(place) {
    var box = $('.slots');
    box.innerHTML = '';
    var any = false;
    slotsFor(place, state.book.day).forEach(function (m) {
      var open = slotOpen(place, state.book.day, m);
      any = any || open;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip--slot';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(m === state.book.slot));
      chip.textContent = hhmm(m);
      chip.disabled = !open;
      chip.addEventListener('click', function () {
        state.book.slot = m;
        if (state.book.table && !tableFree(place, state.book.table)) state.book.table = null;
        box.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-checked', String(c === chip)); });
        renderPlan(place);
      });
      box.appendChild(chip);
    });
    $('.slots__empty').hidden = any;
    updateSend(place);
  }

  function svg(tag, attrs, parent) {
    var el = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(el);
    return el;
  }

  // Стул — скруглённый прямоугольник, развёрнутый спинкой от стола.
  function chair(g, x, y, angle) {
    svg('rect', { x: x - 17, y: y - 13, width: 34, height: 26, rx: 8, class: 'plan__chair',
      transform: 'rotate(' + angle + ' ' + x + ' ' + y + ')' }, g);
  }

  function drawChairs(g, tb) {
    if (tb.shape === 'round') {
      for (var i = 0; i < tb.seats; i++) {
        var a = (360 / tb.seats) * i - 90 + (tb.seats === 2 ? 90 : 0);
        var rad = a * Math.PI / 180;
        var d = tb.r + 24;
        chair(g, tb.x + Math.cos(rad) * d, tb.y + Math.sin(rad) * d, a + 90);
      }
      return;
    }
    var left = tb.x - tb.w / 2, top = tb.y - tb.h / 2;
    if (tb.sofa) {
      // Со стороны дивана стульев нет, остальные — напротив него.
      var n = Math.max(1, tb.seats - 2);
      for (var k = 0; k < n; k++) {
        var yy = top + tb.h * (k + 1) / (n + 1);
        chair(g, tb.sofa === 'right' ? left - 22 : left + tb.w + 22, yy, tb.sofa === 'right' ? 90 : -90);
      }
      return;
    }
    var perSide = Math.ceil(tb.seats / 2);
    var bottom = tb.seats - perSide;
    for (var j = 0; j < perSide; j++) chair(g, left + tb.w * (j + 1) / (perSide + 1), top - 22, 0);
    for (var q = 0; q < bottom; q++) chair(g, left + tb.w * (q + 1) / (bottom + 1), top + tb.h + 22, 180);
  }

  function wallGap(plan, item, hallH) {
    var H = hallH || plan.h;
    var from = item.from != null ? item.from : item.at;
    var to = item.to != null ? item.to : item.at + item.width;
    switch (item.side) {
      case 'top': return { x1: from, y1: 0, x2: to, y2: 0, horiz: true };
      case 'bottom': return { x1: from, y1: H, x2: to, y2: H, horiz: true };
      case 'hallBottom': return { x1: from, y1: H, x2: to, y2: H, horiz: true };
      case 'left': return { x1: 0, y1: from, x2: 0, y2: to, horiz: false };
      default: return { x1: plan.w, y1: from, x2: plan.w, y2: to, horiz: false };
    }
  }

  function renderPlan(place) {
    var t = state.texts;
    var plan = place.plan;
    var hallH = plan.hall ? plan.hall.h : plan.h;
    var box = $('.plan');
    box.innerHTML = '';
    var root = svg('svg', { viewBox: '-12 -12 ' + (plan.w + 24) + ' ' + (plan.h + 24), class: 'plan__svg',
      role: 'group', 'aria-label': fmt(t.plan_label, { name: place.name }) }, box);
    var defs = svg('defs', {}, root);
    var hatch = svg('pattern', { id: 'hatch', width: 12, height: 12, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 12, class: 'plan__hatch' }, hatch);

    // Терраса и вода — снаружи зала.
    if (plan.terrace) {
      svg('rect', { x: 0, y: plan.terrace.y, width: plan.w, height: plan.terrace.h, class: 'plan__terrace' }, root);
      var tl = svg('text', { x: 24, y: plan.terrace.y + plan.terrace.h - 22, class: 'plan__label' }, root);
      tl.textContent = plan.terrace.label;
    }
    if (plan.water) {
      svg('rect', { x: -12, y: plan.water.y, width: plan.w + 24, height: plan.water.h + 12, class: 'plan__water' }, root);
      var wl = svg('text', { x: plan.w / 2, y: plan.water.y + 32, class: 'plan__label plan__label--center plan__label--water' }, root);
      wl.textContent = plan.water.label;
    }

    // Пол и стены зала.
    svg('rect', { x: 0, y: 0, width: plan.w, height: hallH, class: 'plan__floor' }, root);
    (plan.rooms || []).forEach(function (rm) {
      svg('rect', { x: rm.x, y: rm.y, width: rm.w, height: rm.h, class: 'plan__room', fill: 'url(#hatch)' }, root);
      svg('rect', { x: rm.x, y: rm.y, width: rm.w, height: rm.h, class: 'plan__room-wall' }, root);
      var l = svg('text', { x: rm.x + rm.w / 2, y: rm.y + rm.h / 2 + 8, class: 'plan__label plan__label--center plan__label--room' }, root);
      l.textContent = rm.label;
    });
    svg('rect', { x: 0, y: 0, width: plan.w, height: hallH, class: 'plan__wall' }, root);

    // Окна — светлые проёмы в стене, двери — проём с дугой открывания.
    (plan.windows || []).forEach(function (w) {
      var g = wallGap(plan, w, hallH);
      svg('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: 'plan__window-gap' }, root);
      svg('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: 'plan__window' }, root);
    });
    (plan.doors || []).forEach(function (d) {
      var g = wallGap(plan, d, hallH);
      svg('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: 'plan__window-gap' }, root);
      // Дверь открывается внутрь зала, дверь на террасу — наружу.
      var inward = d.side === 'top' || d.side === 'left' || d.side === 'hallBottom' ? 1 : -1;
      var path;
      if (g.horiz) {
        path = 'M' + g.x1 + ' ' + g.y1 + ' L' + g.x1 + ' ' + (g.y1 + inward * d.width) +
          ' A' + d.width + ' ' + d.width + ' 0 0 ' + (inward > 0 ? 0 : 1) + ' ' + g.x2 + ' ' + g.y2;
      } else {
        path = 'M' + g.x1 + ' ' + g.y1 + ' L' + (g.x1 + inward * d.width) + ' ' + g.y1 +
          ' A' + d.width + ' ' + d.width + ' 0 0 ' + (inward > 0 ? 1 : 0) + ' ' + g.x2 + ' ' + g.y2;
      }
      svg('path', { d: path, class: 'plan__door' }, root);
      var lx = g.horiz ? (g.x1 + g.x2) / 2 : g.x1 + inward * (d.width + 70);
      var ly = g.horiz ? g.y1 + inward * (d.width + 34) : (g.y1 + g.y2) / 2 + 8;
      var dl = svg('text', { x: lx, y: ly, class: 'plan__label plan__label--center' }, root);
      dl.textContent = d.label;
    });

    (plan.sofas || []).forEach(function (sf) {
      svg('rect', { x: sf.x, y: sf.y, width: sf.w, height: sf.h, rx: 16, class: 'plan__sofa' }, root);
    });
    (plan.bars || []).forEach(function (b) {
      svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 12, class: 'plan__bar' }, root);
      var vertical = b.h > b.w;
      for (var i = 0; i < b.stools; i++) {
        var sx = vertical ? b.x - 30 : b.x + b.w * (i + 1) / (b.stools + 1);
        var sy = vertical ? b.y + b.h * (i + 1) / (b.stools + 1) : b.y - 30;
        svg('circle', { cx: sx, cy: sy, r: 16, class: 'plan__stool' }, root);
      }
      var bl = svg('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + 8, class: 'plan__label plan__label--center',
        transform: vertical ? 'rotate(-90 ' + (b.x + b.w / 2) + ' ' + (b.y + b.h / 2) + ')' : '' }, root);
      bl.textContent = b.label;
    });
    (plan.labels || []).forEach(function (lb) {
      var el = svg('text', { x: lb.x, y: lb.y, class: 'plan__label plan__label--center plan__label--soft' }, root);
      el.textContent = lb.text;
    });

    // Столы: стулья, столешница, номер. Занятые и маленькие для компании не нажимаются.
    plan.tables.forEach(function (tb) {
      var free = tableFree(place, tb);
      var fits = tb.seats >= state.book.guests;
      var mine = state.book.table && state.book.table.id === tb.id;
      var enabled = state.book.slot != null && free && fits;
      var g = svg('g', { class: 'plan__table' + (mine ? ' is-mine' : '') + (!free ? ' is-busy' : '') + (!fits ? ' is-small' : '') }, root);
      drawChairs(g, tb);
      if (tb.shape === 'round') svg('circle', { cx: tb.x, cy: tb.y, r: tb.r, class: 'plan__top' }, g);
      else svg('rect', { x: tb.x - tb.w / 2, y: tb.y - tb.h / 2, width: tb.w, height: tb.h, rx: 12, class: 'plan__top' }, g);
      if (!free) {
        if (tb.shape === 'round') svg('circle', { cx: tb.x, cy: tb.y, r: tb.r, fill: 'url(#hatch)', class: 'plan__busy' }, g);
        else svg('rect', { x: tb.x - tb.w / 2, y: tb.y - tb.h / 2, width: tb.w, height: tb.h, rx: 12, fill: 'url(#hatch)', class: 'plan__busy' }, g);
      }
      var num = svg('text', { x: tb.x, y: tb.y + 14, class: 'plan__num' }, g);
      num.textContent = tb.id;
      var label = tableText('order_table_label', tb);
      if (!free) label += ', ' + t.order_busy;
      else if (!fits) label += ', ' + t.book_table_small;
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', label);
      g.setAttribute('aria-pressed', String(!!mine));
      g.setAttribute('aria-disabled', String(!enabled));
      if (enabled) {
        g.setAttribute('tabindex', '0');
        var pick = function () {
          state.book.table = tb;
          renderPlan(place);
          var again = $('.plan [aria-pressed="true"]');
          if (again) again.focus({ preventScroll: true });
        };
        g.addEventListener('click', pick);
        g.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
      }
    });

    $('.plan__status').textContent = state.book.slot == null ? t.book_table_need_time
      : state.book.table ? tableText('order_table_chosen', state.book.table) : t.book_table_hint;
    box.classList.toggle('plan--waiting', state.book.slot == null);
    updateSend(place);
  }

  function renderOrderLines(place) {
    var box = $('.order-lines');
    var lines = cartLines(place);
    box.innerHTML = '';
    box.hidden = lines.length === 0;
    $('.order__total').hidden = lines.length === 0;
    $('.order__empty').hidden = lines.length > 0;
    $('.order__pick').hidden = lines.length > 0;
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

  function whenText() {
    var t = state.texts;
    var bk = state.book;
    var time = hhmm(bk.slot);
    if (bk.day === 0) return fmt(t.when_today, { time: time });
    if (bk.day === 1) return fmt(t.when_tomorrow, { time: time });
    var date = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(state.bookDays[bk.day]).replace('.', '');
    return fmt(t.when_date, { date: date, time: time });
  }

  function updateSend(place) {
    if (!state.book) return;
    var t = state.texts;
    var btn = $('.send');
    var totals = cartTotals(place);
    var need = state.book.slot == null ? t.send_need_time : !state.book.table ? t.send_need_table : null;
    btn.disabled = !!need;
    btn.textContent = need || (totals.count
      ? fmt(t.book_send_order, { sum: price(totals.sum) })
      : fmt(t.book_send, { when: whenText() }));
  }

  function sendOrder() {
    // Из Телеграма бронь уйдёт боту — это следующий шаг. На обычном сайте
    // объясняем, что брони идут через Телеграм, и даём ссылку на бота.
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
      var wantOrder = parts[1] === 'book';
      if (wantOrder && order.hidden) {
        renderBooking(place);
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
    location.hash = encodeURIComponent(state.place) + '/book';
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
    $('.sheet__book').addEventListener('click', function () {
      if (!state.selected) return;
      openPlace(state.selected);
      setTimeout(openOrder, 0);
    });
    $('.place__book').addEventListener('click', openOrder);
    $('.order__pick').addEventListener('click', closeOrder);
    $('.guests__less').addEventListener('click', function () { changeGuests(-1); });
    $('.guests__more').addEventListener('click', function () { changeGuests(1); });
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
    $('.guests__less').setAttribute('aria-label', t.book_less);
    $('.guests__more').setAttribute('aria-label', t.book_more);
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
