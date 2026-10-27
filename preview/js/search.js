// Поиск по блюдам РестоГида — orders/gid/search.md. Только логика, без страницы:
// словарь (data/dictionary.json) + рестораны (data/places.json) → выдача, подсказки,
// набор блюд и рекомендации. Работает и в браузере (window.GidSearch), и в node (тесты).

(function (root) {
  'use strict';

  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  function tokens(s) { var n = norm(s); return n ? n.split(' ') : []; }

  // Расстояние Левенштейна с перестановкой соседних букв — для опечаток.
  function distance(a, b) {
    var d = [];
    for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  // Слово формы короче 4 букв совпадает только целиком, длиннее — как начало слова запроса.
  function wordFits(token, form) {
    return form.length <= 3 ? token === form : token.indexOf(form) === 0;
  }

  function fuzzyFits(token, form) {
    if (form.length < 4 || token.length < 4 || token[0] !== form[0]) return false;
    var limit = form.length >= 8 ? 2 : 1;
    for (var len = form.length - 1; len <= form.length + 1; len++) {
      if (len > token.length) break;
      if (distance(token.slice(0, len), form) <= limit) return true;
    }
    return false;
  }

  function metres(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // Простые продукты, которые есть почти везде: по ним блюда не считаем похожими.
  var BASIC = ['wheat', 'eggs', 'butter', 'milk', 'cream', 'garlic', 'onion', 'dill', 'herbs', 'lemon', 'lime',
    'sour-cream', 'vegetables', 'soy-sauce', 'sesame', 'bread', 'coffee'];

  function create(dict, places) {
    var kinds = dict.kinds, products = dict.products;
    var stop = {}; dict.stop.forEach(function (w) { stop[w] = true; });
    var without = {}; dict.without.forEach(function (w) { without[w] = true; });
    var allergenById = {}; dict.allergens.forEach(function (a) { allergenById[a.id] = a; });
    var dietById = {}; dict.diets.forEach(function (d) { dietById[d.id] = d; });
    var placeById = {}; places.forEach(function (p) { placeById[p.id] = p; });

    function ancestors(table, id) {
      var out = [], cur = id, guard = 0;
      while (cur && table[cur] && guard++ < 20) { out.push(cur); cur = table[cur].parent; }
      return out;
    }

    var pairs = {};
    dict.near.forEach(function (p) {
      (pairs[p[0]] = pairs[p[0]] || []).push(p[1]);
      (pairs[p[1]] = pairs[p[1]] || []).push(p[0]);
    });

    // Похожие на понятие: явные пары, братья в «семье» (вся паста, все раки и креветки)
    // и пары родителя (равиоли похожи на любую пасту).
    var nearCache = {};
    function nearOf(table, id) {
      var key = (table === kinds ? 'k:' : 'p:') + id;
      if (nearCache[key]) return nearCache[key];
      var set = {};
      (pairs[id] || []).forEach(function (x) { set[x] = true; });
      var parent = table[id] && table[id].parent;
      if (parent) {
        if (table[parent].family) Object.keys(table).forEach(function (k) { if (table[k].parent === parent && k !== id) set[k] = true; });
        (pairs[parent] || []).forEach(function (x) { set[x] = true; });
      }
      return (nearCache[key] = set);
    }

    // Продукты блюда: прямые с родителями и полные — вместе с тем, из чего сделаны соусы и хлеб.
    function expand(ids, deep) {
      var set = {};
      function add(id) {
        if (!products[id] || set[id]) return;
        ancestors(products, id).forEach(function (a) { set[a] = true; });
        if (deep) (products[id].contains || []).forEach(add);
      }
      ids.forEach(add);
      return set;
    }

    var dishes = [];
    places.forEach(function (place) {
      place.menu.forEach(function (section) {
        section.items.forEach(function (item) {
          if (!item.kind) return;
          var full = expand(item.has || [], true);
          var allergens = {};
          (item.allergens || []).forEach(function (a) { allergens[a] = true; });
          Object.keys(full).forEach(function (p) { (products[p].allergens || []).forEach(function (a) { allergens[a] = true; }); });
          var tags = {}; (item.tags || []).forEach(function (t) { tags[t] = true; });
          dishes.push({
            key: place.id + '|' + item.name, place: place, item: item, section: section.title,
            kindChain: ancestors(kinds, item.kind), direct: expand(item.has || [], false), full: full,
            allergens: allergens, tags: tags, confirmed: item.confirmed === true,
            words: tokens(item.name + ' ' + item.desc)
          });
        });
      });
    });
    var dishByKey = {}; dishes.forEach(function (d) { dishByKey[d.key] = d; });

    // Все формы словаря одним списком: блюда, продукты, кухни, рестораны, аллергены, «острое».
    var entries = [];
    function addForms(type, id, forms) {
      forms.forEach(function (f) { var w = tokens(f); if (w.length) entries.push({ type: type, id: id, words: w, size: f.length }); });
    }
    Object.keys(kinds).forEach(function (id) { addForms('kind', id, kinds[id].forms); });
    Object.keys(products).forEach(function (id) { addForms('product', id, products[id].forms); });
    Object.keys(dict.cuisines).forEach(function (id) { addForms('cuisine', id, dict.cuisines[id].forms); });
    dict.allergens.forEach(function (a) { addForms('allergen', a.id, a.forms); });
    dict.diets.forEach(function (d) {
      if (d.forms) addForms('tag', d.id, d.forms);
      if (d.veg) addForms('veg', d.id, d.veg);
    });
    places.forEach(function (p) {
      var words = tokens(p.name).map(function (w) { return w.length >= 5 ? w.slice(0, w.length - 1) : w; });
      entries.push({ type: 'place', id: p.id, words: words, size: words.join(' ').length + 100 });
    });
    var TYPE_RANK = { place: 6, kind: 5, product: 4, tag: 3, veg: 3, cuisine: 2, allergen: 1 };

    function bestAt(toks, i, used, fuzzy) {
      var best = null;
      entries.forEach(function (e) {
        if (i + e.words.length > toks.length) return;
        for (var j = 0; j < e.words.length; j++) {
          if (used[i + j]) return;
          var ok = fuzzy ? e.words.length === 1 && fuzzyFits(toks[i + j], e.words[j]) : wordFits(toks[i + j], e.words[j]);
          if (!ok) return;
        }
        var rank = e.words.length * 1000 + e.size * 10 + TYPE_RANK[e.type];
        if (!best || rank > best.rank) best = { entry: e, rank: rank };
      });
      return best && best.entry;
    }

    function nameOf(type, id) {
      if (type === 'kind') return kinds[id].name;
      if (type === 'product') return products[id].name;
      if (type === 'cuisine') return dict.cuisines[id].name;
      if (type === 'place') return placeById[id].name;
      if (type === 'allergen') return allergenById[id].word;
      return dietById[id].word;
    }

    function genOf(type, id) {
      if (type === 'kind') return kinds[id].gen;
      if (type === 'product') return products[id].gen;
      if (type === 'allergen') return allergenById[id].gen;
      if (type === 'tag' || type === 'veg') return dietById[id].gen;
      return nameOf(type, id);
    }

    function parse(text) {
      var toks = tokens(text);
      var P = { text: text, kinds: [], products: [], cuisines: [], places: [], tags: [], words: [],
        not: { products: [], allergens: [], diets: [] }, maxPrice: null, understood: [] };
      var used = {};
      toks.forEach(function (t, i) {
        if ((t === 'до' || t === 'дешевле') && /^\d+$/.test(toks[i + 1] || '')) {
          P.maxPrice = +toks[i + 1];
          used[i] = used[i + 1] = true;
          P.understood.push({ type: 'price', name: toks[i + 1] });
        }
      });
      var negate = false, loose = [];
      var i = 0;
      function take(e, neg) {
        var item = { type: e.type, id: e.id, name: nameOf(e.type, e.id), gen: genOf(e.type, e.id), not: neg };
        if (e.type === 'product') item.ins = products[e.id].ins;
        if (e.type === 'veg') { P.not.diets.push(e.id); item.type = 'diet'; item.not = true; }
        else if (neg) {
          if (e.type === 'product') P.not.products.push(e.id);
          else if (e.type === 'allergen') P.not.allergens.push(e.id);
          else if (e.type === 'tag') P.not.diets.push(e.id);
          else return;
        } else if (e.type === 'allergen') {
          return;
        } else {
          var list = { kind: P.kinds, product: P.products, cuisine: P.cuisines, place: P.places, tag: P.tags }[e.type];
          if (list.indexOf(e.id) < 0) list.push(e.id);
        }
        P.understood.push(item);
      }
      while (i < toks.length) {
        var t = toks[i];
        if (used[i]) { i++; continue; }
        if (without[t]) { negate = true; i++; continue; }
        if (t === 'с' || t === 'со') negate = false;
        if (stop[t]) { i++; continue; }
        var e = bestAt(toks, i, used, false);
        if (e) {
          for (var j = 0; j < e.words.length; j++) used[i + j] = true;
          take(e, negate);
          i += e.words.length;
        } else {
          loose.push({ i: i, neg: negate });
          i++;
        }
      }
      // Опечатки — только для слов, которые не нашлись как есть.
      loose.forEach(function (l) {
        var e = bestAt(toks, l.i, used, true);
        if (e) { used[l.i] = true; take(e, l.neg); }
        else if (!/^\d+$/.test(toks[l.i])) P.words.push(toks[l.i]);
      });
      return P;
    }

    // Исключения гостя: аллергены, «не ем», свои продукты. Без подтверждённого состава при
    // включённых исключениях блюдо не показываем вовсе.
    function blockedBy(d, ex) {
      if (!ex) return null;
      var any = false, hit = null;
      (ex.allergens || []).forEach(function (a) { any = true; if (!hit && d.allergens[a]) hit = allergenById[a] ? allergenById[a].word : a; });
      (ex.diets || []).forEach(function (id) {
        any = true;
        var diet = dietById[id];
        if (hit || !diet) return;
        if (diet.tag && d.tags[diet.tag]) hit = diet.word;
        (diet.products || []).forEach(function (p) { if (!hit && d.full[p]) hit = diet.word; });
      });
      (ex.custom || []).forEach(function (c) {
        any = true;
        if (hit) return;
        if (c.product && d.full[c.product]) hit = c.label;
        else if (!c.product && c.words && c.words.length && c.words.every(function (w) {
          return d.words.some(function (dw) { return dw.indexOf(w) === 0; });
        })) hit = c.label;
      });
      if (hit) return { label: hit };
      if (any && !d.confirmed) return { unconfirmed: true };
      return null;
    }

    function blockedByQuery(d, not) {
      if (not.allergens.some(function (a) { return d.allergens[a]; })) return true;
      if (not.products.some(function (p) {
        return d.full[p] || ancestors(products, p).some(function (a) {
          return (products[a].allergens || []).some(function (al) { return d.allergens[al]; });
        });
      })) return true;
      return not.diets.some(function (id) {
        var diet = dietById[id];
        if (diet.tag && d.tags[diet.tag]) return true;
        return (diet.products || []).some(function (p) { return d.full[p]; }) ||
          (id === 'meat' && (d.full.fish || d.full.seafood));
      });
    }

    function stemOf(w) { return w.length > 5 ? w.slice(0, w.length - 2) : w; }

    // Балл блюда по запросу: группа exact / near / also и подписи «за что».
    function score(d, P) {
      if (P.maxPrice && d.item.price > P.maxPrice) return null;
      if (blockedByQuery(d, P.not)) return null;
      if (P.places.length && P.places.indexOf(d.place.id) < 0) return null;
      if (P.cuisines.length && !P.cuisines.some(function (c) { return (d.place.kitchens || []).indexOf(c) >= 0; })) return null;
      if (P.tags.length && !P.tags.every(function (id) { return d.tags[dietById[id].tag]; })) return null;
      var why = [], parts = [];
      var k = null, p = null, w = null;
      if (P.kinds.length) {
        k = 0;
        P.kinds.forEach(function (q) {
          if (d.kindChain.indexOf(q) >= 0) { if (k < 1) { k = 1; why.push({ hit: true, what: kinds[q].name }); } return; }
          var near = nearOf(kinds, q);
          var m = d.kindChain.filter(function (x) { return near[x]; })[0];
          if (m && k < 0.7) { k = 0.7; why.push({ hit: false, what: kinds[d.item.kind].name, of: kinds[q].gen }); }
        });
        parts.push(k);
      }
      if (P.products.length) {
        var sum = 0;
        P.products.forEach(function (q) {
          if (d.full[q]) { sum += 1; why.push({ hit: true, what: products[q].name }); return; }
          var near = nearOf(products, q);
          var m = Object.keys(d.direct).filter(function (x) { return near[x]; })[0];
          if (m) { sum += 0.6; why.push({ hit: false, what: products[m].name, of: products[q].gen }); }
        });
        p = sum / P.products.length;
        parts.push(p);
      }
      if (P.words.length) {
        var found = P.words.filter(function (q) {
          var s = stemOf(q);
          return d.words.some(function (dw) { return dw.indexOf(s) === 0; });
        }).length;
        w = found / P.words.length;
      }
      var group;
      if (k === null && p === null) {
        if (w === null) group = 'exact';
        else if (w === 0) return null;
        else group = w === 1 ? 'exact' : 'near';
      } else if (k === 0) {
        if (p === 1) group = 'also'; else return null;
      } else if (p === 0) {
        return null;
      } else {
        var all = parts.every(function (x) { return x === 1; }) && (w === null || w === 1);
        group = all ? 'exact' : 'near';
      }
      if (w !== null) parts.push(w);
      var s = parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : 1;
      return { dish: d, group: group, score: s, why: group === 'also' ? why.filter(function (x) { return x.hit; }) : why };
    }

    function byScore(a, b) {
      return b.score - a.score || (a.dish.item.photo ? 0 : 1) - (b.dish.item.photo ? 0 : 1) || a.dish.item.price - b.dish.item.price;
    }

    function isEmpty(P) {
      return !P.kinds.length && !P.products.length && !P.cuisines.length && !P.places.length && !P.tags.length &&
        !P.words.length && !P.maxPrice && !P.not.products.length && !P.not.allergens.length && !P.not.diets.length;
    }

    function search(text, ex) {
      var P = typeof text === 'string' ? parse(text) : text;
      var out = { parsed: P, exact: [], near: [], also: [], hidden: 0, unconfirmed: 0, hiddenBy: [], conflict: [] };
      if (isEmpty(P)) return out;
      dishes.forEach(function (d) {
        var r = score(d, P);
        if (!r) return;
        var b = blockedBy(d, ex);
        if (b) {
          if (b.unconfirmed) out.unconfirmed++;
          else { out.hidden++; if (out.hiddenBy.indexOf(b.label) < 0) out.hiddenBy.push(b.label); }
          return;
        }
        out[r.group].push(r);
      });
      out.exact.sort(byScore); out.near.sort(byScore); out.also.sort(byScore);
      // Ищут то, что сами исключили: «креветки», когда выключены ракообразные.
      if (ex) P.products.forEach(function (q) {
        var al = {};
        ancestors(products, q).forEach(function (a) { (products[a].allergens || []).forEach(function (x) { al[x] = true; }); });
        (ex.allergens || []).forEach(function (a) { if (al[a] && out.conflict.indexOf(products[q].name) < 0) out.conflict.push(products[q].name); });
      });
      return out;
    }

    function count(res) { return res.exact.length + res.near.length; }

    function placesOf(res) {
      var map = {};
      res.exact.concat(res.near).forEach(function (r) {
        var id = r.dish.place.id;
        if (!map[id]) map[id] = { place: r.dish.place, results: [], exact: 0, best: 0 };
        map[id].results.push(r);
        if (r.group === 'exact') map[id].exact++;
        map[id].best = Math.max(map[id].best, r.score);
      });
      return Object.keys(map).map(function (id) { return map[id]; }).sort(function (a, b) {
        return b.exact - a.exact || b.best - a.best || b.results.length - a.results.length;
      });
    }

    // Подсказки по мере ввода: как поняли запрос, готовые запросы, понятия словаря и рестораны.
    function suggest(text, ex) {
      var toks = tokens(text);
      var out = { understood: parse(text).understood, queries: [], concepts: [], places: [] };
      if (!toks.length) return out;
      var last = toks[toks.length - 1];
      var head = toks.slice(0, -1);
      var prev = head[head.length - 1];
      var seen = {};
      var cands = [];
      if (last.length >= 2) {
        entries.forEach(function (e) {
          if (e.type === 'allergen' || e.type === 'veg') return;
          var first = e.words[0];
          var fits = first.indexOf(last) === 0 || wordFits(last, first) || (last.length >= 4 && fuzzyFits(last, first));
          if (!fits || seen[e.type + e.id]) return;
          seen[e.type + e.id] = true;
          cands.push(e);
        });
      }
      cands.forEach(function (e) {
        if (e.type === 'place') { out.places.push(placeById[e.id]); return; }
        var name = nameOf(e.type, e.id);
        var alone = search(name, ex);
        var n = count(alone);
        if (!n) return;
        out.concepts.push({ type: e.type, id: e.id, name: name, count: n,
          sample: alone.exact.concat(alone.near).slice(0, 4).map(function (r) { return r.dish; }) });
        if (head.length) {
          var word = e.type === 'product' && (prev === 'с' || prev === 'со') ? products[e.id].ins : name;
          var q = head.concat([word]).join(' ');
          var res = search(q, ex);
          var m = count(res);
          if (m) out.queries.push({ text: q, exact: res.exact.length, near: res.near.length, places: placesOf(res).length });
        }
      });
      out.concepts.sort(function (a, b) { return b.count - a.count; });
      out.concepts = out.concepts.slice(0, 4);
      out.queries.sort(function (a, b) { return b.exact - a.exact || b.near - a.near; });
      out.queries = out.queries.slice(0, 3);
      if (!out.queries.length && head.length) {
        var whole = search(text, ex);
        if (count(whole)) out.queries.push({ text: toks.join(' '), exact: whole.exact.length, near: whole.near.length, places: placesOf(whole).length });
      }
      out.places = out.places.slice(0, 2);
      return out;
    }

    // Набор: каждое желание — отдельный запрос; в каждом ресторане лучшее блюдо на желание.
    function searchSet(wishes, ex) {
      var per = wishes.map(function (w) { return search(w, ex); });
      var rows = places.map(function (place) {
        var picks = per.map(function (res, i) {
          var r = res.exact.concat(res.near).filter(function (x) { return x.dish.place.id === place.id; })[0] || null;
          return { wish: wishes[i], result: r };
        });
        var covered = picks.filter(function (p) { return p.result; }).length;
        var sum = picks.reduce(function (a, p) { return a + (p.result ? p.result.score : 0); }, 0);
        var total = picks.reduce(function (a, p) { return a + (p.result ? p.result.dish.item.price : 0); }, 0);
        picks.forEach(function (p, i) {
          if (p.result) return;
          // Где взять недостающее: ближайший ресторан, где оно есть точно, а если нигде — где похоже.
          var nearest = function (list) {
            var best = null;
            list.forEach(function (r) {
              var m = metres(place.coords, r.dish.place.coords);
              if (r.dish.place.id !== place.id && (!best || m < best.metres)) best = { place: r.dish.place, metres: m };
            });
            return best;
          };
          p.elsewhere = nearest(per[i].exact) || nearest(per[i].near);
        });
        return { place: place, picks: picks, covered: covered, sum: sum, total: total };
      }).filter(function (r) { return r.covered > 0; });
      rows.sort(function (a, b) { return b.covered - a.covered || b.sum - a.sum || a.total - b.total; });
      return rows;
    }

    // Похожесть двух блюд: вид блюда, общие продукты (кроме самых простых), тот же ресторан.
    function similarity(a, b) {
      var s = 0;
      if (a.item.kind === b.item.kind) s += 1;
      else {
        var near = nearOf(kinds, b.item.kind);
        if (a.kindChain.some(function (x) { return near[x]; })) s += 0.6;
        else if (a.kindChain.slice(1).some(function (x) { return b.kindChain.indexOf(x) > 0; })) s += 0.3;
      }
      var shared = (a.item.has || []).filter(function (p) { return BASIC.indexOf(p) < 0 && (b.item.has || []).indexOf(p) >= 0; }).length;
      s += Math.min(0.7, shared * 0.35);
      if (a.place.id === b.place.id) s += 0.15;
      return s;
    }

    // Рекомендации: по запросам гостя и блюдам, которые он открывал и добавлял в заказ.
    // profile = { queries: [{ q, w }], likes: [{ key, w }] }, вес уже с учётом давности.
    function recommend(profile, ex, opts) {
      opts = opts || {};
      var queries = (profile && profile.queries || []).map(function (q) { return { q: q.q, w: q.w, P: parse(q.q) }; });
      var likes = (profile && profile.likes || []).map(function (l) { return { d: dishByKey[l.key], w: l.w }; })
        .filter(function (l) { return l.d; });
      var cold = !queries.length && !likes.length;
      var list = [];
      dishes.forEach(function (d) {
        if (blockedBy(d, ex)) return;
        var s = 0, reason = null, top = 0, seen = false;
        queries.forEach(function (q) {
          var r = score(d, q.P);
          if (!r) return;
          var v = (r.group === 'exact' ? 1 : r.group === 'near' ? 0.6 : 0.35) * q.w;
          s += v;
          if (v > top) { top = v; reason = { type: 'query', q: q.q }; }
        });
        likes.forEach(function (l) {
          if (l.d === d) { seen = true; return; }
          var v = similarity(d, l.d) * l.w * 0.8;
          s += v;
          if (v > top) { top = v; reason = { type: 'like', name: l.d.item.name }; }
        });
        var base = (d.tags.autumn ? 0.5 : 0) + (d.tags.new ? 0.4 : 0) + (d.item.photo ? 0.3 : 0);
        if (seen) s -= 0.6;
        var total = s + base * (cold ? 1 : 0.5);
        if (!reason || cold) reason = d.tags.autumn ? { type: 'tag', tag: 'autumn' } : d.tags.new ? { type: 'tag', tag: 'new' } : { type: 'checked' };
        list.push({ dish: d, score: total, reason: reason, personal: !cold && top > 0 });
      });
      list.sort(function (a, b) { return b.score - a.score || a.dish.key.localeCompare(b.dish.key); });
      // Разнообразие: в первых строках — не больше двух блюд одного ресторана подряд.
      var cap = opts.perPlace || 2, head = [], rest = [], used = {};
      list.forEach(function (r) {
        var id = r.dish.place.id;
        if (head.length < (opts.head || 5) && (used[id] || 0) < cap) { head.push(r); used[id] = (used[id] || 0) + 1; }
        else rest.push(r);
      });
      return { cold: cold, list: head.concat(rest) };
    }

    return {
      dishes: dishes, dish: function (key) { return dishByKey[key]; }, parse: parse, search: search,
      suggest: suggest, placesOf: placesOf, searchSet: searchSet, recommend: recommend,
      blockedBy: blockedBy, metres: metres, product: function (text) {
        var toks = tokens(text);
        var e = toks.length && (bestAt(toks, 0, {}, false) || bestAt(toks, 0, {}, true));
        return e && e.type === 'product' && e.words.length === toks.length ? e.id : null;
      },
      allergens: dict.allergens, diets: dict.diets, tokens: tokens,
      info: function (type, id) { return type === 'kind' ? kinds[id] : type === 'product' ? products[id] : null; }
    };
  }

  var api = { create: create, norm: norm, tokens: tokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GidSearch = api;
})(this);
