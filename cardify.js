/*
 * Cardify (RUTUBE) — оформление полной карточки для Lampa.
 *
 * Основа — украинский мод Cardify. Изменения:
 *  - убраны обфускация, мёртвый код и блокировка bylampa.online;
 *  - фоновый трейлер берётся с RUTUBE вместо YouTube (поиск — как в плагине rutube_trailer:
 *    кэш trailer.rootu.top по TMDB id → поиск RUTUBE), играет через <video> + HLS;
 *  - трейлер и слайдшоу ставятся на паузу, пока открыт плеер или активна другая карточка;
 *  - интерфейс через Lampa.Lang (ru / uk / en).
 * Ключи настроек прежние (cardify_*), старые значения подхватятся.
 */
(function () {
	'use strict';

	if (window.cardify_rutube_plugin) return;
	window.cardify_rutube_plugin = true;

	// ---------------------------------------------------------------------------
	// Константы
	// ---------------------------------------------------------------------------

	var MAX_TRAILER_HEIGHT = 1080;      // потолок качества фонового трейлера (высота кадра)
	var TRAILER_START_TIMEOUT = 15000;  // мс ожидания старта видео, дальше — следующий ролик или слайдшоу
	var MAX_TRAILER_CANDIDATES = 3;     // сколько найденных роликов пробовать по очереди
	var ROOTU_CACHE_PATH = 'trailer.rootu.top/search/';
	var DEFAULT_SEARCH_PROXY = 'https://rutube-search.root-1a7.workers.dev/';
	var RUTUBE_URL_RE = /^https?:\/\/(?:www\.)?rutube\.ru\/(?:play\/embed|video\/private|video|shorts)\/([\da-f]{32,})/i;
	var DETAILS_TITLES = ['подробно', 'детально', 'details', 'detail'];

	// Слова, которые не штрафуются как «лишние» в названии ролика
	var EXTRA_QUERY_WORDS = [
		'4k', 'fullhd', 'ultrahd', 'ultra', 'hd', '1080p',
		'официальный', 'official', 'русский', 'на', 'русском', 'дублированный'
	];

	var SCORE = {
		EXACT_MATCH: 300,
		YEAR_MATCH: 100,
		WRONG_YEAR: -1000,
		NO_MATCH: -2000,
		WORD_MATCH: 100,
		EXTRA_WORD_PENALTY: 200,
		DURATION_BONUS: 50,
		DURATION_PENALTY: -50,
		MIN_RATE_THRESHOLD: 400
	};

	var SETTINGS_ICON =
		'<svg width="36" height="28" viewBox="0 0 36 28" fill="none" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/>' +
		'<rect x="5" y="14" width="17" height="4" rx="2" fill="white"/>' +
		'<rect x="5" y="20" width="10" height="3" rx="1.5" fill="white"/>' +
		'<rect x="25" y="20" width="6" height="3" rx="1.5" fill="white"/>' +
		'</svg>';

	// ---------------------------------------------------------------------------
	// Утилиты
	// ---------------------------------------------------------------------------

	function noop() {}

	function t(key) {
		return Lampa.Lang.translate(key);
	}

	function isOn(name) {
		var v = Lampa.Storage.field(name);
		return v === true || v === 'true';
	}

	function isOff(name) {
		var v = Lampa.Storage.field(name);
		return v === false || v === 'false';
	}

	function contentLang() {
		return Lampa.Storage.field('tmdb_lang') || Lampa.Storage.get('language', 'ru') || 'ru';
	}

	function cacheGet(key) {
		try {
			var raw = window.sessionStorage.getItem(key);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			try {
				window.sessionStorage.removeItem(key);
			} catch (e2) {}
			return null;
		}
	}

	function cacheSet(key, value) {
		try {
			window.sessionStorage.setItem(key, JSON.stringify(value));
		} catch (e) {}
	}

	function isYear(word) {
		if (!/^\d{4}$/.test(word)) return false;
		var y = parseInt(word, 10);
		return y >= 1900 && y <= new Date().getFullYear() + 2;
	}

	function cleanString(str) {
		return String(str || '')
			.replace(/[^a-zA-Z\dа-яА-ЯёЁ]+/g, ' ')
			.trim()
			.toLowerCase();
	}

	function rutubeId(url) {
		var m = String(url || '').match(RUTUBE_URL_RE);
		return m ? m[1] : '';
	}

	// ---------------------------------------------------------------------------
	// Поиск трейлеров на RUTUBE
	//
	// Порядок: sessionStorage → trailer.rootu.top/{movie|tv}/{tmdb7}.json →
	// поиск RUTUBE по «название год трейлер|trailer|тизер». В браузере поиск RUTUBE
	// режется CORS, тогда запросы идут через прокси (rutube_search_proxy в Storage
	// или прокси rootu по умолчанию). Ключ и формат sessionStorage совпадают с
	// плагином rutube_trailer, так что при установке обоих поиск делается один раз.
	// ---------------------------------------------------------------------------

	var searchProxy = '';

	function searchTrailers(movie, isTv, onSuccess, onFail) {
		var requests = [];
		var finished = false;

		function abort() {
			finished = true;
			requests.forEach(function (r) {
				try {
					r.clear();
				} catch (e) {}
			});
			requests = [];
		}

		function request() {
			var r = new Lampa.Reguest();
			requests.push(r);
			return r;
		}

		var year = String(movie.release_date || movie.first_air_date || '').replace(/\D+/g, '').substring(0, 4);
		if (!isYear(year)) year = '';

		var search = movie.title || movie.name || movie.original_title || movie.original_name || '';
		var searchOrig = movie.original_title || movie.original_name || '';
		var cleanSearch = cleanString(search);

		if (cleanSearch.length < 2) {
			onFail();
			return abort;
		}

		var tmdbId = movie.id ? '000000' + movie.id : '';
		if (tmdbId.length > 7) tmdbId = tmdbId.slice(-Math.max(7, String(movie.id).length));
		var type = isTv ? 'tv' : 'movie';
		var cacheKey = 'RUTUBE_trailer_' + type + (tmdbId || (Lampa.Utils.hash(search) * 1).toString(36));

		function done(list) {
			if (finished) return;
			finished = true;
			cacheSet(cacheKey, [true, list, search]);
			onSuccess(list);
		}

		function notFound() {
			if (finished) return;
			finished = true;
			cacheSet(cacheKey, [false, {}, search]);
			onFail();
		}

		function networkFail() {
			if (finished) return;
			finished = true;
			onFail();
		}

		var cached = cacheGet(cacheKey);
		if (cached) {
			if (cached[0] && cached[1] && cached[1].length) onSuccess(cached[1]);
			else onFail();
			finished = true;
			return abort;
		}

		function rate(r, queryWords) {
			var score = 0;
			var titleWords = r._title.split(' ');
			var idx = r._title.indexOf(cleanSearch);

			if (idx < 0) {
				score = SCORE.NO_MATCH;
			} else {
				score += SCORE.EXACT_MATCH;

				if (year) {
					// «Название 2», «Название II» сразу после названия — это сиквел
					var rest = r._title.substring(idx + cleanSearch.length).trim().split(' ');
					if (rest.length && rest[0] !== year && /^(\d+|[ivx]+)$/.test(rest[0])) score += SCORE.WRONG_YEAR;

					var years = titleWords.filter(isYear);
					if (years.indexOf(year) >= 0) {
						score += SCORE.YEAR_MATCH;
					} else {
						for (var i = 0; i < years.length; i++) {
							// чужой год, которого нет в самом названии, — другой фильм (ремейк, оригинал)
							if (cleanSearch.indexOf(years[i]) < 0) {
								score += SCORE.WRONG_YEAR;
								break;
							}
						}
					}
				}
			}

			var matching = titleWords.filter(function (w) {
				return queryWords.indexOf(w) >= 0;
			});
			score += matching.length * SCORE.WORD_MATCH - (titleWords.length - matching.length) * SCORE.EXTRA_WORD_PENALTY;
			score += r.duration > 120 ? SCORE.DURATION_BONUS : SCORE.DURATION_PENALTY;

			return score;
		}

		function filterResults(list, query) {
			var queryWords = query.split(' ');
			if (searchOrig && searchOrig !== search) queryWords = queryWords.concat(cleanString(searchOrig).split(' '));
			queryWords = queryWords.concat(isTv ? 'сериал' : 'фильм', EXTRA_QUERY_WORDS);

			return list
				.filter(function (r) {
					r._title = cleanString(r.title);
					var isTrailer = /трейлер|trailer|тизер|teaser/.test(r._title);
					var durationOk = r.duration && r.duration < 600;
					if (!r.embed_url || !isTrailer || !durationOk) return false;
					if (r.is_hidden || r.is_deleted || r.is_locked || r.is_audio || r.is_paid || r.is_livestream || r.is_adult) return false;
					r._rate = rate(r, queryWords);
					return r._rate > SCORE.MIN_RATE_THRESHOLD;
				})
				.sort(function (a, b) {
					return b._rate - a._rate;
				})
				.map(function (r) {
					// формат как в кэше rootu — его же читает rutube_trailer
					return {
						title: r.title,
						url: r.video_url || r.embed_url,
						thumbnail_url: r.thumbnail_url,
						duration: r.duration,
						author: r.author || { name: '' }
					};
				});
		}

		var trailerTypes = ['трейлер', 'trailer', 'тизер'];

		function searchStep(index) {
			if (finished) return;
			if (index >= trailerTypes.length) return notFound();

			var query = cleanString([search, year, trailerTypes[index], isTv ? 'сезон 1' : ''].join(' '));
			var url = 'https://rutube.ru/api/search/video/?query=' + encodeURIComponent(query) + '&format=json';
			var net = request();

			net.native(
				searchProxy + url,
				function (data) {
					var list = data && data.results && data.results.length ? filterResults(data.results, query) : [];
					if (list.length) done(list);
					else searchStep(index + 1);
				},
				function (xhr) {
					var corsBlocked = !!xhr && xhr.status === 0 && xhr.readyState === 0;
					if (!searchProxy && !window.AndroidJS && corsBlocked) {
						searchProxy = Lampa.Storage.get('rutube_search_proxy', '') || DEFAULT_SEARCH_PROXY;
						if (searchProxy.slice(-1) !== '/') searchProxy += '/';
						searchStep(index);
					} else {
						networkFail();
					}
				}
			);
		}

		if (tmdbId && !/\D/.test(tmdbId)) {
			var cacheNet = request();
			cacheNet.timeout(2000);
			cacheNet.native(
				Lampa.Utils.protocol() + ROOTU_CACHE_PATH + type + '/' + tmdbId + '.json',
				function (list) {
					if (list && list.length) done(list);
					else searchStep(0);
				},
				function () {
					searchStep(0);
				}
			);
		} else {
			searchStep(0);
		}

		return abort;
	}

	// ---------------------------------------------------------------------------
	// Поток RUTUBE: play/options → master m3u8 → вариант не выше MAX_TRAILER_HEIGHT
	// ---------------------------------------------------------------------------

	function pickVariant(masterUrl, callback) {
		var xhr = new XMLHttpRequest();
		var origin = (masterUrl.match(/^https?:\/\/[^\/]+/i) || [''])[0];
		var base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
		var called = false;

		function finish(url) {
			if (called) return;
			called = true;
			callback(url);
		}

		xhr.open('GET', masterUrl, true);
		xhr.timeout = 10000;
		xhr.onload = function () {
			if (xhr.status !== 200) return finish(masterUrl);

			var lines = String(xhr.responseText || '').split('\n');
			var streams = [];

			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim();
				if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;

				var next = (lines[i + 1] || '').trim();
				if (!next || next.charAt(0) === '#') continue;

				var res = line.match(/RESOLUTION=(\d+)x(\d+)/);
				var bw = line.match(/BANDWIDTH=(\d+)/);
				var url = /^https?:\/\//i.test(next) ? next : next.charAt(0) === '/' ? origin + next : base + next;

				streams.push({
					height: res ? parseInt(res[2], 10) : 0,
					bandwidth: bw ? parseInt(bw[1], 10) : 0,
					url: url
				});
			}

			if (!streams.length) return finish(masterUrl);

			var fit = streams
				.filter(function (s) {
					return s.height > 0 && s.height <= MAX_TRAILER_HEIGHT;
				})
				.sort(function (a, b) {
					return b.height - a.height || b.bandwidth - a.bandwidth;
				});

			if (fit.length) return finish(fit[0].url);

			// всё выше потолка или без RESOLUTION — берём самый лёгкий
			streams.sort(function (a, b) {
				return (a.height || a.bandwidth) - (b.height || b.bandwidth);
			});
			finish(streams[0].url);
		};
		xhr.onerror = xhr.ontimeout = function () {
			finish(masterUrl);
		};
		xhr.send();

		return xhr;
	}

	function resolveStream(videoId, onSuccess, onFail) {
		var net = new Lampa.Reguest();
		var xhr = null;
		var aborted = false;

		net.timeout(10000);
		net.native(
			'https://rutube.ru/api/play/options/' + videoId + '/?format=json&no_404=true',
			function (json) {
				if (aborted) return;
				var master = json && json.video_balancer && json.video_balancer.m3u8;
				if (!master) return onFail();
				xhr = pickVariant(master, function (url) {
					if (!aborted) onSuccess(url);
				});
			},
			function () {
				if (!aborted) onFail();
			}
		);

		return function abort() {
			aborted = true;
			try {
				net.clear();
			} catch (e) {}
			if (xhr) {
				try {
					xhr.abort();
				} catch (e) {}
			}
		};
	}

	// ---------------------------------------------------------------------------
	// Фоновое видео
	// ---------------------------------------------------------------------------

	function zoomScale(value) {
		if (value === true) value = '33'; // старый формат настройки (trigger)
		return 1 + (parseInt(value, 10) || 0) / 100;
	}

	function applyVideoLook(el) {
		var blur = parseInt(Lampa.Storage.field('cardify_trailers_blur'), 10) || 0;
		var scale = zoomScale(Lampa.Storage.field('cardify_trailers_zoom'));
		var filter = blur > 0 ? 'blur(' + blur + 'px)' : '';
		var transform = scale !== 1 ? 'scale(' + scale + ') translateZ(0)' : '';

		el.style.webkitFilter = filter;
		el.style.filter = filter;
		el.style.webkitTransform = transform;
		el.style.transform = transform;
	}

	function createBackgroundVideo(url, handlers) {
		var html = $(
			'<div class="cardify-trailer">' +
				'<video class="cardify-trailer__video" muted playsinline webkit-playsinline preload="auto"></video>' +
			'</div>'
		);
		var video = html.find('video')[0];
		var hls = null;
		var started = false;
		var dead = false;
		var startTimer = null;

		video.muted = true;
		video.loop = true;
		applyVideoLook(video);

		function fail() {
			if (dead) return;
			var wasStarted = started;
			destroy();
			handlers.onError(wasStarted);
		}

		function play() {
			if (dead) return;
			if (!started && !startTimer) startTimer = setTimeout(fail, TRAILER_START_TIMEOUT);
			try {
				var p = video.play();
				if (p && typeof p.catch === 'function') p.catch(noop);
			} catch (e) {}
		}

		function pause() {
			if (dead) return;
			if (!started) {
				clearTimeout(startTimer);
				startTimer = null;
			}
			try {
				video.pause();
			} catch (e) {}
		}

		function destroy() {
			if (dead) return;
			dead = true;
			clearTimeout(startTimer);
			if (hls) {
				try {
					hls.destroy();
				} catch (e) {}
				hls = null;
			}
			try {
				video.pause();
				video.removeAttribute('src');
				video.load();
			} catch (e) {}
			html.remove();
		}

		video.addEventListener('playing', function () {
			clearTimeout(startTimer);
			startTimer = null;
			if (started || dead) return;
			started = true;
			html.addClass('display');
			handlers.onStart();
		});

		// страховка на случай, если loop не сработал (hls.js на старых WebView)
		video.addEventListener('ended', function () {
			try {
				video.currentTime = 0;
			} catch (e) {}
			play();
		});

		video.addEventListener('error', fail);

		// Нативный HLS (Android WebView, Tizen, webOS) — легче для слабых приставок; иначе hls.js из Lampa
		var Hls = window.Hls;
		if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
			video.src = url;
		} else if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
			hls = new Hls({ maxBufferLength: 20, capLevelToPlayerSize: true });
			hls.on(Hls.Events.ERROR, function (event, data) {
				if (data && data.fatal) fail();
			});
			hls.loadSource(url);
			hls.attachMedia(video);
		} else {
			video.src = url;
		}

		return {
			render: function () {
				return html;
			},
			play: play,
			pause: pause,
			destroy: destroy
		};
	}

	// ---------------------------------------------------------------------------
	// Оформление карточки
	// ---------------------------------------------------------------------------

	function getBackdropPath(e, img) {
		var d = e.data || {};
		if (d.movie && d.movie.backdrop_path) return d.movie.backdrop_path;
		if (d.tv && d.tv.backdrop_path) return d.tv.backdrop_path;
		if (e.object && e.object.card && e.object.card.backdrop_path) return e.object.card.backdrop_path;

		var src = img.length ? img.attr('src') || '' : '';
		var m = src.match(/\/([^\/]+\.jpg)$/);
		return m ? '/' + m[1] : '';
	}

	// Подмена фона на backdrop в выбранном качестве (через TMDB-прокси Lampa)
	function loadOriginalPoster(e, render) {
		var img = render.find('img.full-start__background');
		var path = getBackdropPath(e, img);
		if (!path || !img.length) return path;

		var quality = Lampa.Storage.field('cardify_slideshow_quality') || 'w1280';
		var url = Lampa.TMDB.image('t/p/' + quality + path);

		img[0].onerror = function () {
			this.onerror = null; // защита от бесконечного цикла notfound
			this.src = './img/img_broken.svg';
		};

		var probe = new Image();
		probe.onload = function () {
			img.attr('src', url);
		};
		probe.onerror = noop;
		probe.src = url;

		return path;
	}

	// Строка «следующая серия» (span со «/») — отдельной строкой в конец деталей
	function moveNextEpisode(render) {
		var details = render.find('.full-start-new__details');
		if (!details.length) return;

		var span = null;
		details.children('span').each(function () {
			var $s = $(this);
			if (!$s.hasClass('full-start-new__split') && $s.text().indexOf('/') !== -1) {
				span = $s;
				return false;
			}
		});
		if (!span) return;

		var prev = span.prev('.full-start-new__split');
		var next = span.next('.full-start-new__split');
		span.detach();
		if (prev.length && next.length) {
			next.remove();
		} else {
			prev.remove();
			next.remove();
		}
		span.css('width', '100%');
		details.append(span);
	}

	// Описание — в правый верхний угол (только горизонтальный не мобильный экран)
	function moveDescription(render) {
		if (window.innerHeight > window.innerWidth || Lampa.Platform.is('mobile')) return;

		render.find('.items-line__title').each(function () {
			if (DETAILS_TITLES.indexOf($(this).text().trim().toLowerCase()) !== -1) {
				$(this).closest('.items-line__head').hide();
			}
		});

		var description = render.find('.full-descr__text');
		var body = render.find('.full-start-new__body');
		if (!description.length || !body.length || render.find('.custom-ghost-main').length) return;

		body.css('position', 'relative');

		var wrapper = $('<div class="custom-ghost-main"></div>');
		wrapper.css({
			position: 'absolute',
			top: '0',
			right: '0',
			width: '40vw',
			'z-index': '9999',
			'pointer-events': 'none',
			'box-sizing': 'border-box'
		});
		description.css({
			'line-height': '1.4',
			'font-size': '1.2em',
			color: '#ffffff',
			'text-shadow': '1px 1px 3px rgba(0,0,0,0.9)'
		});
		wrapper.append(description);
		body.append(wrapper);
	}

	// Затемнение фона, когда заголовок уехал за экран
	function watchScroll(render) {
		var title = render.find('.full-start-new__title')[0];
		if (!title || typeof IntersectionObserver === 'undefined') return noop;

		var observer = new IntersectionObserver(
			function (entries) {
				entries.forEach(function (entry) {
					render.find('.cardify-effects-overlay').toggleClass('cardify-scrolled', !entry.isIntersecting);
				});
			},
			{ threshold: 0 }
		);
		observer.observe(title);

		return function () {
			observer.disconnect();
		};
	}

	// Сразу дорисовать все ряды компонента (рекомендации, похожие и т.д.)
	function renderAllRows(component) {
		if (!component || !component.rows || !component.items || !component.scroll || !component.emit) return;

		var add = component.rows.slice(component.items.length);
		if (!add.length) return;

		component.fragment = document.createDocumentFragment();
		add.forEach(function (row) {
			component.emit('createAndAppend', row);
		});
		component.scroll.append(component.fragment);
		if (Lampa.Layer) Lampa.Layer.visible(component.scroll.render());
	}

	function decorateCard(e, render) {
		var bg = render.find('.full-start__background');
		bg.addClass('cardify__background');
		if (!render.find('.cardify-effects-overlay').length) bg.last().after('<div class="cardify-effects-overlay"></div>');

		if ((Lampa.Storage.field('cardify_ratings_position') || 'card') === 'corner') {
			var rateLine = render.find('.cardify__left .rate-fix');
			if (rateLine.length) rateLine.insertBefore(render.find('.cardify__right-box .full-start-new__rate-line'));
		}

		moveNextEpisode(render);
		var backdropPath = loadOriginalPoster(e, render);
		if (isOn('cardify_move_text')) moveDescription(render);
		var stopWatch = watchScroll(render);
		renderAllRows(e.object.activity.component);

		// Перебиваем fade-in фона ядром Lampa
		var fixOpacity = function () {
			render.find('.full-start__background').stop(true, true).css('opacity', '1');
		};
		fixOpacity();
		var t1 = setTimeout(fixOpacity, 300);
		var t2 = setTimeout(fixOpacity, 1000);

		return {
			backdropPath: backdropPath,
			cleanup: function () {
				clearTimeout(t1);
				clearTimeout(t2);
				stopWatch();
			}
		};
	}

	function isTvCard(e, movie) {
		if (e.object && e.object.method === 'tv') return true;
		if (e.object && e.object.method === 'movie') return false;
		if (e.data && e.data.tv && !e.data.movie) return true;
		return !!(movie && movie.name && !movie.title);
	}

	// Приоритет: фоны без языка (чистые) → на языке интерфейса → остальные по рейтингу
	function pickBackdrops(backdrops, lang, skipPath) {
		var noLang = [];
		var ownLang = [];
		var other = [];

		(backdrops || []).forEach(function (b) {
			if (!b || !b.file_path || b.file_path === skipPath) return;
			var l = b.iso_639_1;
			if (l === lang) ownLang.push(b);
			else if (!l || l === 'xx' || l === 'null') noLang.push(b);
			else other.push(b);
		});

		var list = noLang;
		if (list.length < 3) list = list.concat(ownLang);
		if (list.length < 3) {
			other.sort(function (a, b) {
				return (b.vote_average || 0) - (a.vote_average || 0);
			});
			list = list.concat(other);
		}
		return list.slice(0, 15);
	}

	// ---------------------------------------------------------------------------
	// Карточка: фон (трейлер / слайдшоу) и его жизненный цикл
	// ---------------------------------------------------------------------------

	var cards = [];
	var playerOpenFlag = false;

	function playerIsOpen() {
		if (playerOpenFlag) return true;
		if (Lampa.Player && typeof Lampa.Player.opened === 'function') {
			try {
				return !!Lampa.Player.opened();
			} catch (e) {}
		}
		return false;
	}

	function syncCards() {
		cards.slice().forEach(function (c) {
			c.sync();
		});
	}

	function createCard(e) {
		var activity = e.object.activity;
		var render = activity.render();
		var movie = (e.data && (e.data.movie || e.data.tv)) || e.object.card || null;
		var isTv = isTvCard(e, movie);

		var destroyed = false;
		var trailer = null;
		var abortSearch = noop;
		var abortStream = noop;
		var slideshowStarted = false;
		var slideshowTimer = null;
		var fadeTimer = null;

		var decor = decorateCard(e, render);

		function backgrounds() {
			return render.find('.full-start__background');
		}

		function wantPlay() {
			if (destroyed) return false;
			var active = Lampa.Activity.active();
			return !!active && active.activity === activity && !playerIsOpen();
		}

		function sync() {
			if (!trailer) return;
			if (wantPlay()) trailer.play();
			else trailer.pause();
		}

		// --- слайдшоу ---

		function crossfade($current, url) {
			var $next = $current.clone();
			$next.attr('src', url).css({
				opacity: '0',
				transition: 'opacity 1.5s ease-in-out',
				transform: 'translateZ(0)'
			});

			var $overlay = render.find('.cardify-effects-overlay');
			if ($overlay.length) $overlay.before($next);
			else $current.after($next);

			void $next[0].offsetHeight; // reflow, чтобы transition сработал

			$next.css('opacity', '1');
			$current.css({ transition: 'opacity 1.5s ease-in-out', opacity: '0' });

			clearTimeout(fadeTimer);
			fadeTimer = setTimeout(function () {
				if (destroyed) return;
				backgrounds().not($next).remove();
			}, 1550);
		}

		function runSlideshow(list) {
			var index = -1;
			var quality = Lampa.Storage.field('cardify_slideshow_quality') || 'w1280';
			var duration = parseInt(Lampa.Storage.field('cardify_slideshow_duration'), 10) || 8000;

			slideshowTimer = setInterval(function () {
				if (!wantPlay()) return; // не грузим картинки, пока смотрят фильм или открыта другая карточка

				var $current = backgrounds().last();
				if (!$current.length) return;

				index = (index + 1) % list.length;
				var url = Lampa.TMDB.image('t/p/' + quality + list[index].file_path);

				var img = new Image();
				img.onload = function () {
					if (!destroyed) crossfade($current, url);
				};
				img.onerror = noop;
				img.src = url;
			}, duration);
		}

		function startSlideshow() {
			if (slideshowStarted || destroyed || !movie || !movie.id) return;
			if (!Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources.tmdb) return;
			slideshowStarted = true;

			var lang = contentLang();
			Lampa.Api.sources.tmdb.get(
				(isTv ? 'tv' : 'movie') + '/' + movie.id + '/images?include_image_language=' + lang + ',xx,null,en',
				{},
				function (data) {
					if (destroyed) return;
					var list = pickBackdrops(data && data.backdrops, lang, decor.backdropPath);
					if (list.length) runSlideshow(list);
				},
				noop
			);
		}

		function fallback() {
			if (destroyed) return;
			if (isOn('cardify_run_slideshow')) startSlideshow();
		}

		// --- трейлер ---

		function mountTrailer(url, onFail) {
			trailer = createBackgroundVideo(url, {
				onStart: function () {
					backgrounds().addClass('nodisplay');
				},
				onError: function (wasStarted) {
					trailer = null;
					backgrounds().removeClass('nodisplay');
					onFail(wasStarted);
				}
			});

			var $overlay = render.find('.cardify-effects-overlay');
			if ($overlay.length) $overlay.before(trailer.render());
			else render.find('.activity__body').prepend(trailer.render());

			sync();
		}

		function tryCandidates(list, i) {
			if (destroyed) return;
			if (i >= list.length) return fallback();

			var item = list[i] || {};
			var id = rutubeId(item.video_url || item.embed_url || item.url);
			if (!id) return tryCandidates(list, i + 1);

			abortStream = resolveStream(
				id,
				function (streamUrl) {
					if (destroyed) return;
					mountTrailer(streamUrl, function (wasStarted) {
						// упал посреди показа — на слайдшоу; не стартовал — следующий ролик
						if (wasStarted) fallback();
						else tryCandidates(list, i + 1);
					});
				},
				function () {
					tryCandidates(list, i + 1);
				}
			);
		}

		function startTrailer() {
			abortSearch = searchTrailers(
				movie,
				isTv,
				function (list) {
					tryCandidates(list.slice(0, MAX_TRAILER_CANDIDATES), 0);
				},
				fallback
			);
		}

		function destroy() {
			if (destroyed) return;
			destroyed = true;
			abortSearch();
			abortStream();
			if (trailer) trailer.destroy();
			trailer = null;
			clearInterval(slideshowTimer);
			clearTimeout(fadeTimer);
			decor.cleanup();

			var i = cards.indexOf(card);
			if (i >= 0) cards.splice(i, 1);
		}

		var card = { activity: activity, sync: sync, destroy: destroy };

		if (movie && isOn('cardify_trailers_bg')) startTrailer();
		else if (movie && isOn('cardify_run_slideshow')) startSlideshow();

		return card;
	}

	// ---------------------------------------------------------------------------
	// Переводы, шаблон, стили, настройки
	// ---------------------------------------------------------------------------

	function addTranslations() {
		Lampa.Lang.add({
			cardify_trailers: { ru: 'Трейлеры', uk: 'Трейлери', en: 'Trailers' },
			cardify_s_trailer: { ru: 'Фоновый трейлер (RUTUBE)', uk: 'Фоновий трейлер (RUTUBE)', en: 'Background trailer (RUTUBE)' },
			cardify_s_trailer_descr: {
				ru: 'Беззвучно проигрывать трейлер с RUTUBE на фоне вместо картинок',
				uk: 'Беззвучно відтворювати трейлер з RUTUBE на фоні замість зображень',
				en: 'Play a muted RUTUBE trailer in the background instead of images'
			},
			cardify_s_blur: { ru: 'Размытие фонового видео', uk: 'Розмиття фонового відео', en: 'Background video blur' },
			cardify_s_blur_descr: { ru: 'Эффект размытия (blur) для фонового трейлера', uk: 'Ефект розмиття (blur) для фонового трейлера', en: 'Blur effect for the background trailer' },
			cardify_s_zoom: { ru: 'Масштаб видео', uk: 'Масштабування відео', en: 'Video zoom' },
			cardify_s_zoom_descr: { ru: 'Увеличение видео, чтобы скрыть чёрные полосы', uk: 'Збільшення відео для приховування чорних смуг', en: 'Zoom in to hide black bars' },
			cardify_s_off: { ru: 'Выключено', uk: 'Вимкнено', en: 'Off' },
			cardify_s_slideshow: { ru: 'Слайдшоу картинок', uk: 'Слайдшоу зображень', en: 'Image slideshow' },
			cardify_s_slideshow_descr: {
				ru: 'Плавная смена фонов из TMDB, если фоновый трейлер выключен или не найден',
				uk: 'Плавна зміна фонів з TMDB, якщо фоновий трейлер вимкнено або не знайдено',
				en: 'Smoothly rotate TMDB backdrops when the background trailer is off or not found'
			},
			cardify_s_quality: { ru: 'Качество фоновых картинок', uk: 'Якість фонових зображень', en: 'Backdrop quality' },
			cardify_s_q_std: { ru: 'Стандартное', uk: 'Стандартна', en: 'Standard' },
			cardify_s_q_high: { ru: 'Высокое', uk: 'Висока', en: 'High' },
			cardify_s_q_orig: { ru: 'Оригинал', uk: 'Оригінал', en: 'Original' },
			cardify_s_duration: { ru: 'Интервал смены картинок', uk: 'Інтервал зміни зображень', en: 'Slideshow interval' },
			cardify_s_sec: { ru: 'сек', uk: 'сек', en: 'sec' },
			cardify_s_move_text: { ru: 'Перенос описания', uk: 'Перенесення опису', en: 'Move description' },
			cardify_s_move_text_descr: {
				ru: 'Компактный вид: описание в правом верхнем углу (для широких экранов)',
				uk: 'Компактний вигляд: опис у правому верхньому куті (для широких екранів)',
				en: 'Compact view: description in the top right corner (wide screens)'
			},
			cardify_s_status: { ru: 'Показывать статус', uk: 'Показувати статус', en: 'Show status' },
			cardify_s_rating: { ru: 'Показывать рейтинги', uk: 'Показувати рейтинги', en: 'Show ratings' },
			cardify_s_rating_pos: { ru: 'Расположение рейтингов', uk: 'Розташування рейтингів', en: 'Ratings position' },
			cardify_s_rating_card: { ru: 'В карточке', uk: 'У картці', en: 'In the card' },
			cardify_s_rating_corner: { ru: 'В правом нижнем углу', uk: 'У правому нижньому куті', en: 'Bottom right corner' },
			cardify_s_pg: { ru: 'Показывать возрастной рейтинг', uk: 'Показувати віковий рейтинг', en: 'Show age rating' }
		});
	}

	var TRAILER_CSS =
		'.cardify-trailer{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;overflow:hidden;pointer-events:none;background:#000;opacity:0;-webkit-transition:opacity .6s;transition:opacity .6s;will-change:opacity}\n' +
		'.cardify-trailer.display{opacity:1}\n' +
		'.cardify-trailer__video{position:absolute;top:0;left:0;width:100%;height:100%;-o-object-fit:cover;object-fit:cover;-webkit-transition:-webkit-transform .3s;transition:transform .3s}\n';

	function addTemplates() {
		Lampa.Template.add(
			'full_start_new',
			'<div class="full-start-new cardify">\n        <div class="full-start-new__body">\n            <div class="full-start-new__left hide">\n                <div class="full-start-new__poster">\n                    <img class="full-start-new__img full--poster" />\n                </div>\n            </div>\n\n            <div class="full-start-new__right">\n                \n                <div class="cardify__left">\n                    <div class="full-start-new__head"></div>\n                    <div class="full-start-new__title">{title}</div>\n\n                    <div class="full-start-new__rate-line rate-fix">\n                        <div class="full-start__rate rate--tmdb"><div>{rating}</div><div class="source--name">TMDB</div></div>\n                        <div class="full-start__rate rate--imdb hide"><div></div><div>IMDB</div></div>\n                        <div class="full-start__rate rate--kp hide"><div></div><div>KP</div></div>\n                        <div class="full-start__rate rate--cub hide"><div></div><div>CUB</div></div>\n                    </div>\n\n                    <div class="cardify__details">\n                        <div class="full-start-new__details"></div>\n                    </div>\n\n                    <div class="full-start-new__buttons">\n                        <div class="full-start__button selector button--play">\n                            <svg width="28" height="29" viewBox="0 0 28 29" fill="none" xmlns="http://www.w3.org/2000/svg">\n                                <circle cx="14" cy="14.5" r="13" stroke="currentColor" stroke-width="2.7"/>\n                                <path d="M18.0739 13.634C18.7406 14.0189 18.7406 14.9811 18.0739 15.366L11.751 19.0166C11.0843 19.4015 10.251 18.9204 10.251 18.1506L10.251 10.8494C10.251 10.0796 11.0843 9.5985 11.751 9.9834L18.0739 13.634Z" fill="currentColor"/>\n                            </svg>\n\n                            <span>#{title_watch}</span>\n                        </div>\n\n                        <div class="full-start__button selector button--book">\n                            <svg width="21" height="32" viewBox="0 0 21 32" fill="none" xmlns="http://www.w3.org/2000/svg">\n                            <path d="M2 1.5H19C19.2761 1.5 19.5 1.72386 19.5 2V27.9618C19.5 28.3756 19.0261 28.6103 18.697 28.3595L12.6212 23.7303C11.3682 22.7757 9.63183 22.7757 8.37885 23.7303L2.30302 28.3595C1.9739 28.6103 1.5 28.3756 1.5 27.9618V2C1.5 1.72386 1.72386 1.5 2 1.5Z" stroke="currentColor" stroke-width="2.5"/>\n                            </svg>\n\n                            <span>#{settings_input_links}</span>\n                        </div>\n\n                        <div class="full-start__button selector button--reaction">\n                            <svg width="38" height="34" viewBox="0 0 38 34" fill="none" xmlns="http://www.w3.org/2000/svg">\n                                <path d="M37.208 10.9742C37.1364 10.8013 37.0314 10.6441 36.899 10.5117C36.7666 10.3794 36.6095 10.2744 36.4365 10.2028L12.0658 0.108375C11.7166 -0.0361828 11.3242 -0.0361227 10.9749 0.108542C10.6257 0.253206 10.3482 0.530634 10.2034 0.879836L0.108666 25.2507C0.0369593 25.4236 3.37953e-05 25.609 2.3187e-08 25.7962C-3.37489e-05 25.9834 0.0368249 26.1688 0.108469 26.3418C0.180114 26.5147 0.28514 26.6719 0.417545 26.8042C0.54995 26.9366 0.707139 27.0416 0.880127 27.1131L17.2452 33.8917C17.5945 34.0361 17.9869 34.0361 18.3362 33.8917L29.6574 29.2017C29.8304 29.1301 29.9875 29.0251 30.1199 28.8928C30.2523 28.7604 30.3573 28.6032 30.4289 28.4303L37.2078 12.065C37.2795 11.8921 37.3164 11.7068 37.3164 11.5196C37.3165 11.3325 37.2796 11.1471 37.208 10.9742ZM20.425 29.9407L21.8784 26.4316L25.3873 27.885L20.425 29.9407ZM28.3407 26.0222L21.6524 23.252C21.3031 23.1075 20.9107 23.1076 20.5615 23.2523C20.2123 23.3969 19.9348 23.6743 19.79 24.0235L17.0194 30.7123L3.28783 25.0247L12.2918 3.28773L34.0286 12.2912L28.3407 26.0222Z" fill="currentColor"/>\n                                <path d="M25.3493 16.976L24.258 14.3423L16.959 17.3666L15.7196 14.375L13.0859 15.4659L15.4161 21.0916L25.3493 16.976Z" fill="currentColor"/>\n                            </svg>                \n\n                            <span>#{title_reactions}</span>\n                        </div>\n\n                        <div class="full-start__button selector button--subscribe hide">\n                            <svg width="25" height="30" viewBox="0 0 25 30" fill="none" xmlns="http://www.w3.org/2000/svg">\n                            <path d="M6.01892 24C6.27423 27.3562 9.07836 30 12.5 30C15.9216 30 18.7257 27.3562 18.981 24H15.9645C15.7219 25.6961 14.2632 27 12.5 27C10.7367 27 9.27804 25.6961 9.03542 24H6.01892Z" fill="currentColor"/>\n                            <path d="M3.81972 14.5957V10.2679C3.81972 5.41336 7.7181 1.5 12.5 1.5C17.2819 1.5 21.1803 5.41336 21.1803 10.2679V14.5957C21.1803 15.8462 21.5399 17.0709 22.2168 18.1213L23.0727 19.4494C24.2077 21.2106 22.9392 23.5 20.9098 23.5H4.09021C2.06084 23.5 0.792282 21.2106 1.9273 19.4494L2.78317 18.1213C3.46012 17.0709 3.81972 15.8462 3.81972 14.5957Z" stroke="currentColor" stroke-width="2.5"/>\n                            </svg>\n\n                            <span>#{title_subscribe}</span>\n                        </div>\n\n                        <div class="full-start__button selector button--options">\n                            <svg width="38" height="10" viewBox="0 0 38 10" fill="none" xmlns="http://www.w3.org/2000/svg">\n                                <circle cx="4.88968" cy="4.98563" r="4.75394" fill="currentColor"/>\n                                <circle cx="18.9746" cy="4.98563" r="4.75394" fill="currentColor"/>\n                                <circle cx="33.0596" cy="4.98563" r="4.75394" fill="currentColor"/>\n                            </svg>\n                        </div>\n                    </div>\n                </div>\n\n                <div class="cardify__right-box">\n                    <div class="full-start-new__reactions selector">\n                        <div>#{reactions_none}</div>\n                    </div>\n\n                    <div class="full-start-new__rate-line">\n                        <div class="full-start__pg hide"></div>\n                        <div class="full-start__status hide"></div>\n                    </div>\n                </div>\n            </div>\n        </div>\n\n        <div class="hide buttons--container">\n            <div class="full-start__button view--torrent hide">\n                <svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 50 50" width="50px" height="50px">\n                    <path d="M25,2C12.317,2,2,12.317,2,25s10.317,23,23,23s23-10.317,23-23S37.683,2,25,2z M40.5,30.963c-3.1,0-4.9-2.4-4.9-2.4 S34.1,35,27,35c-1.4,0-3.6-0.837-3.6-0.837l4.17,9.643C26.727,43.92,25.874,44,25,44c-2.157,0-4.222-0.377-6.155-1.039L9.237,16.851 c0,0-0.7-1.2,0.4-1.5c1.1-0.3,5.4-1.2,5.4-1.2s1.475-0.494,1.8,0.5c0.5,1.3,4.063,11.112,4.063,11.112S22.6,29,27.4,29 c4.7,0,5.9-3.437,5.7-3.937c-1.2-3-4.993-11.862-4.993-11.862s-0.6-1.1,0.8-1.4c1.4-0.3,3.8-0.7,3.8-0.7s1.105-0.163,1.6,0.8 c0.738,1.437,5.193,11.262,5.193,11.262s1.1,2.9,3.3,2.9c0.464,0,0.834-0.046,1.152-0.104c-0.082,1.635-0.348,3.221-0.817,4.722 C42.541,30.867,41.756,30.963,40.5,30.963z" fill="currentColor"/>\n                </svg>\n\n                <span>#{full_torrents}</span>\n            </div>\n            <div class="full-start__button selector view--trailer">\n                <svg width="28" height="29" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\n                    <path d="M21.582 6.186c-.23-.86-.908-1.538-1.768-1.768C18.254 4 12 4 12 4s-6.254 0-7.814.418c-.86.23-1.538.908-1.768 1.768C2 7.746 2 12 2 12s0 4.254.418 5.814c.23.86.908 1.538 1.768 1.768C5.746 20 12 20 12 20s6.254 0 7.814-.418c.86-.23 1.538-.908 1.768-1.768C22 16.254 22 12 22 12s0-4.254-.418-5.814zM9.75 15.021V8.979l6.5 3.021-6.5 3.021z" fill="currentColor"/>\n                </svg>\n                <span>#{cardify_trailers}</span>\n            </div>\n        </div>\n    </div>'
		);

		var style =
			"\n        <style>\n        .cardify{-webkit-transition:all .3s;-o-transition:all .3s;-moz-transition:all .3s;transition:all .3s}.cardify .full-start-new__body{height:80vh}.cardify .full-start-new__right{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:end;-webkit-align-items:flex-end;-moz-box-align:end;-ms-flex-align:end;align-items:flex-end}.cardify .full-start-new__title{text-shadow:0 0 .1em rgba(0,0,0,0.3)}.cardify__left{-webkit-box-flex:1;-webkit-flex-grow:1;-moz-box-flex:1;-ms-flex-positive:1;flex-grow:1}.cardify__right-box{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-moz-box-align:center;-ms-flex-align:center;align-items:center;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;position:relative}.cardify__details{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex}.cardify .full-start-new__reactions, .cardify .reaction__count {display:none !important}.cardify .full-start-new__rate-line.rate-fix{margin: 1em 0 1.7em 0}.full-start-new__details{margin:0 0 1.4em -0.3em;} .full-start-new__rate-line{margin:0;margin-left:3.5em}.cardify .full-start-new__rate-line>*:last-child{margin-right:0 !important}.cardify__background{left:0; will-change: opacity, transform; transform: translateZ(0);}.cardify__background.nodisplay{opacity:0 !important}.cardify.nodisplay{-webkit-transform:translate3d(0,50%,0);-moz-transform:translate3d(0,50%,0);transform:translate3d(0,50%,0);opacity:0}.head.nodisplay{-webkit-transform:translate3d(0,-100%,0);-moz-transform:translate3d(0,-100%,0);transform:translate3d(0,-100%,0)}body:not(.menu--open) .cardify__background{-webkit-mask-image:-webkit-gradient(linear,left top,left bottom,color-stop(50%,white),to(rgba(255,255,255,0)));-webkit-mask-image:-webkit-linear-gradient(top,white 50%,rgba(255,255,255,0) 100%);mask-image:-webkit-gradient(linear,left top,left bottom,color-stop(50%,white),to(rgba(255,255,255,0)));mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}\n.cardify__background{animation:none !important;-webkit-animation:none !important;transform:none !important;-webkit-transform:none !important;}\n.cardify-effects-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:0;background-color:transparent;background-image:linear-gradient(225deg,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0) 55%);background-repeat:no-repeat;background-size:100vw 100vh;transition:background-color 0.4s ease;}\n.cardify-effects-overlay.cardify-scrolled{background-color:rgba(0,0,0,0.5) !important;}\n.custom-ghost-main .full-descr__text{max-width:100% !important;width:100% !important;margin:0 !important;padding:0 !important;text-align:right !important;white-space:normal !important;display:block !important;}\n" +
			TRAILER_CSS +
			"body.cardify-hide-status .full-start__status { display: none !important; visibility: hidden !important; opacity: 0 !important; width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; font-size: 0 !important; }\n" +
			"body.cardify-hide-pg .full-start__pg { display: none !important; visibility: hidden !important; opacity: 0 !important; width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; font-size: 0 !important; }\n" +
			"body.cardify-hide-rating .full-start-new__rate-line.rate-fix { display: none !important; visibility: hidden !important; opacity: 0 !important; width: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; font-size: 0 !important; }\n" +
			"body.cardify-ratings-corner .cardify__right-box { align-items: center; }\n" +
			"body.cardify-ratings-corner .cardify__right-box .full-start-new__rate-line { margin: 0 !important; display: flex; align-items: center; }\n" +
			"body.cardify-ratings-corner .cardify__right-box > * { margin-left: 1.5em; }\n" +
			"body.cardify-ratings-corner .cardify__right-box > *:first-child { margin-left: 0; }\n" +
			'</style>';

		Lampa.Template.add('cardify_css', style);
		$('body').append(Lampa.Template.get('cardify_css', {}, true));
	}

	function updateVisibility() {
		var body = $('body');
		body.toggleClass('cardify-hide-status', isOff('cardify_show_status'));
		body.toggleClass('cardify-hide-pg', isOff('cardify_show_pg'));
		body.toggleClass('cardify-hide-rating', isOff('cardify_show_rating'));
		body.removeClass('cardify-ratings-card cardify-ratings-corner');
		body.addClass('cardify-ratings-' + (Lampa.Storage.field('cardify_ratings_position') || 'card'));
	}

	function addParam(param, name, description, extra) {
		var field = { name: t(name) };
		if (description) field.description = t(description);

		var conf = { component: 'cardify', param: param, field: field };
		if (extra) {
			for (var k in extra) conf[k] = extra[k];
		}
		Lampa.SettingsApi.addParam(conf);
	}

	function addSettings() {
		var off = t('cardify_s_off');
		var sec = ' ' + t('cardify_s_sec');

		Lampa.SettingsApi.addComponent({ component: 'cardify', icon: SETTINGS_ICON, name: 'Cardify' });

		addParam({ name: 'cardify_trailers_bg', type: 'trigger', default: false }, 'cardify_s_trailer', 'cardify_s_trailer_descr');

		addParam(
			{
				name: 'cardify_trailers_blur',
				type: 'select',
				values: { 0: off, 1: '1 px', 2: '2 px', 3: '3 px', 4: '4 px', 5: '5 px', 10: '10 px' },
				default: '0'
			},
			'cardify_s_blur',
			'cardify_s_blur_descr'
		);

		addParam(
			{
				name: 'cardify_trailers_zoom',
				type: 'select',
				values: { 0: off, 25: '+25%', 33: '+33%', 40: '+40%', 45: '+45%', 50: '+50%' },
				default: '0'
			},
			'cardify_s_zoom',
			'cardify_s_zoom_descr'
		);

		addParam({ name: 'cardify_run_slideshow', type: 'trigger', default: true }, 'cardify_s_slideshow', 'cardify_s_slideshow_descr');

		addParam(
			{
				name: 'cardify_slideshow_quality',
				type: 'select',
				values: {
					w780: t('cardify_s_q_std') + ' (w780)',
					w1280: t('cardify_s_q_high') + ' (w1280)',
					original: t('cardify_s_q_orig')
				},
				default: 'w1280'
			},
			'cardify_s_quality'
		);

		addParam(
			{
				name: 'cardify_slideshow_duration',
				type: 'select',
				values: { 5000: '5' + sec, 8000: '8' + sec, 10000: '10' + sec, 15000: '15' + sec },
				default: 8000
			},
			'cardify_s_duration'
		);

		addParam({ name: 'cardify_move_text', type: 'trigger', default: true }, 'cardify_s_move_text', 'cardify_s_move_text_descr');

		addParam({ name: 'cardify_show_status', type: 'trigger', default: true }, 'cardify_s_status');

		addParam({ name: 'cardify_show_rating', type: 'trigger', default: true }, 'cardify_s_rating', '', {
			onChange: function () {
				updateVisibility();
				Lampa.Settings.update();
			}
		});

		addParam(
			{
				name: 'cardify_ratings_position',
				type: 'select',
				values: { card: t('cardify_s_rating_card'), corner: t('cardify_s_rating_corner') },
				default: 'card'
			},
			'cardify_s_rating_pos',
			'',
			{
				onChange: function (value) {
					Lampa.Storage.set('cardify_ratings_position', value);
					updateVisibility();
				},
				onRender: function (item) {
					if (isOff('cardify_show_rating')) item.hide();
				}
			}
		);

		addParam({ name: 'cardify_show_pg', type: 'trigger', default: true }, 'cardify_s_pg');
	}

	// ---------------------------------------------------------------------------
	// Запуск
	// ---------------------------------------------------------------------------

	function startPlugin() {
		if (!Lampa.Platform.screen('tv')) return console.log('Cardify', 'no tv');

		addTranslations();
		addTemplates();
		addSettings();
		updateVisibility();

		Lampa.Storage.listener.follow('change', function (e) {
			if (/^cardify_(show_status|show_pg|show_rating|ratings_position)$/.test(e.name)) updateVisibility();
		});

		Lampa.Listener.follow('full', function (e) {
			if (e.type !== 'complite' || !e.object || !e.object.activity) return;
			cards.slice().forEach(function (c) {
				if (c.activity === e.object.activity) c.destroy();
			});
			cards.push(createCard(e));
		});

		Lampa.Listener.follow('activity', function (e) {
			if (e.type === 'destroy' && e.object) {
				cards.slice().forEach(function (c) {
					if (c.activity === e.object.activity) c.destroy();
				});
			}
			if (e.type === 'start') setTimeout(syncCards, 0);
		});

		if (Lampa.Controller && Lampa.Controller.listener) {
			Lampa.Controller.listener.follow('toggle', function () {
				setTimeout(syncCards, 0);
			});
		}

		if (Lampa.Player && Lampa.Player.listener) {
			Lampa.Player.listener.follow('start', function () {
				playerOpenFlag = true;
				syncCards();
			});
			Lampa.Player.listener.follow('destroy', function () {
				playerOpenFlag = false;
				setTimeout(syncCards, 0);
			});
		}
	}

	if (window.appready) startPlugin();
	else {
		Lampa.Listener.follow('app', function (e) {
			if (e.type === 'ready') startPlugin();
		});
	}
})();
