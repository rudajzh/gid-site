// Лента, поиск блюд, исключения и набор блюд — orders/gid/search.md, scenario.md (экран 6).
// Логика поиска — js/search.js, здесь только экран. Запускает app.js: GidFeed.init(api).
// Вкус гостя, исключения и набор живут в браузере (localStorage): аккаунтов пока нет.

(function () {
  'use strict';

  var api, t, engine;
  var S = { ex: null, set: [], view: null, query: '', suggesting: false, pushed: false, setPushed: false,
    resTab: 'dishes', alsoOpen: false, draft: null };

  var I = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    near: '<path d="M5 9.5c2.3-2 4.7 2 7 0s4.7-2 7 0M5 15.5c2.3-2 4.7 2 7 0s4.7-2 7 0"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    back: '<path d="M15 18l-6-6 6-6"/>'
  };

  function $(sel, root) { return (root || document).querySelector(sel); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(name, size, width) {
    return '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (width || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>';
  }

  function button(cls, html, onClick, label) {
    var b = el('button', cls);
    b.type = 'button';
    if (html != null) b.innerHTML = html;
    if (label) b.setAttribute('aria-label', label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function withText(node, text) { var s = el('span', null, text); node.appendChild(s); return node; }

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function fmt(key, vars) { return api.fmt(t[key], vars || {}); }
  function dishesWord(n) { return api.plural(n, t.dishes); }

  function distance(m) {
    if (m < 1000) return fmt('metres', { n: Math.max(50, Math.round(m / 50) * 50) });
    return fmt('km', { n: (Math.round(m / 100) / 10).toLocaleString('ru-RU') });
  }

  // Исключения гостя

  function exClean(v) {
    v = v || {};
    return { allergens: v.allergens || [], diets: v.diets || [], custom: v.custom || [] };
  }

  function exSize(ex) { return ex.allergens.length + ex.diets.length + ex.custom.length; }

  function exNames(ex) {
    var names = [];
    engine.allergens.forEach(function (a) { if (ex.allergens.indexOf(a.id) >= 0) names.push(a.word); });
    engine.diets.forEach(function (d) { if (ex.diets.indexOf(d.id) >= 0) names.push(d.word); });
    ex.custom.forEach(function (c) { names.push(c.label); });
    return names;
  }

  function exChip() {
    if (!exSize(S.ex)) return null;
    var b = button('fchip fchip--detail', svg('ban', 16), openEx);
    return withText(b, fmt('ex_chip', { list: exNames(S.ex).join(', ') }));
  }

  // Вкус гостя: запросы и блюда, которые он открывал, добавлял в заказ и заказывал.
  // Вес со временем тает вдвое за две недели.

  var DAY = 864e5;

  function taste() {
    var v = load('taste', null);
    return v && v.queries && v.likes ? v : { queries: [], likes: [] };
  }

  function fade(time) { return Math.pow(0.5, (Date.now() - time) / (14 * DAY)); }

  function profile() {
    var v = taste();
    return {
      queries: v.queries.map(function (q) { return { q: q.q, w: 1.5 * fade(q.t) }; }),
      likes: v.likes.map(function (l) { return { key: l.key, w: l.w * fade(l.t) }; })
    };
  }

  function rememberQuery(q) {
    var v = taste();
    var n = window.GidSearch.norm(q);
    v.queries = v.queries.filter(function (x) { return window.GidSearch.norm(x.q) !== n; });
    v.queries.unshift({ q: q, t: Date.now() });
    v.queries = v.queries.slice(0, 10);
    save('taste', v);
  }

  function rememberDish(key, w) {
    var v = taste();
    var old = v.likes.filter(function (l) { return l.key === key; })[0];
    v.likes = v.likes.filter(function (l) { return l.key !== key; });
    v.likes.unshift({ key: key, t: Date.now(), w: Math.min(6, (old ? old.w * fade(old.t) : 0) + w) });
    v.likes = v.likes.slice(0, 30);
    save('taste', v);
  }

  // Карточки блюд

  function thumb(dish, cls) {
    if (dish.item.photo) {
      var img = el('img', cls);
      img.src = dish.item.photo;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      return img;
    }
    var mono = el('span', cls + ' fmono', dish.item.name.charAt(0));
    mono.setAttribute('aria-hidden', 'true');
    return mono;
  }

  function openDish(dish) {
    rememberDish(dish.key, 1);
    api.openDish(dish.place.id, dish.item.name);
  }

  function reasonText(rec) {
    var r = rec.reason;
    if (r.type === 'query') return fmt('rec_query', { q: r.q });
    if (r.type === 'like') return fmt('rec_like', { name: r.name });
    if (r.type === 'tag') return t['rec_' + r.tag];
    return t.rec_checked;
  }

  function badges(dish) {
    var box = el('span', 'fbig__badges');
    ['autumn', 'new'].forEach(function (tag) { if (dish.tags[tag]) box.appendChild(el('span', 'fbadge', t['tag_' + tag])); });
    return box;
  }

  function bigCard(rec) {
    var d = rec.dish;
    var b = button('fcard fbig', null, function () { openDish(d); });
    b.appendChild(thumb(d, 'fbig__img'));
    b.appendChild(badges(d));
    var body = el('span', 'fbig__body');
    var top = el('span', 'fline');
    top.append(el('span', 'fline__name', d.item.name), el('span', 'fline__sum', api.price(d.item.price)));
    var where = el('span', 'fwhere');
    where.append(el('b', null, d.place.name), document.createTextNode(' · ' + d.place.area));
    body.append(top, where, el('span', 'freason', reasonText(rec)));
    b.appendChild(body);
    return b;
  }

  function tile(rec, showReason) {
    var d = rec.dish;
    var b = button('fcard ftile', null, function () { openDish(d); });
    b.appendChild(thumb(d, 'ftile__img'));
    var body = el('span', 'ftile__body');
    body.append(el('span', 'ftile__name', d.item.name), el('span', 'ftile__meta', d.place.name + ' · ' + api.price(d.item.price)));
    if (showReason) body.appendChild(el('span', 'freason freason--sm', reasonText(rec)));
    b.appendChild(body);
    return b;
  }

  function label(text, count) {
    var h = el('h2', 'order__label flabel', text);
    if (count != null) h.appendChild(el('span', 'flabel__count', String(count)));
    return h;
  }

  // Лента без запроса: «Для Вас» (или «Попробуйте», пока о госте ничего не знаем),
  // осеннее меню и все блюда — всё без исключённого гостем.

  function renderHome() {
    var box = $('.feed__home');
    box.innerHTML = '';
    var tools = el('div', 'feed__tools');
    tools.appendChild(withText(button('fchip fchip--ghost', svg('plus', 16), goSet), t.set_open));
    var chip = exChip();
    if (chip) tools.appendChild(chip);
    box.appendChild(tools);

    var quick = el('div', 'feed__quick');
    t.feed_quick.forEach(function (q) {
      quick.appendChild(button('fchip fchip--sm', null, function () { submit(q); })).textContent = q;
    });
    box.appendChild(quick);

    var rec = engine.recommend(profile(), S.ex, { head: 5 });
    var list = rec.list.slice();
    // В большую карточку — первое из подборки блюдо с фото: без фото она пустая.
    var withPhoto = list.slice(0, 5).map(function (r) { return !!r.dish.item.photo; }).indexOf(true);
    if (withPhoto > 0) list.unshift(list.splice(withPhoto, 1)[0]);
    if (!list.length) {
      box.appendChild(el('p', 'feed__note', t.feed_empty));
      return;
    }
    box.appendChild(label(rec.cold ? t.feed_for_cold : t.feed_for));
    box.appendChild(el('p', 'feed__lead', rec.cold ? t.feed_for_cold_lead : t.feed_for_lead));
    box.appendChild(bigCard(list[0]));
    var grid = el('div', 'fgrid');
    list.slice(1, 5).forEach(function (r) { grid.appendChild(tile(r, true)); });
    box.appendChild(grid);

    var shown = {};
    list.slice(0, 5).forEach(function (r) { shown[r.dish.key] = true; });
    var season = list.filter(function (r) { return r.dish.tags.autumn && !shown[r.dish.key]; });
    if (season.length >= 2) {
      box.appendChild(label(t.feed_season));
      var row = el('div', 'frow');
      season.forEach(function (r) { row.appendChild(tile(r, false)); });
      box.appendChild(row);
    }
    var rest = list.slice(5);
    if (rest.length) {
      box.appendChild(label(t.feed_all, rest.length));
      var all = el('div', 'fgrid');
      rest.forEach(function (r) { all.appendChild(tile(r, false)); });
      box.appendChild(all);
    }
  }

  // Подсказки по мере ввода

  function chipText(u) {
    if (u.type === 'price') return { kind: '', text: fmt('chip_price', { price: api.price(+u.name) }) };
    if (u.not) return { kind: t.chip_without, text: u.gen };
    if (u.type === 'product') return { kind: t.chip_with, text: u.ins };
    if (u.type === 'kind') return { kind: t.chip_kind, text: u.name };
    if (u.type === 'place') return { kind: t.chip_place, text: u.name };
    return { kind: '', text: u.name };
  }

  function tokenChip(u, onRemove) {
    var c = chipText(u);
    var chip = el('span', 'ftoken');
    if (c.kind) chip.appendChild(el('span', 'ftoken__kind', c.kind));
    chip.appendChild(el('span', null, c.text));
    if (onRemove) chip.appendChild(button('ftoken__x', svg('x', 14, 2.2), onRemove, fmt('chip_remove', { name: c.text })));
    return chip;
  }

  function counts(x) {
    var bits = [];
    if (x.exact) bits.push(fmt('sugg_exact', { n: x.exact }));
    if (x.near) bits.push(fmt(x.exact ? 'sugg_near' : 'sugg_near_only', { n: x.near }));
    var line = bits.join(', ');
    if (x.places) line += ' · ' + x.places + ' ' + api.plural(x.places, t.places_forms);
    return line;
  }

  function suggRow(iconHtml, main, sub, onClick, side) {
    var b = button('fsugg', null, onClick);
    var ic = el('span', 'fsugg__icon');
    ic.innerHTML = iconHtml;
    var text = el('span', 'fsugg__text');
    text.appendChild(main);
    if (sub) text.appendChild(el('span', 'fsugg__sub', sub));
    b.append(ic, text);
    if (side != null) b.appendChild(el('span', 'fsugg__n', String(side)));
    return b;
  }

  function kicker(text) { return el('p', 'fkicker', text); }

  function chipsOf(list, iconName) {
    var row = el('div', 'fchips');
    list.forEach(function (q) {
      var b = button('fchip fchip--sm', iconName ? svg(iconName, 15, 1.8) : '', function () { submit(q); });
      row.appendChild(withText(b, q));
    });
    return row;
  }

  function renderSuggest(text) {
    var box = $('.feed__suggest');
    box.innerHTML = '';
    var q = text.trim();
    if (!q) {
      var recent = taste().queries.slice(0, 6).map(function (x) { return x.q; });
      if (recent.length) { box.appendChild(kicker(t.sugg_recent)); box.appendChild(chipsOf(recent, 'clock')); }
      box.appendChild(kicker(t.sugg_popular));
      box.appendChild(chipsOf(t.feed_quick));
      return;
    }
    var s = engine.suggest(q, S.ex);
    if (s.understood.length) {
      var row = el('div', 'fchips fchips--understood');
      row.appendChild(el('span', 'fchips__label', t.sugg_understood));
      s.understood.forEach(function (u) { row.appendChild(tokenChip(u)); });
      box.appendChild(row);
    }
    var card = el('div', 'fcard fsugg-card');
    s.queries.forEach(function (x) {
      var main = el('span', 'fsugg__main');
      var cut = x.text.lastIndexOf(' ');
      main.append(document.createTextNode(cut > 0 ? x.text.slice(0, cut + 1) : ''), el('b', null, cut > 0 ? x.text.slice(cut + 1) : x.text));
      card.appendChild(suggRow(svg('search', 18, 1.8), main, counts(x), function () { submit(x.text); }));
    });
    if (!s.queries.length) {
      card.appendChild(suggRow(svg('search', 18, 1.8), el('span', 'fsugg__main', fmt('sugg_find', { q: q })), null, function () { submit(q); }));
    }
    box.appendChild(card);
    if (s.concepts.length) {
      box.appendChild(kicker(t.sugg_dishes));
      var c2 = el('div', 'fcard fsugg-card');
      s.concepts.forEach(function (c) {
        var sub = t['sugg_' + c.type] + ' · ' + c.sample.slice(0, 3).map(function (d) { return d.item.name.toLowerCase(); }).join(', ');
        c2.appendChild(suggRow('<span class="fsugg__letter">' + c.name.charAt(0).toUpperCase() + '</span>',
          el('span', 'fsugg__main', cap(c.name)), sub, function () { submit(c.name); }, c.count));
      });
      box.appendChild(c2);
    }
    if (s.places.length) {
      box.appendChild(kicker(t.sugg_places));
      var c3 = el('div', 'fcard fsugg-card');
      s.places.forEach(function (p) {
        c3.appendChild(suggRow('<span class="fsugg__letter fsugg__letter--round">' + p.name.charAt(0) + '</span>',
          el('span', 'fsugg__main fsugg__main--serif', p.name), p.cuisine + ' · ' + p.area, function () { api.openPlace(p.id); }));
      });
      box.appendChild(c3);
    }
  }

  // Выдача

  function compose(items, words) {
    var lead = [], withs = [], nots = [], tail = [];
    items.forEach(function (u) {
      if (u.type === 'price') tail.push('до ' + u.name);
      else if (u.not) nots.push(u.gen);
      else if (u.type === 'product') withs.push(u.ins);
      else lead.push(u.name);
    });
    var parts = lead.concat(words || []);
    if (withs.length) parts.push(t.chip_with + ' ' + withs.join(' и '));
    if (nots.length) parts.push(t.chip_without + ' ' + nots.join(' и '));
    return parts.concat(tail).join(' ').trim();
  }

  function why(w) {
    var chip = el('span', w.hit ? 'fwhy fwhy--hit' : 'fwhy fwhy--near');
    if (w.hit) { chip.innerHTML = svg('check', 13, 3); chip.appendChild(el('span', null, w.what)); }
    else chip.textContent = '≈ ' + fmt('why_near', { what: w.what, of: w.of });
    return chip;
  }

  function resultRow(r) {
    var d = r.dish;
    var b = button('fres', null, function () { openDish(d); });
    b.appendChild(thumb(d, 'fres__img'));
    var text = el('span', 'fres__text');
    var top = el('span', 'fline');
    top.append(el('span', 'fline__name', d.item.name), el('span', 'fline__sum', api.price(d.item.price)));
    var where = el('span', 'fwhere');
    where.append(el('b', null, d.place.name), document.createTextNode(' · ' + d.place.area));
    text.append(top, where);
    if (r.why.length) {
      var whys = el('span', 'fwhys');
      r.why.forEach(function (w) { whys.appendChild(why(w)); });
      text.appendChild(whys);
    }
    b.appendChild(text);
    return b;
  }

  function group(box, title, list, limit, onMore) {
    if (!list.length) return;
    box.appendChild(label(title, list.length));
    var card = el('div', 'fcard flist');
    list.slice(0, limit || list.length).forEach(function (r) { card.appendChild(resultRow(r)); });
    box.appendChild(card);
    if (limit && list.length > limit) {
      box.appendChild(button('button button--ghost fmore', null, onMore)).textContent = fmt('res_more', { n: list.length - limit });
    }
  }

  function noteLine(text, withChange) {
    var p = el('p', 'fnote');
    p.innerHTML = svg('ban', 16);
    p.appendChild(el('span', 'fnote__text', text));
    if (withChange) p.appendChild(button('flink', null, openEx)).textContent = t.res_change;
    return p;
  }

  function placeCard(row) {
    var b = button('fcard fplace', null, function () { api.openPlace(row.place.id); });
    var head = el('span', 'fplace__head');
    var names = el('span', 'fplace__names');
    names.append(el('span', 'fplace__name', row.place.name), el('span', 'fplace__sub', row.place.cuisine + ' · ' + row.place.area));
    head.append(names, el('span', 'fbadge fbadge--line', row.results.length + ' ' + dishesWord(row.results.length)));
    b.appendChild(head);
    var picks = el('span', 'fpicks');
    row.results.slice(0, 3).forEach(function (r) {
      var line = el('span', 'fpick');
      var mark = el('span', 'fpick__mark ' + (r.group === 'exact' ? 'fpick__mark--hit' : 'fpick__mark--near'));
      mark.innerHTML = svg(r.group === 'exact' ? 'check' : 'near', 12, 3);
      line.append(mark, el('span', 'fpick__name', r.dish.item.name), el('span', 'fpick__sum', api.price(r.dish.item.price)));
      picks.appendChild(line);
    });
    if (row.results.length > 3) {
      var more = row.results.length - 3;
      picks.appendChild(el('span', 'fpick__more', fmt('res_place_more', { n: more, dishes: dishesWord(more) })));
    }
    b.appendChild(picks);
    return b;
  }

  function renderResults(q) {
    var box = $('.feed__results');
    box.innerHTML = '';
    var r = engine.search(q, S.ex);
    var P = r.parsed;
    if (P.understood.length) {
      var row = el('div', 'fchips fchips--tokens');
      P.understood.forEach(function (u, i) {
        row.appendChild(tokenChip(u, function () {
          var next = compose(P.understood.filter(function (_, j) { return j !== i; }), P.words);
          if (next) submit(next); else goHome();
        }));
      });
      box.appendChild(row);
    }
    if (r.hidden) box.appendChild(noteLine(fmt('res_hidden', { n: r.hidden, dishes: dishesWord(r.hidden), what: r.hiddenBy.join(' или ') }), true));
    if (r.unconfirmed) box.appendChild(noteLine(fmt('res_unconfirmed', { n: r.unconfirmed, dishes: dishesWord(r.unconfirmed) }), !r.hidden));

    if (!r.exact.length && !r.near.length && !r.also.length) {
      var empty = el('div', 'fempty');
      empty.append(el('h2', 'order__label', t.res_empty), el('p', 'feed__note', t.res_empty_hint));
      if (r.conflict.length) {
        empty.appendChild(el('p', 'feed__note feed__note--detail', fmt('res_conflict', { what: cap(r.conflict.join(', ')) })));
        empty.appendChild(button('button button--ghost fmore', null, openEx)).textContent = t.ex_title;
      }
      box.appendChild(empty);
      return;
    }

    var places = engine.placesOf(r);
    var seg = el('div', 'mode fseg');
    seg.setAttribute('role', 'radiogroup');
    [['dishes', fmt('res_tab_dishes', { n: r.exact.length + r.near.length + r.also.length })],
      ['places', fmt('res_tab_places', { n: places.length })]].forEach(function (tab) {
      var b = button('mode__btn', null, function () { S.resTab = tab[0]; renderResults(q); });
      b.textContent = tab[1];
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(S.resTab === tab[0]));
      seg.appendChild(b);
    });
    if (places.length) box.appendChild(seg);

    if (S.resTab === 'places' && places.length) {
      places.forEach(function (row) { box.appendChild(placeCard(row)); });
      return;
    }
    group(box, t.res_exact, r.exact);
    group(box, t.res_near, r.near);
    var prod = P.products[0] && engine.info('product', P.products[0]);
    group(box, prod ? fmt('res_also', { what: prod.ins }) : t.res_also_plain, r.also, S.alsoOpen ? 0 : 3,
      function () { S.alsoOpen = true; renderResults(q); });
  }

  // Набор блюд: несколько желаний — рестораны, где есть всё.

  function pickLine(p) {
    var line = el('span', 'fpick');
    var mark = el('span', 'fpick__mark');
    var name = el('span', 'fpick__name');
    if (p.result) {
      var exact = p.result.group === 'exact';
      mark.classList.add(exact ? 'fpick__mark--hit' : 'fpick__mark--near');
      mark.innerHTML = svg(exact ? 'check' : 'near', 12, 3);
      name.textContent = p.result.dish.item.name;
      if (!exact) name.appendChild(el('small', null, fmt('set_near', { wish: p.wish })));
      line.append(mark, name, el('span', 'fpick__sum', api.price(p.result.dish.item.price)));
    } else {
      mark.classList.add('fpick__mark--no');
      mark.innerHTML = svg('minus', 12, 3);
      name.classList.add('fpick__name--no');
      name.textContent = fmt('set_missing', { wish: p.wish });
      if (p.elsewhere) name.appendChild(el('small', null, fmt('set_elsewhere', { place: p.elsewhere.place.name, dist: distance(p.elsewhere.metres) })));
      line.append(mark, name);
    }
    return line;
  }

  function setCard(row, total) {
    var b = button('fcard fplace', null, function () {
      var names = [];
      row.picks.forEach(function (p) {
        if (!p.result) return;
        names.push(p.result.dish.item.name);
        rememberDish(p.result.dish.key, 1);
      });
      api.openSet(row.place.id, names);
    });
    var head = el('span', 'fplace__head');
    var names = el('span', 'fplace__names');
    names.append(el('span', 'fplace__name', row.place.name), el('span', 'fplace__sub', row.place.cuisine + ' · ' + row.place.area));
    var all = row.covered === total;
    head.append(names, el('span', all ? 'fbadge fbadge--accent' : 'fbadge fbadge--line', fmt('set_covered', { n: row.covered, total: total })));
    var picks = el('span', 'fpicks');
    row.picks.forEach(function (p) { picks.appendChild(pickLine(p)); });
    var foot = el('span', 'fplace__foot');
    var open = el('span', 'fplace__open', t.set_open_place);
    open.insertAdjacentHTML('beforeend', svg('next', 16));
    foot.append(el('span', 'fplace__total', fmt('set_total', { sum: api.price(row.total) })), open);
    b.append(head, picks, foot);
    return b;
  }

  function saveSet() { save('set', S.set); }

  function renderSet() {
    var box = $('.feed-set__scroll');
    var hadFocus = document.activeElement && document.activeElement.classList.contains('fset__input');
    box.innerHTML = '';
    var head = el('header', 'fset__head');
    var title = el('h1', 'order__title', t.set_title);
    title.id = 'set-title';
    head.append(button('icon-button fset__back', svg('back', 22), setBack, t.search_back), title);
    box.appendChild(head);
    box.appendChild(el('p', 'order__place fset__lead', t.set_lead));

    var card = el('div', 'fcard fwishes');
    S.set.forEach(function (w, i) {
      var row = el('div', 'fwish');
      row.append(el('span', 'fwish__n', String(i + 1)), el('span', 'fwish__text', w),
        button('fwish__x', svg('x', 16), function () { S.set.splice(i, 1); saveSet(); renderSet(); }, fmt('set_remove', { name: w })));
      card.appendChild(row);
    });
    var form = el('form', 'fwish fwish--add');
    form.innerHTML = '<span class="fwish__n fwish__n--add">' + svg('plus', 14, 2.4) + '</span>';
    var input = el('input', 'fset__input');
    input.type = 'text';
    input.placeholder = t.set_add_placeholder;
    input.setAttribute('aria-label', t.set_add);
    input.enterKeyHint = 'done';
    input.autocomplete = 'off';
    form.appendChild(input);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v || S.set.length >= 6) return;
      S.set.push(v);
      saveSet();
      renderSet();
      $('.fset__input').focus();
    });
    card.appendChild(form);
    box.appendChild(card);
    if (hadFocus) input.focus();

    var chip = exChip();
    if (chip) { var tools = el('div', 'feed__tools'); tools.appendChild(chip); box.appendChild(tools); }

    if (!S.set.length) {
      box.appendChild(el('p', 'feed__note', t.set_empty));
      box.appendChild(button('button button--ghost fmore', null, function () {
        S.set = t.set_example_list.slice();
        saveSet();
        renderSet();
      })).textContent = t.set_example;
      return;
    }
    var rows = engine.searchSet(S.set, S.ex);
    if (!rows.length) { box.appendChild(el('p', 'feed__note', t.set_none)); return; }
    var total = S.set.length;
    var full = rows.filter(function (r) { return r.covered === total; });
    var part = rows.filter(function (r) { return r.covered < total; }).slice(0, 4);
    if (full.length) {
      box.appendChild(label(t.set_all, full.length));
      full.forEach(function (r) { box.appendChild(setCard(r, total)); });
    }
    if (part.length) {
      box.appendChild(label(t.set_some, part.length));
      part.forEach(function (r) { box.appendChild(setCard(r, total)); });
    }
  }

  // Шторка «Исключить»

  function exShowLabel() {
    var n = engine.dishes.filter(function (d) { return !engine.blockedBy(d, S.draft); }).length;
    $('.excl__show').textContent = fmt('ex_show', { n: n, dishes: dishesWord(n) });
  }

  function toggleChip(text, on, onToggle) {
    var b = button('fchip fchip--sm' + (on ? ' fchip--on' : ''), null, function () {
      var now = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(now));
      b.classList.toggle('fchip--on', now);
      onToggle(now);
      exShowLabel();
    });
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = svg('check', 14, 3);
    return withText(b, text);
  }

  function flip(list, id, on) {
    var i = list.indexOf(id);
    if (on && i < 0) list.push(id);
    if (!on && i >= 0) list.splice(i, 1);
  }

  function renderEx() {
    var d = S.draft;
    var body = $('.excl__body');
    body.innerHTML = '';
    var head = el('div', 'excl__head');
    var title = el('h2', 'excl__title', t.ex_title);
    title.id = 'excl-title';
    var reset = button('flink', null, function () { S.draft = exClean(); renderEx(); });
    reset.textContent = t.ex_reset;
    head.append(title, reset);
    body.append(head, el('p', 'excl__lead', t.ex_lead));

    body.appendChild(el('h3', 'excl__label', t.ex_allergy));
    var a = el('div', 'fchips');
    engine.allergens.forEach(function (x) {
      a.appendChild(toggleChip(x.name, d.allergens.indexOf(x.id) >= 0, function (on) { flip(d.allergens, x.id, on); }));
    });
    body.appendChild(a);

    body.appendChild(el('h3', 'excl__label', t.ex_diet));
    var b = el('div', 'fchips');
    engine.diets.forEach(function (x) {
      b.appendChild(toggleChip(x.name, d.diets.indexOf(x.id) >= 0, function (on) { flip(d.diets, x.id, on); }));
    });
    body.appendChild(b);

    body.appendChild(el('h3', 'excl__label', t.ex_custom));
    var form = el('form', 'excl__form');
    var input = el('input', 'excl__input');
    input.type = 'text';
    input.placeholder = t.ex_custom_placeholder;
    input.setAttribute('aria-label', t.ex_custom_add);
    input.enterKeyHint = 'done';
    input.autocomplete = 'off';
    form.append(input, button('excl__add', svg('plus', 18), null, t.ex_custom_add));
    form.lastChild.type = 'submit';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim().toLowerCase();
      if (!v || d.custom.some(function (c) { return c.label === v; })) return;
      var product = engine.product(v);
      d.custom.push(product ? { label: v, product: product } : { label: v, words: engine.tokens(v) });
      renderEx();
      $('.excl__input').focus();
    });
    body.appendChild(form);
    if (d.custom.length) {
      var c = el('div', 'fchips excl__custom');
      d.custom.forEach(function (x, i) {
        var chip = el('span', 'fchip fchip--sm fchip--on');
        chip.appendChild(el('span', null, x.label));
        chip.appendChild(button('ftoken__x', svg('x', 14, 2.4), function () { d.custom.splice(i, 1); renderEx(); }, fmt('ex_remove', { name: x.label })));
        c.appendChild(chip);
      });
      body.appendChild(c);
    }
    body.appendChild(el('p', 'excl__note', t.ex_note));
    exShowLabel();
  }

  function openEx() {
    S.draft = exClean(JSON.parse(JSON.stringify(S.ex)));
    renderEx();
    $('.excl__body').scrollTop = 0;
    $('.excl').hidden = false;
    $('.excl__title').setAttribute('tabindex', '-1');
    $('.excl__title').focus({ preventScroll: true });
  }

  // Закрытие шторки сохраняет выбор: что отмечено, то и действует.
  function closeEx() {
    if ($('.excl').hidden) return;
    S.ex = exClean(S.draft);
    save('exclude', S.ex);
    $('.excl').hidden = true;
    rerender();
  }

  // Переходы

  function scrollTop() { $('.feed__scroll').scrollTop = 0; }

  function showPanel(name) {
    $('.feed__home').hidden = name !== 'home';
    $('.feed__results').hidden = name !== 'results';
    $('.feed__suggest').hidden = name !== 'suggest';
    $('.feed__head').hidden = name !== 'home';
  }

  function updateBar() {
    var input = $('.fsearch__input');
    $('.feed__back').hidden = !(S.suggesting || S.view === 'results');
    $('.fsearch__clear').hidden = !input.value;
    var n = exSize(S.ex);
    var count = $('.fsearch__count');
    count.hidden = !n;
    count.textContent = n;
    $('.fsearch__ex').setAttribute('aria-label', t.ex_button + (n ? ': ' + n : ''));
  }

  function submit(q) {
    q = String(q).trim();
    if (!q) return;
    rememberQuery(q);
    var input = $('.fsearch__input');
    input.blur();
    S.suggesting = false;
    S.alsoOpen = false;
    S.resTab = 'dishes';
    var hash = '#feed/q/' + encodeURIComponent(q);
    if (S.view === 'results') {
      history.replaceState(null, '', hash);
      api.showRoute();
    } else {
      S.pushed = true;
      location.hash = hash;
    }
  }

  function goHome() {
    S.suggesting = false;
    if (S.pushed) { S.pushed = false; history.back(); }
    else { history.replaceState(null, '', '#feed'); api.showRoute(); }
  }

  function goSet() {
    S.setPushed = true;
    location.hash = '#feed/set';
  }

  function setBack() {
    if (S.setPushed) { S.setPushed = false; history.back(); }
    else { history.replaceState(null, '', '#feed'); api.showRoute(); }
  }

  function enterSuggest() {
    if (S.suggesting) return;
    S.suggesting = true;
    renderSuggest($('.fsearch__input').value);
    showPanel('suggest');
    updateBar();
  }

  function exitSuggest() {
    S.suggesting = false;
    var input = $('.fsearch__input');
    input.value = S.view === 'results' ? S.query : '';
    input.blur();
    showPanel(S.view);
    updateBar();
  }

  function rerender() {
    if (S.view === 'set') renderSet();
    else if (S.suggesting) renderSuggest($('.fsearch__input').value);
    else if (S.view === 'results') renderResults(S.query);
    else if (S.view === 'home') renderHome();
    updateBar();
  }

  // Вызывает app.js при каждом переходе: tab — открытая вкладка, parts — адрес после #feed.
  function route(tab, parts) {
    var feed = $('.feed'), setPage = $('.feed-set');
    if (tab !== 'feed') {
      setPage.hidden = true;
      // Над лентой открыт ресторан — запоминаем, где были; другая вкладка — начинаем заново.
      if (tab) {
        if (S.suggesting) exitSuggest();
        S.view = null;
      }
      return;
    }
    parts = parts || [];
    if (parts[0] === 'set') {
      feed.hidden = true;
      setPage.hidden = false;
      if (S.view !== 'set') setPage.querySelector('.tabpage__scroll').scrollTop = 0;
      S.view = 'set';
      renderSet();
      return;
    }
    setPage.hidden = true;
    S.suggesting = false;
    var input = $('.fsearch__input');
    if (parts[0] === 'q' && parts[1]) {
      var q = parts.slice(1).join('/');
      if (S.view !== 'results' || S.query !== q) scrollTop();
      S.view = 'results';
      S.query = q;
      input.value = q;
      renderResults(q);
      showPanel('results');
    } else {
      if (S.view !== 'home') scrollTop();
      S.view = 'home';
      input.value = '';
      renderHome();
      showPanel('home');
    }
    updateBar();
  }

  function escape() {
    if (!$('.excl').hidden) { closeEx(); return true; }
    if (S.suggesting) { exitSuggest(); return true; }
    if (S.view === 'results') { goHome(); return true; }
    if (S.view === 'set') { setBack(); return true; }
    return false;
  }

  function signal(type, placeId, name) {
    rememberDish(placeId + '|' + name, type === 'order' ? 3 : 2);
  }

  function bind() {
    var input = $('.fsearch__input');
    input.placeholder = t.search_placeholder;
    input.setAttribute('aria-label', t.search_label);
    $('.fsearch__clear').setAttribute('aria-label', t.search_clear);
    $('.feed__back').setAttribute('aria-label', t.search_back);
    input.addEventListener('focus', enterSuggest);
    input.addEventListener('input', function () {
      S.suggesting = true;
      renderSuggest(input.value);
      showPanel('suggest');
      updateBar();
    });
    // Недописанное «паста с крев» по Enter становится «паста с креветками», если поняли так же.
    $('.feed__bar').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      var key = function (text) {
        return JSON.stringify(engine.parse(text).understood.map(function (u) { return [u.type, u.id, u.not]; }));
      };
      var first = q && engine.suggest(q, S.ex).queries[0];
      submit(first && key(first.text) === key(q) ? first.text : q);
    });
    $('.fsearch__clear').addEventListener('click', function () {
      input.value = '';
      input.focus();
      S.suggesting = true;
      renderSuggest('');
      showPanel('suggest');
      updateBar();
    });
    $('.feed__back').addEventListener('click', function () { if (S.suggesting) exitSuggest(); else goHome(); });
    $('.fsearch__ex').addEventListener('click', openEx);
    $('.excl__scrim').addEventListener('click', closeEx);
    $('.excl__show').addEventListener('click', closeEx);
  }

  function init(a) {
    api = a;
    t = a.texts;
    engine = window.GidSearch.create(a.dictionary, a.places);
    S.ex = exClean(load('exclude', null));
    S.set = load('set', []).filter(function (x) { return typeof x === 'string'; }).slice(0, 6);
    bind();
  }

  window.GidFeed = { init: init, route: route, escape: escape, signal: signal };
})();
